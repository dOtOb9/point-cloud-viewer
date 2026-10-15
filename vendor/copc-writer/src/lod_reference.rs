//! Test-only reference: the LOD octree builder as it was before ADR-0019.
//!
//! This is the index-based implementation (partition lists of point indices,
//! fetch each point from the source through its index). Production code no
//! longer uses it. It stays here so the tests in `lod.rs` can check that the
//! record-carrying builder selects exactly the same points for every node
//! (same rule, same order), see `record_builder_matches_index_reference`.
//! Only the sequential version is kept; the parallel version was proven equal
//! to it when it was added (M4-8).
//!
//! The selection rule is the one decided in M4-16: a parent takes its points
//! evenly from the whole run of each child octant, not from the start of it.

use std::io::{BufReader, BufWriter, Read, Write};

use byteorder::{LittleEndian, ReadBytesExt, WriteBytesExt};
use copc_core::{Bounds, CancelCheck, Error, Result, VoxelKey};

use crate::lod::child_octant;
use crate::scratch::{ScratchFs, ScratchReader, ScratchWriter};
use crate::source::CopcPointSource;
use crate::CANCEL_POLL_STRIDE;

const INDEX_IO_BUFFER_BYTES: usize = 1024 * 1024;
const MAX_OCTREE_DEPTH: u32 = 30;

/// Width of one point index in the temporary index files. Kept from L3-A:
/// 4 bytes up to 2^32 points, 8 bytes above.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum IndexWidth {
    U32,
    U64,
}

impl IndexWidth {
    pub(crate) fn for_total_points(total_points: u64) -> Self {
        if total_points <= u64::from(u32::MAX) + 1 {
            IndexWidth::U32
        } else {
            IndexWidth::U64
        }
    }

    pub(crate) fn read<R: Read>(self, reader: &mut R) -> std::io::Result<u64> {
        match self {
            IndexWidth::U32 => reader.read_u32::<LittleEndian>().map(u64::from),
            IndexWidth::U64 => reader.read_u64::<LittleEndian>(),
        }
    }

    pub(crate) fn write<W: Write>(self, writer: &mut W, index: u64) -> std::io::Result<()> {
        match self {
            IndexWidth::U32 => {
                let narrow = u32::try_from(index).map_err(|_| {
                    std::io::Error::new(
                        std::io::ErrorKind::InvalidInput,
                        "LOD index does not fit the 32-bit index width",
                    )
                })?;
                writer.write_u32::<LittleEndian>(narrow)
            }
            IndexWidth::U64 => writer.write_u64::<LittleEndian>(index),
        }
    }
}

struct IndexRun {
    reader: Box<dyn ScratchReader>,
    count: usize,
    width: IndexWidth,
}

/// Builds the index and reads it back: every node with the source indices it
/// holds, in the order they sit in the node, sorted by key.
pub(crate) fn reference_nodes<S: CopcPointSource>(
    source: &S,
    center: (f64, f64, f64),
    halfsize: f64,
    max_points_per_node: usize,
    cancel: &(dyn CancelCheck + Sync),
    fs: &dyn ScratchFs,
) -> Result<Vec<(VoxelKey, Vec<u64>)>> {
    let total_points = source.len() as u64;
    let width = IndexWidth::for_total_points(total_points);
    let root_run = write_root_index_run(total_points, width, fs)?;
    let mut nodes: Vec<(VoxelKey, Vec<u64>)> = Vec::new();
    let builder = Builder {
        source,
        max_points_per_node,
        cancel,
        fs,
    };
    builder.assign(
        VoxelKey::root(),
        root_run,
        Bounds::cube(center, halfsize),
        &mut nodes,
    )?;
    nodes.sort_by_key(|(key, _)| *key);
    Ok(nodes)
}

struct Builder<'a, S: CopcPointSource> {
    source: &'a S,
    max_points_per_node: usize,
    cancel: &'a (dyn CancelCheck + Sync),
    fs: &'a dyn ScratchFs,
}

impl<S: CopcPointSource> Builder<'_, S> {
    fn assign(
        &self,
        key: VoxelKey,
        run: IndexRun,
        bounds: Bounds,
        nodes: &mut Vec<(VoxelKey, Vec<u64>)>,
    ) -> Result<()> {
        self.cancel.check()?;
        if run.count == 0 {
            return Ok(());
        }
        if run.count <= self.max_points_per_node {
            nodes.push((key, read_run(&run)?));
            return Ok(());
        }
        if key.level as u32 >= MAX_OCTREE_DEPTH {
            return Err(Error::InvalidInput(format!(
                "octree node {key:?} still contains {} points at the maximum depth; increase max_points_per_node above {}",
                run.count, self.max_points_per_node
            )));
        }

        let mut children = self.partition(&run, bounds)?;
        let mut selected: Vec<u64> = Vec::new();
        self.select_for_parent_and_split_children(&mut children, &mut selected)?;
        nodes.push((key, selected));
        for (octant, child) in children.iter_mut().enumerate() {
            let Some(child_run) = child.take() else {
                continue;
            };
            self.assign(
                key.child(octant as u8)?,
                child_run,
                bounds.octant(octant as u8),
                nodes,
            )?;
        }
        Ok(())
    }

    fn partition(&self, run: &IndexRun, bounds: Bounds) -> Result<[Option<IndexRun>; 8]> {
        let mut reader = open_index_run(run)?;
        let mut writers: [Option<BufWriter<Box<dyn ScratchWriter>>>; 8] =
            std::array::from_fn(|_| None);
        let mut counts = [0usize; 8];
        let center = bounds.center();
        for read_index in 0..run.count {
            if read_index.is_multiple_of(CANCEL_POLL_STRIDE) {
                self.cancel.check()?;
            }
            let index = run
                .width
                .read(&mut reader)
                .map_err(|e| Error::io("read LOD partition index", e))?;
            let (x, y, z) = self.source.xyz(index as usize)?;
            let octant = child_octant(center, x, y, z);
            if writers[octant].is_none() {
                writers[octant] = Some(BufWriter::with_capacity(
                    INDEX_IO_BUFFER_BYTES,
                    self.fs.create_temp("partition")?,
                ));
            }
            let writer = writers[octant]
                .as_mut()
                .ok_or_else(|| Error::InvalidData("partition writer was not created".into()))?;
            run.width
                .write(writer, index)
                .map_err(|e| Error::io("write LOD partition index", e))?;
            counts[octant] += 1;
        }
        let mut children: [Option<IndexRun>; 8] = std::array::from_fn(|_| None);
        for octant in 0..8 {
            let Some(writer) = writers[octant].take() else {
                continue;
            };
            let boxed = writer
                .into_inner()
                .map_err(|e| Error::io("flush LOD partition index", e.into_error()))?;
            children[octant] = Some(IndexRun {
                reader: boxed.finish_temp()?,
                count: counts[octant],
                width: run.width,
            });
        }
        Ok(children)
    }

    fn select_for_parent_and_split_children(
        &self,
        children: &mut [Option<IndexRun>; 8],
        parent: &mut Vec<u64>,
    ) -> Result<()> {
        let counts: [usize; 8] =
            std::array::from_fn(|o| children[o].as_ref().map_or(0, |child| child.count));
        let selected_counts = decide_selected_counts(&counts, self.max_points_per_node);
        for octant in 0..8 {
            let Some(child) = children[octant].take() else {
                continue;
            };
            let selected = selected_counts[octant];
            if selected == 0 {
                children[octant] = Some(child);
                continue;
            }
            let n = child.count as u64;
            let k = selected as u64;
            let mut reader = open_index_run(&child)?;
            let mut rest_writer = if selected < child.count {
                Some(BufWriter::with_capacity(
                    INDEX_IO_BUFFER_BYTES,
                    self.fs.create_temp("remainder")?,
                ))
            } else {
                None
            };
            for i in 0..child.count {
                if i.is_multiple_of(CANCEL_POLL_STRIDE) {
                    self.cancel.check()?;
                }
                let index = child
                    .width
                    .read(&mut reader)
                    .map_err(|e| Error::io("read selected LOD index", e))?;
                let i = i as u64;
                if (i + 1) * k / n > i * k / n {
                    parent.push(index);
                } else if let Some(rest) = rest_writer.as_mut() {
                    child
                        .width
                        .write(rest, index)
                        .map_err(|e| Error::io("write LOD remainder index", e))?;
                }
            }
            if let Some(rest) = rest_writer {
                let boxed = rest
                    .into_inner()
                    .map_err(|e| Error::io("flush LOD remainder index", e.into_error()))?;
                children[octant] = Some(IndexRun {
                    reader: boxed.finish_temp()?,
                    count: child.count - selected,
                    width: child.width,
                });
            }
        }
        Ok(())
    }
}

/// How many points each child gives to the parent: one point per child in
/// turn (round robin) until the parent is full. Copied as it was, so a change
/// in the production copy cannot hide itself.
fn decide_selected_counts(counts: &[usize; 8], max_points_per_node: usize) -> [usize; 8] {
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

fn write_root_index_run(
    total_points: u64,
    width: IndexWidth,
    fs: &dyn ScratchFs,
) -> Result<IndexRun> {
    let count = usize::try_from(total_points)
        .map_err(|_| Error::InvalidInput("point count exceeds usize range".into()))?;
    let mut writer = BufWriter::with_capacity(INDEX_IO_BUFFER_BYTES, fs.create_temp("root")?);
    for index in 0..total_points {
        width
            .write(&mut writer, index)
            .map_err(|e| Error::io("write root LOD index", e))?;
    }
    let boxed = writer
        .into_inner()
        .map_err(|e| Error::io("flush root LOD index", e.into_error()))?;
    Ok(IndexRun {
        reader: boxed.finish_temp()?,
        count,
        width,
    })
}

fn read_run(run: &IndexRun) -> Result<Vec<u64>> {
    let mut reader = open_index_run(run)?;
    let mut out = Vec::with_capacity(run.count);
    for _ in 0..run.count {
        out.push(
            run.width
                .read(&mut reader)
                .map_err(|e| Error::io("read LOD index", e))?,
        );
    }
    Ok(out)
}

fn open_index_run(run: &IndexRun) -> Result<BufReader<Box<dyn Read + Send>>> {
    let reader = run.reader.open_at(0)?;
    Ok(BufReader::with_capacity(INDEX_IO_BUFFER_BYTES, reader))
}
