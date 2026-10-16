//! From LOD runs to COPC chunks (ADR-0019).
//!
//! `lod.rs` turns a run of point records into nodes, either by partitioning it
//! on disk (`expand_run`) or by building its whole subtree in memory
//! (`build_in_memory`). This module runs those tasks, compresses every node as
//! a standalone LAZ chunk, and writes the chunks.
//!
//! - `NodeContext` runs one task (`run_task`): it expands the run, encodes the
//!   node's records to the LAS point layout (`record.rs`) and compresses them. A run
//!   that fits the memory budget is loaded and compressed node by node
//!   straight from memory.
//! - `ChunkWriter` appends chunks to the output, builds the hierarchy entries
//!   and the LAZ chunk table. COPC does not require any chunk order: the
//!   hierarchy records the offset of every node.
//! - `write_chunks` runs the root task and all the tasks it creates, either
//!   one by one on the calling thread (depth first: a node, then its children
//!   in octant order; Web, tests, `workers == 1`) or on `workers` threads
//!   (`parallel-compress`), where chunks are written in the order they finish.
//!
//! # Memory
//!
//! A worker holds one task at a time. A task that partitions a run on disk
//! holds the read block and the 8 write buffers (1 MiB each) plus the node's
//! records (at most `max_points_per_node`). A task that finishes a run in
//! memory holds at most about twice `LodParams::in_memory_run_bytes` (the top
//! split keeps the loaded run and the new buffers together). Tasks waiting in
//! the queue hold only a file handle, and compressed chunks wait for the
//! writer in a channel of a fixed size. So the total does not depend on the
//! number of points.
//!
//! # Disk
//!
//! Workers take the newest task first (a stack), so a run is split further
//! before its siblings are started and the child runs of a split replace
//! their parent run, which is deleted. The files alive at one time are
//! roughly one copy of the data plus the runs being written.

use std::io::{Seek, SeekFrom, Write};
use std::sync::Mutex;

use byteorder::{LittleEndian, WriteBytesExt};
use copc_core::{CancelCheck, Entry, Error, Result, VoxelKey};
use laz::laszip::{ChunkTable, ChunkTableEntry};
use laz::{LasZipCompressor, LazVlr};
use web_time::{Duration, Instant};

use crate::lod::{build_in_memory, expand_run, read_run, Expanded, LodParams, RunTask};
use crate::record::LAS_XYZ_BYTES;
use crate::scratch::ScratchFs;
use crate::validate::quantize_xyz;
use crate::CANCEL_POLL_STRIDE;

/// One node, compressed as a standalone LAZ chunk.
pub(crate) struct CompressedNode {
    key: VoxelKey,
    point_count: usize,
    bytes: Vec<u8>,
}

/// What one task produced: finished nodes, and runs that still need work.
struct TaskOutput {
    nodes: Vec<CompressedNode>,
    children: Vec<RunTask>,
}

/// Measures the wall-clock time during which at least one run is being
/// partitioned on disk (the union of the partition intervals of all threads).
pub(crate) struct PartitionClock {
    state: Mutex<ClockState>,
}

#[derive(Default)]
struct ClockState {
    active: usize,
    since: Option<Instant>,
    total: Duration,
}

impl PartitionClock {
    pub(crate) fn new() -> Self {
        Self {
            state: Mutex::new(ClockState::default()),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, ClockState> {
        // The state is plain numbers; use it even if a thread panicked.
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn enter(&self) {
        let mut state = self.lock();
        if state.active == 0 {
            state.since = Some(Instant::now());
        }
        state.active += 1;
    }

    fn leave(&self) {
        let mut state = self.lock();
        state.active = state.active.saturating_sub(1);
        if state.active == 0 {
            if let Some(since) = state.since.take() {
                state.total += since.elapsed();
            }
        }
    }

    fn total(&self) -> Duration {
        self.lock().total
    }
}

/// Everything needed to run a task. Shared by all workers.
pub(crate) struct NodeContext<'a> {
    pub(crate) lod: LodParams,
    /// Bytes of one LAS point record in the output (PDRF 6/7 plus extra bytes).
    pub(crate) output_record_len: usize,
    pub(crate) scale: (f64, f64, f64),
    pub(crate) offset: (f64, f64, f64),
    pub(crate) var_vlr: &'a LazVlr,
    pub(crate) cancel: &'a (dyn CancelCheck + Sync),
    pub(crate) fs: &'a dyn ScratchFs,
    pub(crate) clock: &'a PartitionClock,
}

impl NodeContext<'_> {
    fn run_task(&self, task: RunTask) -> Result<TaskOutput> {
        self.clock.enter();
        let expanded = expand_run(task, &self.lod, self.cancel, self.fs);
        self.clock.leave();
        match expanded? {
            Expanded::FitsInMemory(task) => {
                let records = read_run(&task.run, self.lod.format.width())?;
                // The run file is not needed any more.
                drop(task.run);
                let mut nodes = Vec::new();
                build_in_memory(
                    task.key,
                    task.bounds,
                    records,
                    &self.lod,
                    self.cancel,
                    &mut |key, records| {
                        nodes.push(self.compress_node(key, &records)?);
                        Ok(())
                    },
                )?;
                Ok(TaskOutput {
                    nodes,
                    children: Vec::new(),
                })
            }
            Expanded::Split {
                key,
                node_records,
                children,
            } => Ok(TaskOutput {
                nodes: vec![self.compress_node(key, &node_records)?],
                children,
            }),
        }
    }

    /// Compresses the records of one node as one standalone LAZ chunk.
    ///
    /// Quantized records are the output's point records already (`record.rs`),
    /// so they go to the compressor as they are. Wide records have f64
    /// coordinates, which are quantized here.
    fn compress_node(&self, key: VoxelKey, records: &[u8]) -> Result<CompressedNode> {
        let format = self.lod.format;
        let width = format.width();
        let point_count = records.len() / width;
        let bytes = match format.transform() {
            Some(_) => {
                if width != self.output_record_len {
                    return Err(Error::InvalidData(format!(
                        "spill record is {width} bytes but the output point record is {}",
                        self.output_record_len
                    )));
                }
                self.cancel.check()?;
                compress_standalone_chunk(records, self.var_vlr)?
            }
            None => {
                let raw = self.wide_to_output_records(records, point_count)?;
                compress_standalone_chunk(&raw, self.var_vlr)?
            }
        };
        Ok(CompressedNode {
            key,
            point_count,
            bytes,
        })
    }

    /// Wide records (f64 x, y, z) to the output's point records.
    fn wide_to_output_records(&self, records: &[u8], point_count: usize) -> Result<Vec<u8>> {
        let format = self.lod.format;
        let raw_len = point_count
            .checked_mul(self.output_record_len)
            .ok_or_else(|| Error::InvalidInput("node point buffer size overflows usize".into()))?;
        let mut raw = vec![0u8; raw_len];
        for (i, (record, out)) in records
            .chunks_exact(format.width())
            .zip(raw.chunks_exact_mut(self.output_record_len))
            .enumerate()
        {
            if i.is_multiple_of(CANCEL_POLL_STRIDE) {
                self.cancel.check()?;
            }
            let (x, y, z) = format.xyz(record);
            // `i` is the position inside the node; it only appears in the
            // message of a coordinate that cannot be encoded.
            let (ix, iy, iz) = quantize_xyz(i, x, y, z, self.scale, self.offset)?;
            out[0..4].copy_from_slice(&ix.to_le_bytes());
            out[4..8].copy_from_slice(&iy.to_le_bytes());
            out[8..12].copy_from_slice(&iz.to_le_bytes());
            out[LAS_XYZ_BYTES..].copy_from_slice(format.body(record));
        }
        Ok(raw)
    }
}

/// Compress one node's raw points as a standalone variable-size LAZ chunk and
/// return exactly the chunk bytes (no chunk-table offset, no chunk table).
fn compress_standalone_chunk(raw_points: &[u8], var_vlr: &LazVlr) -> Result<Vec<u8>> {
    let mut cursor = std::io::Cursor::new(Vec::new());
    let mut compressor = LasZipCompressor::new(&mut cursor, var_vlr.clone())
        .map_err(|e| Error::Las(format!("chunk compressor: {e}")))?;
    compressor
        .compress_many(raw_points)
        .map_err(|e| Error::Las(format!("compress chunk: {e}")))?;
    compressor
        .done()
        .map_err(|e| Error::Las(format!("finish chunk: {e}")))?;
    drop(compressor);
    let bytes = cursor.into_inner();
    // A LAZ point-data stream starts with an i64 offset to the chunk table;
    // the single chunk's bytes sit between that offset field and the table.
    let table_position = bytes
        .first_chunk::<8>()
        .map(|head| i64::from_le_bytes(*head))
        .ok_or_else(|| Error::InvalidData("truncated LAZ chunk stream".into()))?;
    let table_position = usize::try_from(table_position)
        .map_err(|_| Error::InvalidData("invalid LAZ chunk table offset".into()))?;
    if table_position < 8 || table_position > bytes.len() {
        return Err(Error::InvalidData(
            "LAZ chunk table offset out of range".into(),
        ));
    }
    Ok(bytes[8..table_position].to_vec())
}

/// Appends compressed chunks to the output and keeps the hierarchy entries
/// and the LAZ chunk table.
struct ChunkWriter<'w, W: Write + Seek> {
    writer: &'w mut W,
    table_offset_position: u64,
    next_chunk_offset: u64,
    hierarchy: Vec<Entry>,
    chunk_table: ChunkTable,
}

impl<'w, W: Write + Seek> ChunkWriter<'w, W> {
    /// Writes the placeholder for the chunk table offset that starts a LAZ
    /// point-data stream. `finish` patches it.
    fn begin(writer: &'w mut W) -> Result<Self> {
        let table_offset_position = writer
            .stream_position()
            .map_err(|e| Error::io("record chunk table offset position", e))?;
        writer
            .write_i64::<LittleEndian>(-1)
            .map_err(|e| Error::io("write chunk table offset placeholder", e))?;
        Ok(Self {
            writer,
            table_offset_position,
            next_chunk_offset: table_offset_position + 8,
            hierarchy: Vec::new(),
            chunk_table: ChunkTable::with_capacity(0),
        })
    }

    fn push(&mut self, node: CompressedNode) -> Result<()> {
        self.writer
            .write_all(&node.bytes)
            .map_err(|e| Error::io("write LAZ chunk", e))?;
        let byte_size = node.bytes.len() as u64;
        self.hierarchy.push(Entry {
            key: node.key,
            offset: self.next_chunk_offset,
            byte_size: i32::try_from(byte_size)
                .map_err(|_| Error::InvalidInput("LAZ chunk exceeds COPC i32 byte size".into()))?,
            point_count: i32::try_from(node.point_count).map_err(|_| {
                Error::InvalidInput("node point count exceeds COPC i32 range".into())
            })?,
        });
        self.chunk_table.push(ChunkTableEntry {
            point_count: node.point_count as u64,
            byte_count: byte_size,
        });
        self.next_chunk_offset = self
            .next_chunk_offset
            .checked_add(byte_size)
            .ok_or_else(|| Error::InvalidInput("LAZ point-data offset overflows u64".into()))?;
        Ok(())
    }

    /// Writes the chunk table, patches the table offset, and returns the
    /// hierarchy entries sorted by key.
    fn finish(self, var_vlr: &LazVlr) -> Result<Vec<Entry>> {
        let chunk_table_position = self
            .writer
            .stream_position()
            .map_err(|e| Error::io("record chunk table position", e))?;
        self.chunk_table
            .write_to(&mut *self.writer, var_vlr)
            .map_err(|e| Error::io("write chunk table", e))?;
        let end_position = self
            .writer
            .stream_position()
            .map_err(|e| Error::io("record chunk table end", e))?;
        self.writer
            .seek(SeekFrom::Start(self.table_offset_position))
            .map_err(|e| Error::io("seek chunk table offset", e))?;
        let chunk_table_position = i64::try_from(chunk_table_position)
            .map_err(|_| Error::InvalidInput("LAZ chunk table offset exceeds i64 range".into()))?;
        self.writer
            .write_i64::<LittleEndian>(chunk_table_position)
            .map_err(|e| Error::io("patch chunk table offset", e))?;
        self.writer
            .seek(SeekFrom::Start(end_position))
            .map_err(|e| Error::io("seek end of point data", e))?;
        let mut hierarchy = self.hierarchy;
        hierarchy.sort_by_key(|entry| entry.key);
        Ok(hierarchy)
    }
}

/// Result of `write_chunks`.
pub(crate) struct ChunksWritten {
    pub(crate) hierarchy: Vec<Entry>,
    /// Wall-clock time during which at least one run was being partitioned on
    /// disk (see `PartitionClock`).
    pub(crate) disk_partition_time: Duration,
}

/// Runs `root` and every task it creates, compresses all the nodes and writes
/// the chunks to `writer`. `workers` is the number of threads; 1 means
/// everything runs on the calling thread.
pub(crate) fn write_chunks<W: Write + Seek>(
    writer: &mut W,
    ctx: &NodeContext<'_>,
    workers: usize,
    root: RunTask,
) -> Result<ChunksWritten> {
    ctx.lod.validate()?;
    let mut chunks = ChunkWriter::begin(writer)?;
    run_tasks(&mut chunks, ctx, workers, root)?;
    let hierarchy = chunks.finish(ctx.var_vlr)?;
    Ok(ChunksWritten {
        hierarchy,
        disk_partition_time: ctx.clock.total(),
    })
}

#[cfg(not(feature = "parallel-compress"))]
fn run_tasks<W: Write + Seek>(
    chunks: &mut ChunkWriter<'_, W>,
    ctx: &NodeContext<'_>,
    _workers: usize,
    root: RunTask,
) -> Result<()> {
    run_tasks_inline(chunks, ctx, root)
}

#[cfg(feature = "parallel-compress")]
fn run_tasks<W: Write + Seek>(
    chunks: &mut ChunkWriter<'_, W>,
    ctx: &NodeContext<'_>,
    workers: usize,
    root: RunTask,
) -> Result<()> {
    if workers <= 1 {
        return run_tasks_inline(chunks, ctx, root);
    }
    threaded::run_tasks_threaded(chunks, ctx, workers, root)
}

/// Depth first on the calling thread: a node, then its children in octant
/// order.
fn run_tasks_inline<W: Write + Seek>(
    chunks: &mut ChunkWriter<'_, W>,
    ctx: &NodeContext<'_>,
    root: RunTask,
) -> Result<()> {
    let mut stack = vec![root];
    while let Some(task) = stack.pop() {
        let output = ctx.run_task(task)?;
        for node in output.nodes {
            chunks.push(node)?;
        }
        stack.extend(output.children.into_iter().rev());
    }
    Ok(())
}

#[cfg(feature = "parallel-compress")]
mod threaded {
    use std::io::{Seek, Write};
    use std::panic::{catch_unwind, AssertUnwindSafe};
    use std::sync::mpsc::{sync_channel, SyncSender};
    use std::sync::{Condvar, Mutex, MutexGuard, PoisonError};

    use copc_core::{Error, Result};

    use super::{ChunkWriter, CompressedNode, NodeContext, TaskOutput};
    use crate::lod::RunTask;

    /// The tasks that wait for a thread, newest on top.
    struct Queue {
        state: Mutex<QueueState>,
        wake: Condvar,
        first_error: Mutex<Option<Error>>,
    }

    struct QueueState {
        stack: Vec<RunTask>,
        /// Tasks that are waiting or running. The work is over when it is 0.
        unfinished: usize,
        /// Set after an error: nobody starts another task.
        stopped: bool,
    }

    impl Queue {
        fn lock(&self) -> MutexGuard<'_, QueueState> {
            self.state.lock().unwrap_or_else(PoisonError::into_inner)
        }

        /// The next task, or `None` when the work is over or has been stopped.
        fn next_task(&self) -> Option<RunTask> {
            let mut state = self.lock();
            loop {
                if state.stopped {
                    return None;
                }
                if let Some(task) = state.stack.pop() {
                    return Some(task);
                }
                if state.unfinished == 0 {
                    return None;
                }
                state = self
                    .wake
                    .wait(state)
                    .unwrap_or_else(PoisonError::into_inner);
            }
        }

        /// A task is done; its child runs become tasks (octant 0 on top).
        fn finish_task(&self, children: Vec<RunTask>) {
            let mut state = self.lock();
            state.unfinished = state.unfinished + children.len() - 1;
            state.stack.extend(children.into_iter().rev());
            self.wake.notify_all();
        }

        /// Stops the work. Only the first error is kept.
        fn stop(&self, error: Option<Error>) {
            if let Some(error) = error {
                let mut first = self
                    .first_error
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner);
                if first.is_none() {
                    *first = Some(error);
                }
            }
            self.lock().stopped = true;
            self.wake.notify_all();
        }
    }

    fn worker(ctx: &NodeContext<'_>, queue: &Queue, nodes: &SyncSender<CompressedNode>) {
        while let Some(task) = queue.next_task() {
            // A panic must not leave the other threads waiting for a task that
            // never finishes, so it is turned into an error.
            let result =
                catch_unwind(AssertUnwindSafe(|| ctx.run_task(task))).unwrap_or_else(|_| {
                    Err(Error::InvalidData(
                        "a LOD worker thread panicked while building nodes".into(),
                    ))
                });
            let TaskOutput {
                nodes: finished,
                children,
            } = match result {
                Ok(output) => output,
                Err(error) => {
                    queue.stop(Some(error));
                    return;
                }
            };
            for node in finished {
                if nodes.send(node).is_err() {
                    // The writer has stopped (it reports its own error).
                    queue.stop(None);
                    return;
                }
            }
            queue.finish_task(children);
        }
    }

    /// `workers` threads take tasks from a shared stack; this thread writes the
    /// finished chunks.
    pub(super) fn run_tasks_threaded<W: Write + Seek>(
        chunks: &mut ChunkWriter<'_, W>,
        ctx: &NodeContext<'_>,
        workers: usize,
        root: RunTask,
    ) -> Result<()> {
        let queue = Queue {
            state: Mutex::new(QueueState {
                stack: vec![root],
                unfinished: 1,
                stopped: false,
            }),
            wake: Condvar::new(),
            first_error: Mutex::new(None),
        };
        // Bounded, so that threads wait when the writer is slow instead of
        // piling up compressed chunks.
        let (node_tx, node_rx) = sync_channel::<CompressedNode>(workers * 2);

        let write_result = std::thread::scope(|scope| {
            for _ in 0..workers {
                let node_tx = node_tx.clone();
                let queue = &queue;
                scope.spawn(move || worker(ctx, queue, &node_tx));
            }
            drop(node_tx);

            let mut write_result = Ok(());
            for node in &node_rx {
                if let Err(error) = chunks.push(node) {
                    write_result = Err(error);
                    queue.stop(None);
                    break;
                }
            }
            // Threads that are still sending see the closed channel and stop.
            drop(node_rx);
            write_result
        });

        let first_error = queue
            .first_error
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        match first_error {
            Some(error) => Err(error),
            None => write_result,
        }
    }
}
