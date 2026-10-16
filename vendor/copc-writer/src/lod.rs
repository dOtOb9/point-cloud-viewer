//! Octree LOD construction that carries point records (ADR-0019).
//!
//! Before ADR-0019 the builder partitioned lists of point *indices* and
//! fetched every point from the spill through its index. Once the spill was
//! larger than RAM, every fetch cost a disk page read (about 13x the spill
//! size was read during node compression). Now every pass over the data is
//! sequential, and the data that is passed on is the point record itself.
//!
//! The work is split into tasks. A task is a *run*: a file of fixed-width
//! point records that belong to one octree node and everything below it.
//!
//! - **Too big for the memory budget**: `expand_run` partitions the run into
//!   8 child runs (one sequential read, one sequential write). The points the
//!   parent node keeps are collected in memory (at most `max_points_per_node`
//!   records) and returned as the node's records. The run is deleted as soon
//!   as it has been partitioned. The child runs are new tasks.
//! - **Fits the budget**: the run is loaded and `build_in_memory` builds the
//!   rest of the subtree with plain `Vec<u8>` buffers, node by node.
//!
//! `node_pipeline.rs` runs the tasks (on one thread or on several) and
//! compresses the nodes.
//!
//! Which points a parent keeps is the rule decided in M4-16 and is the same
//! on disk and in memory: each child octant gives `k` of its `n` points,
//! taken evenly across the whole child run (the `i`-th point is taken when
//! `(i+1)*k/n > i*k/n`), and the children keep the rest in input order.
//! `lod_reference.rs` holds the old index-based builder; a test checks that
//! both give exactly the same points in every node.
//!
//! The per-octant counts of a run are needed before it can be partitioned (to
//! decide how many points each child gives to the parent). They are not read
//! from the run: the partition that wrote a child run also counted the points
//! going into it, by the child's own 8 octants (`RunTask::counts`). Only the
//! root run, which no partition wrote, is counted with an extra pass.

use std::io::{BufWriter, Read, Write};

use copc_core::{Bounds, CancelCheck, Error, Result, VoxelKey};

use crate::record::RecordFormat;
use crate::scratch::{ScratchFs, ScratchReader, ScratchWriter};
use crate::CANCEL_POLL_STRIDE;

/// Output buffer per child run file while partitioning.
const RUN_WRITE_BUFFER_BYTES: usize = 1024 * 1024;
/// Size of one sequential read from a run.
const RUN_READ_BLOCK_BYTES: usize = 1024 * 1024;
/// Hard cap on octree subdivision depth: deeper voxel keys would overflow the
/// i32 key coordinates (level 30 keys reach 2^30). The layered LAZ compressor
/// buffers an entire COPC chunk (one octree node) in memory before flushing,
/// so nodes must keep subdividing until they fit `max_points_per_node`.
/// Pathological coincident inputs that cannot fit by this depth are rejected
/// rather than producing an oversized chunk.
const MAX_OCTREE_DEPTH: u32 = 30;

/// A file of `count` fixed-width point records, starting at byte 0, in input
/// order. Dropping a `Run` deletes the file (the `ScratchReader` owns it).
pub(crate) struct Run {
    pub(crate) reader: Box<dyn ScratchReader>,
    pub(crate) count: usize,
}

/// A run that still has to be turned into nodes.
pub(crate) struct RunTask {
    pub(crate) key: VoxelKey,
    pub(crate) bounds: Bounds,
    pub(crate) run: Run,
    /// How many of the run's points lie in each of the 8 octants of `bounds`.
    /// `None` for the root run, which is counted when it is partitioned.
    pub(crate) counts: Option<[usize; 8]>,
}

/// What the builder needs to know about the records.
#[derive(Clone, Copy, Debug)]
pub(crate) struct LodParams {
    pub(crate) max_points_per_node: usize,
    /// How the records are laid out (x, y, z first, then the LAS body).
    pub(crate) format: RecordFormat,
    /// A run of at most this many bytes is finished in memory.
    pub(crate) in_memory_run_bytes: u64,
}

impl LodParams {
    pub(crate) fn validate(&self) -> Result<()> {
        if self.max_points_per_node == 0 {
            return Err(Error::InvalidInput(
                "max_points_per_node must be greater than zero".into(),
            ));
        }
        Ok(())
    }

    fn fits_in_memory(&self, run: &Run) -> bool {
        let run_bytes = (run.count as u64).saturating_mul(self.format.width() as u64);
        run.count <= self.max_points_per_node || run_bytes <= self.in_memory_run_bytes
    }
}

/// Result of `expand_run`.
pub(crate) enum Expanded {
    /// The run fits the memory budget; the caller loads it (`read_run`) and
    /// calls `build_in_memory`.
    FitsInMemory(RunTask),
    /// The run was partitioned on disk (and deleted).
    Split {
        /// The node these records belong to.
        key: VoxelKey,
        /// Records of the node `key` itself.
        node_records: Vec<u8>,
        /// The child runs, in octant order.
        children: Vec<RunTask>,
    },
}

/// Partitions `task.run` on disk unless it fits the memory budget.
pub(crate) fn expand_run(
    task: RunTask,
    params: &LodParams,
    cancel: &(dyn CancelCheck + Sync),
    fs: &dyn ScratchFs,
) -> Result<Expanded> {
    cancel.check()?;
    if params.fits_in_memory(&task.run) {
        return Ok(Expanded::FitsInMemory(task));
    }
    check_depth(task.key, task.run.count, params.max_points_per_node)?;
    let RunTask {
        key,
        bounds,
        run,
        counts,
    } = task;
    let (node_records, split) = partition(&run, bounds, counts, params, cancel, fs)?;
    // The points sit in the node and in the child runs now: free the disk
    // space before going deeper.
    drop(run);
    let mut children = Vec::new();
    for (octant, child) in split.into_iter().enumerate() {
        let Some((run, counts)) = child else {
            continue;
        };
        children.push(RunTask {
            key: key.child(octant as u8)?,
            bounds: bounds.octant(octant as u8),
            run,
            counts: Some(counts),
        });
    }
    Ok(Expanded::Split {
        key,
        node_records,
        children,
    })
}

/// A child run and the counts of its points by the child's own octants.
type ChildRun = Option<(Run, [usize; 8])>;

/// Splits `run` into the node's records and 8 child runs with one sequential
/// pass (plus a counting pass when `counts` is not known yet).
fn partition(
    run: &Run,
    bounds: Bounds,
    counts: Option<[usize; 8]>,
    params: &LodParams,
    cancel: &(dyn CancelCheck + Sync),
    fs: &dyn ScratchFs,
) -> Result<(Vec<u8>, [ChildRun; 8])> {
    let format = params.format;
    let width = format.width();
    let center = bounds.center();

    let counts = match counts {
        Some(counts) => counts,
        None => count_octants(run, center, format, cancel)?,
    };
    let total: usize = counts.iter().sum();
    if total != run.count {
        return Err(Error::InvalidData(format!(
            "LOD run holds {} points but its octant counts add up to {total}",
            run.count
        )));
    }

    // The node's share of each child is decided from the counts alone.
    let selected_counts = decide_selected_counts(&counts, params.max_points_per_node);
    let mut pickers: [Picker; 8] =
        std::array::from_fn(|o| Picker::new(selected_counts[o], counts[o]));
    let mut node_parts: [Vec<u8>; 8] =
        std::array::from_fn(|o| Vec::with_capacity(selected_counts[o] * width));
    let child_centers: [(f64, f64, f64); 8] =
        std::array::from_fn(|o| bounds.octant(o as u8).center());
    // For every child run: how its points fall into the child's 8 octants.
    let mut child_counts = [[0usize; 8]; 8];
    let mut writers: [Option<BufWriter<Box<dyn ScratchWriter>>>; 8] = std::array::from_fn(|_| None);
    for octant in 0..8 {
        if selected_counts[octant] < counts[octant] {
            writers[octant] = Some(BufWriter::with_capacity(
                RUN_WRITE_BUFFER_BYTES,
                fs.create_temp("run")?,
            ));
        }
    }

    let mut blocks = RunBlocks::open(run, width)?;
    while let Some(block) = blocks.next_block()? {
        cancel.check()?;
        for record in block.chunks_exact(width) {
            let (x, y, z) = format.xyz(record);
            let octant = child_octant(center, x, y, z);
            if pickers[octant].pick_next() {
                node_parts[octant].extend_from_slice(record);
            } else if let Some(writer) = writers[octant].as_mut() {
                writer
                    .write_all(record)
                    .map_err(|e| Error::io("write LOD run record", e))?;
                child_counts[octant][child_octant(child_centers[octant], x, y, z)] += 1;
            }
        }
    }

    // The counts decided who goes where; a run that does not match them would
    // lose points silently, so check it.
    for (octant, picker) in pickers.iter().enumerate() {
        if picker.seen != counts[octant] as u64 {
            return Err(Error::InvalidData(format!(
                "LOD run has {} points in octant {octant}, expected {}",
                picker.seen, counts[octant]
            )));
        }
    }

    let mut children: [ChildRun; 8] = std::array::from_fn(|_| None);
    for octant in 0..8 {
        let Some(writer) = writers[octant].take() else {
            continue;
        };
        let written: usize = child_counts[octant].iter().sum();
        let boxed = writer
            .into_inner()
            .map_err(|e| Error::io("flush LOD run", e.into_error()))?;
        children[octant] = Some((
            Run {
                reader: boxed.finish_temp()?,
                count: written,
            },
            child_counts[octant],
        ));
    }
    Ok((node_parts.concat(), children))
}

/// One sequential pass that counts the points of `run` per octant.
fn count_octants(
    run: &Run,
    center: (f64, f64, f64),
    format: RecordFormat,
    cancel: &(dyn CancelCheck + Sync),
) -> Result<[usize; 8]> {
    let mut counts = [0usize; 8];
    let width = format.width();
    let mut blocks = RunBlocks::open(run, width)?;
    while let Some(block) = blocks.next_block()? {
        cancel.check()?;
        for record in block.chunks_exact(width) {
            counts[record_octant(center, format, record)] += 1;
        }
    }
    Ok(counts)
}

/// Builds the subtree below `key` from `records` (all in memory) and reports
/// every node to `emit`, node first and then children in octant order. Frees
/// each buffer as soon as its points have been distributed, so the peak is
/// about twice `records` at the top split and less below.
pub(crate) fn build_in_memory(
    key: VoxelKey,
    bounds: Bounds,
    records: Vec<u8>,
    params: &LodParams,
    cancel: &(dyn CancelCheck + Sync),
    emit: &mut dyn FnMut(VoxelKey, Vec<u8>) -> Result<()>,
) -> Result<()> {
    let format = params.format;
    let width = format.width();
    let count = records.len() / width;
    if count == 0 {
        return Ok(());
    }
    if count <= params.max_points_per_node {
        return emit(key, records);
    }
    check_depth(key, count, params.max_points_per_node)?;
    cancel.check()?;

    let center = bounds.center();
    let mut counts = [0usize; 8];
    let mut octants: Vec<u8> = Vec::with_capacity(count);
    for (i, record) in records.chunks_exact(width).enumerate() {
        if i.is_multiple_of(CANCEL_POLL_STRIDE) {
            cancel.check()?;
        }
        let octant = record_octant(center, format, record);
        octants.push(octant as u8);
        counts[octant] += 1;
    }

    let selected_counts = decide_selected_counts(&counts, params.max_points_per_node);
    let mut pickers: [Picker; 8] =
        std::array::from_fn(|o| Picker::new(selected_counts[o], counts[o]));
    let mut parent_parts: [Vec<u8>; 8] =
        std::array::from_fn(|o| Vec::with_capacity(selected_counts[o] * width));
    let mut children: [Vec<u8>; 8] =
        std::array::from_fn(|o| Vec::with_capacity((counts[o] - selected_counts[o]) * width));
    for (record, &octant) in records.chunks_exact(width).zip(&octants) {
        let octant = usize::from(octant);
        if pickers[octant].pick_next() {
            parent_parts[octant].extend_from_slice(record);
        } else {
            children[octant].extend_from_slice(record);
        }
    }
    drop(octants);
    drop(records);

    emit(key, parent_parts.concat())?;
    drop(parent_parts);
    for (octant, child) in children.iter_mut().enumerate() {
        let child_records = std::mem::take(child);
        if child_records.is_empty() {
            continue;
        }
        build_in_memory(
            key.child(octant as u8)?,
            bounds.octant(octant as u8),
            child_records,
            params,
            cancel,
            emit,
        )?;
    }
    Ok(())
}

/// Reads a whole run into memory. The caller has checked that it fits.
pub(crate) fn read_run(run: &Run, record_width: usize) -> Result<Vec<u8>> {
    let len = run
        .count
        .checked_mul(record_width)
        .ok_or_else(|| Error::InvalidInput("LOD run size overflows usize".into()))?;
    let mut records = vec![0u8; len];
    let mut stream = run.reader.open_at(0)?;
    // In pieces, so that no single read asks for the whole run (the OPFS
    // reader of the Web build copies each request through a buffer).
    for piece in records.chunks_mut(RUN_READ_BLOCK_BYTES) {
        stream
            .read_exact(piece)
            .map_err(|e| Error::io("read LOD run", e))?;
    }
    Ok(records)
}

fn check_depth(key: VoxelKey, count: usize, max_points_per_node: usize) -> Result<()> {
    if key.level as u32 >= MAX_OCTREE_DEPTH {
        return Err(Error::InvalidInput(format!(
            "octree node {key:?} still contains {count} points at the maximum depth; increase max_points_per_node above {max_points_per_node}"
        )));
    }
    Ok(())
}

/// Sequential reader over a run, one block of whole records at a time.
struct RunBlocks {
    stream: Box<dyn Read + Send>,
    buffer: Vec<u8>,
    remaining: usize,
    width: usize,
}

impl RunBlocks {
    fn open(run: &Run, width: usize) -> Result<Self> {
        let block_records = (RUN_READ_BLOCK_BYTES / width).max(1);
        Ok(Self {
            stream: run.reader.open_at(0)?,
            buffer: vec![0u8; block_records * width],
            remaining: run.count,
            width,
        })
    }

    fn next_block(&mut self) -> Result<Option<&[u8]>> {
        if self.remaining == 0 {
            return Ok(None);
        }
        let records = self.remaining.min(self.buffer.len() / self.width);
        let bytes = records * self.width;
        self.stream
            .read_exact(&mut self.buffer[..bytes])
            .map_err(|e| Error::io("read LOD run", e))?;
        self.remaining -= records;
        Ok(Some(&self.buffer[..bytes]))
    }
}

fn record_octant(center: (f64, f64, f64), format: RecordFormat, record: &[u8]) -> usize {
    let (x, y, z) = format.xyz(record);
    child_octant(center, x, y, z)
}

pub(crate) fn child_octant(center: (f64, f64, f64), x: f64, y: f64, z: f64) -> usize {
    usize::from(x >= center.0)
        | (usize::from(y >= center.1) << 1)
        | (usize::from(z >= center.2) << 2)
}

/// How many points each child gives to the parent: one point per child in
/// turn (round robin) until the parent holds `max_points_per_node` or the
/// children have none left. Only counts are used, no data is read.
pub(crate) fn decide_selected_counts(
    counts: &[usize; 8],
    max_points_per_node: usize,
) -> [usize; 8] {
    let mut selected_counts = [0usize; 8];
    let mut selected_total = 0usize;
    while selected_total < max_points_per_node {
        let mut progressed = false;
        for octant in 0..8 {
            if selected_counts[octant] >= counts[octant] {
                continue;
            }
            selected_counts[octant] += 1;
            selected_total += 1;
            progressed = true;
            if selected_total == max_points_per_node {
                break;
            }
        }
        if !progressed {
            break;
        }
    }
    selected_counts
}

/// Picks `k` of `n` points evenly: the `i`-th point (0-based) goes to the
/// parent when `(i+1)*k/n > i*k/n`. Exactly `k` of `n` calls return true.
struct Picker {
    k: u64,
    n: u64,
    seen: u64,
}

impl Picker {
    fn new(k: usize, n: usize) -> Self {
        Self {
            k: k as u64,
            n: n as u64,
            seen: 0,
        }
    }

    fn pick_next(&mut self) -> bool {
        let i = self.seen;
        self.seen += 1;
        // `n` is at least 1 whenever this is called (the octant has a point).
        (i + 1) * self.k / self.n > i * self.k / self.n
    }
}

pub(crate) fn cube_from_bounds(bounds: &Bounds) -> ((f64, f64, f64), f64) {
    let dx = bounds.max.0 - bounds.min.0;
    let dy = bounds.max.1 - bounds.min.1;
    let dz = bounds.max.2 - bounds.min.2;
    let center = (
        bounds.min.0 + dx * 0.5,
        bounds.min.1 + dy * 0.5,
        bounds.min.2 + dz * 0.5,
    );
    let halfsize = (dx.max(dy).max(dz) * 0.5).max(1e-6);
    (center, halfsize)
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::record::LasTransform;
    use copc_core::{LasPointRecord, NeverCancel, StreamingLayout};

    use crate::lod_reference::reference_nodes;
    use crate::scratch::MemoryScratchFs;
    #[cfg(feature = "native-fs")]
    use crate::scratch::NativeScratchFs;
    use crate::source::{CopcPointFields, CopcPointSource};
    use crate::spill::SpillWriter;

    /// Index-based source for the reference builder.
    struct VecSource {
        points: Vec<LasPointRecord>,
    }

    impl CopcPointSource for VecSource {
        fn len(&self) -> usize {
            self.points.len()
        }

        fn xyz(&self, index: usize) -> Result<(f64, f64, f64)> {
            let p = &self.points[index];
            Ok((p.x, p.y, p.z))
        }

        fn fields_into(&self, _index: usize, _out: &mut CopcPointFields) -> Result<()> {
            Err(Error::Unsupported("not used by these tests".into()))
        }
    }

    fn layout() -> StreamingLayout {
        StreamingLayout {
            point_format: 6,
            has_gps: true,
            has_color: false,
            has_nir: false,
            has_waveform: false,
            extra_bytes: 0,
            extra_bytes_descriptors: Vec::new(),
        }
    }

    /// A point whose `gps_time` is its input index, so a record can be traced
    /// back to the reference builder's index.
    fn point(index: usize, x: f64, y: f64, z: f64) -> LasPointRecord {
        LasPointRecord {
            x,
            y,
            z,
            return_number: 1,
            number_of_returns: 1,
            gps_time: index as f64,
            ..LasPointRecord::default()
        }
    }

    fn bounds_of(points: &[LasPointRecord]) -> Bounds {
        points.iter().fold(
            Bounds::point(points[0].x, points[0].y, points[0].z),
            |mut bounds, p| {
                bounds.extend(p.x, p.y, p.z);
                bounds
            },
        )
    }

    /// Writes `points` to a spill and returns the root run plus the record width.
    fn root_run(
        points: &[LasPointRecord],
        transform: Option<LasTransform>,
        fs: &dyn ScratchFs,
    ) -> (Run, RecordFormat) {
        let mut writer = SpillWriter::create(fs, layout(), transform).unwrap();
        for p in points {
            writer.push(p).unwrap();
        }
        let reader = writer.finalize().unwrap();
        let format = reader.format();
        (reader.into_run(), format)
    }

    /// The ids (`gps_time`) of the points in `records`. The GPS time is the
    /// first f64 of the record body (after the 10 bytes before it).
    fn ids(records: &[u8], format: RecordFormat) -> Vec<f64> {
        records
            .chunks_exact(format.width())
            .map(|record| {
                let at = format.xyz_bytes() + 10;
                f64::from_le_bytes(record[at..at + 8].try_into().unwrap())
            })
            .collect()
    }

    /// What `node_pipeline` does with one thread, without compression: runs the
    /// tasks depth first, partitioning on disk while a run is too big and
    /// finishing the rest in memory. Returns the nodes (sorted by key, with the
    /// ids of their points) and the number of runs finished in memory.
    fn driver_nodes(
        points: &[LasPointRecord],
        transform: Option<LasTransform>,
        max_points: usize,
        in_memory_run_bytes: u64,
        cancel: &(dyn CancelCheck + Sync),
        fs: &dyn ScratchFs,
    ) -> Result<(Vec<(VoxelKey, Vec<f64>)>, usize)> {
        let bounds = bounds_of(points);
        let (center, halfsize) = cube_from_bounds(&bounds);
        let (run, format) = root_run(points, transform, fs);
        let width = format.width();
        let params = LodParams {
            max_points_per_node: max_points,
            format,
            in_memory_run_bytes,
        };
        let mut stack = vec![RunTask {
            key: VoxelKey::root(),
            bounds: Bounds::cube(center, halfsize),
            run,
            counts: None,
        }];
        let mut nodes = Vec::new();
        let mut in_memory_runs = 0;
        while let Some(task) = stack.pop() {
            match expand_run(task, &params, cancel, fs)? {
                Expanded::FitsInMemory(task) => {
                    in_memory_runs += 1;
                    let records = read_run(&task.run, width)?;
                    drop(task.run);
                    build_in_memory(
                        task.key,
                        task.bounds,
                        records,
                        &params,
                        cancel,
                        &mut |key, records| {
                            nodes.push((key, ids(&records, format)));
                            Ok(())
                        },
                    )?;
                }
                Expanded::Split {
                    key,
                    node_records,
                    children,
                } => {
                    nodes.push((key, ids(&node_records, format)));
                    stack.extend(children.into_iter().rev());
                }
            }
        }
        nodes.sort_by_key(|(key, _)| *key);
        Ok((nodes, in_memory_runs))
    }

    fn record_nodes(
        points: &[LasPointRecord],
        max_points: usize,
        in_memory_run_bytes: u64,
        fs: &dyn ScratchFs,
    ) -> Result<(Vec<(VoxelKey, Vec<f64>)>, usize)> {
        driver_nodes(
            points,
            None,
            max_points,
            in_memory_run_bytes,
            &NeverCancel,
            fs,
        )
    }

    fn reference(
        points: &[LasPointRecord],
        max_points: usize,
        fs: &dyn ScratchFs,
    ) -> Vec<(VoxelKey, Vec<f64>)> {
        let bounds = bounds_of(points);
        let (center, halfsize) = cube_from_bounds(&bounds);
        let source = VecSource {
            points: points.to_vec(),
        };
        reference_nodes(&source, center, halfsize, max_points, &NeverCancel, fs)
            .unwrap()
            .into_iter()
            .map(|(key, indices)| {
                // The reference works with indices; the points carry their
                // index in gps_time.
                (key, indices.into_iter().map(|i| i as f64).collect())
            })
            .collect()
    }

    /// Deterministic scattered points (a small linear congruential generator).
    fn scattered(n: usize, seed: u64) -> Vec<LasPointRecord> {
        let mut state = seed;
        let mut next = move || {
            state = state
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            ((state >> 33) as f64) / f64::from(1u32 << 31)
        };
        (0..n)
            .map(|i| point(i, next() * 100.0, next() * 100.0, next() * 10.0))
            .collect()
    }

    /// Points in scan-line order (y ascending, then x): the M4-16 worst case.
    fn scan_lines(side: usize) -> Vec<LasPointRecord> {
        let mut points = Vec::new();
        for yi in 0..side {
            for xi in 0..side {
                points.push(point(
                    points.len(),
                    xi as f64,
                    yi as f64,
                    ((xi + yi) % 5) as f64,
                ));
            }
        }
        points
    }

    /// ADR-0019: the record-carrying builder must select exactly the points
    /// the old index-based builder selected, node by node and in the same
    /// order inside each node, whatever part is done on disk or in memory.
    #[test]
    fn record_builder_matches_index_reference() {
        let fs = MemoryScratchFs::new();
        let cases: Vec<(&str, Vec<LasPointRecord>, usize)> = vec![
            ("scattered 5000, node 100", scattered(5_000, 1), 100),
            ("scattered 3000, node 7", scattered(3_000, 2), 7),
            ("scan lines 64x64, node 200", scan_lines(64), 200),
            ("scan lines 40x40, node 33", scan_lines(40), 33),
            ("tiny, node 1000", scattered(300, 3), 1000),
        ];
        for (name, points, max_points) in cases {
            let expected = reference(&points, max_points, &fs);
            // Everything on disk, only leaf-sized runs in memory.
            // Some levels on disk, the rest in memory.
            // Everything in memory.
            for in_memory_run_bytes in [0u64, 2_000, 20_000, u64::MAX] {
                let (actual, _) =
                    record_nodes(&points, max_points, in_memory_run_bytes, &fs).unwrap();
                assert_eq!(
                    expected.len(),
                    actual.len(),
                    "{name}, in-memory limit {in_memory_run_bytes}: node count"
                );
                for (e, a) in expected.iter().zip(&actual) {
                    assert_eq!(
                        e, a,
                        "{name}, in-memory limit {in_memory_run_bytes}: node {:?}",
                        e.0
                    );
                }
            }
        }
    }

    /// L3-C: with i32 records the octants are decided from the stored
    /// integers. For points that sit on the output grid (as the points of a
    /// LAS file do) that is the same decision as from the f64 coordinates, so
    /// the nodes are exactly those of the f64 reference builder.
    #[test]
    fn quantized_records_match_index_reference_for_grid_points() {
        let transform = LasTransform {
            scale: (0.01, 0.01, 0.001),
            offset: (500.0, -20.0, 3.0),
        };
        let snap =
            |v: f64, scale: f64, offset: f64| ((v - offset) / scale).round() * scale + offset;
        let fs = MemoryScratchFs::new();
        let cases: Vec<(&str, Vec<LasPointRecord>, usize)> = vec![
            ("scattered 5000, node 100", scattered(5_000, 1), 100),
            ("scan lines 40x40, node 33", scan_lines(40), 33),
        ];
        for (name, points, max_points) in cases {
            let points: Vec<LasPointRecord> = points
                .into_iter()
                .map(|mut p| {
                    p.x = snap(p.x + 500.0, 0.01, 500.0);
                    p.y = snap(p.y - 20.0, 0.01, -20.0);
                    p.z = snap(p.z + 3.0, 0.001, 3.0);
                    p
                })
                .collect();
            let expected = reference(&points, max_points, &fs);
            for in_memory_run_bytes in [0u64, 2_000, u64::MAX] {
                let (actual, _) = driver_nodes(
                    &points,
                    Some(transform),
                    max_points,
                    in_memory_run_bytes,
                    &NeverCancel,
                    &fs,
                )
                .unwrap();
                assert_eq!(expected, actual, "{name}, limit {in_memory_run_bytes}");
            }
        }
    }

    #[test]
    fn disk_levels_and_memory_levels_are_both_used() {
        let fs = MemoryScratchFs::new();
        let points = scattered(5_000, 1);
        // 5000 records are far above 2 KB, so several disk levels happen.
        let (nodes, subtree_runs) = record_nodes(&points, 100, 2_000, &fs).unwrap();
        assert!(subtree_runs > 8, "only {subtree_runs} in-memory subtrees");
        let total: usize = nodes.iter().map(|(_, ids)| ids.len()).sum();
        assert_eq!(total, points.len());
        // Whole input in memory: one subtree, no disk level.
        let (_, subtree_runs) = record_nodes(&points, 100, u64::MAX, &fs).unwrap();
        assert_eq!(subtree_runs, 1);
    }

    fn covers_each_point_once(fs: &dyn ScratchFs) {
        let points = scattered(2_000, 9);
        for in_memory_run_bytes in [0u64, 5_000, u64::MAX] {
            let (nodes, _) = record_nodes(&points, 50, in_memory_run_bytes, fs).unwrap();
            let mut seen = vec![false; points.len()];
            for (_, ids) in &nodes {
                assert!(ids.len() <= 50);
                for &id in ids {
                    let slot = &mut seen[id as usize];
                    assert!(!*slot, "point {id} assigned more than once");
                    *slot = true;
                }
            }
            assert!(seen.into_iter().all(|v| v));
        }
    }

    #[test]
    fn covers_each_point_once_memory() {
        covers_each_point_once(&MemoryScratchFs::new());
    }

    #[cfg(feature = "native-fs")]
    #[test]
    fn covers_each_point_once_native() {
        let dir = tempfile::tempdir().unwrap();
        covers_each_point_once(&NativeScratchFs::new(dir.path()));
    }

    /// A dense cluster inside large bounds must keep subdividing until every
    /// node fits `max_points_per_node`; an oversized leaf would force the
    /// layered LAZ compressor to buffer that whole chunk in memory.
    #[test]
    fn dense_cluster_stays_bounded_below_giant_chunks() {
        let mut points: Vec<LasPointRecord> = (0..4_000usize)
            .map(|i| {
                let f = i as f64;
                point(
                    i,
                    f * 1e-4,
                    (f * 1.7).fract() * 0.4,
                    (f * 2.3).fract() * 0.4,
                )
            })
            .collect();
        for i in 0..8usize {
            points.push(point(
                4_000 + i,
                i as f64 * 1000.0,
                i as f64 * 1000.0,
                i as f64 * 100.0,
            ));
        }
        let fs = MemoryScratchFs::new();
        for in_memory_run_bytes in [0u64, u64::MAX] {
            let (nodes, _) = record_nodes(&points, 100, in_memory_run_bytes, &fs).unwrap();
            for (key, ids) in nodes {
                assert!(
                    ids.len() <= 100,
                    "node {key:?} holds {} points, exceeding max_points_per_node 100",
                    ids.len()
                );
            }
        }
    }

    #[test]
    fn identical_points_fail_instead_of_creating_an_unbounded_leaf() {
        let points: Vec<LasPointRecord> = (0..32).map(|i| point(i, 1.0, 1.0, 1.0)).collect();
        let fs = MemoryScratchFs::new();
        for in_memory_run_bytes in [0u64, u64::MAX] {
            let error = record_nodes(&points, 1, in_memory_run_bytes, &fs)
                .err()
                .expect("identical points must exceed the depth cap");
            assert!(error.to_string().contains("maximum depth"));
        }
    }

    /// M4-16: with spatially sorted input, the upper nodes must still cover
    /// the whole y range (taking each parent's points from the start of the
    /// run would give only the first scan lines).
    #[test]
    fn upper_nodes_cover_spatially_sorted_input() {
        let side = 64usize;
        let points = scan_lines(side);
        let fs = MemoryScratchFs::new();
        for in_memory_run_bytes in [0u64, u64::MAX] {
            let (nodes, _) = record_nodes(&points, 200, in_memory_run_bytes, &fs).unwrap();
            for max_level in 0..=1u32 {
                let mut bins = [0usize; 10];
                for (key, ids) in &nodes {
                    if key.level as u32 > max_level {
                        continue;
                    }
                    for &id in ids {
                        let y = points[id as usize].y;
                        let bin = ((y / side as f64) * 10.0) as usize;
                        bins[bin.min(9)] += 1;
                    }
                }
                assert!(
                    bins.iter().all(|&n| n > 0),
                    "points up to level {max_level} miss part of the y range: {bins:?}"
                );
            }
        }
    }

    #[test]
    fn picker_takes_exactly_k_of_n_evenly() {
        for (k, n) in [(0usize, 5usize), (1, 5), (3, 10), (10, 10), (7, 1000)] {
            let mut picker = Picker::new(k, n);
            let picked: Vec<usize> = (0..n).filter(|_| picker.pick_next()).collect();
            assert_eq!(picked.len(), k);
        }
    }

    #[test]
    fn cancel_stops_the_disk_levels() {
        struct CancelNow;
        impl CancelCheck for CancelNow {
            fn check(&self) -> Result<()> {
                Err(Error::Cancelled)
            }
        }
        let fs = MemoryScratchFs::new();
        let points = scattered(2_000, 4);
        let result = driver_nodes(&points, None, 50, 0, &CancelNow, &fs);
        assert!(matches!(result, Err(Error::Cancelled)));
    }
}
