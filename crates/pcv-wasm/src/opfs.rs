use std::cell::{Cell, RefCell};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::rc::Rc;
use std::time::Duration;

use copc_core::{Error, Result};
use copc_writer::{ScratchFs, ScratchReader, ScratchWriter};
use wasm_bindgen::JsValue;
use web_sys::{FileSystemReadWriteOptions, FileSystemSyncAccessHandle};
use web_time::Instant;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ZeroLength {
    EndOfFile,
    Error,
}

fn check_opfs_len(
    op: &str,
    raw: f64,
    pos: u64,
    buf_len: usize,
    zero_length: ZeroLength,
) -> std::result::Result<usize, String> {
    let valid = raw.is_finite() && raw >= 0.0 && raw.fract() == 0.0 && raw <= buf_len as f64;
    if valid && (zero_length == ZeroLength::EndOfFile || raw > 0.0) {
        return Ok(raw as usize);
    }
    let hint = if op == "書き込み" {
        "空き容量不足の可能性があります。シークレットウィンドウではブラウザの保存領域が小さく、\
         大きな点群を変換できないことがあります"
    } else {
        "ブラウザの保存領域に問題がある可能性があります"
    };
    Err(format!(
        "OPFSへの{op}に失敗しました（ブラウザが異常な値 {raw} を返しました。\
         ファイル位置={pos}、バッファ長={buf_len}。{hint}）"
    ))
}

#[derive(Clone, Default)]
pub struct OpfsIoTimer(Rc<Cell<Duration>>);

impl OpfsIoTimer {
    fn record(&self, elapsed: Duration) {
        self.0.set(self.0.get() + elapsed);
    }

    pub fn total(&self) -> Duration {
        self.0.get()
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct OpfsReadStats {
    pub read_at_calls: u64,
    pub cache_hits: u64,
    pub cache_misses: u64,
    pub bytes_read_from_opfs: u64,
    pub read_time: Duration,
}

#[derive(Clone, Default)]
pub struct OpfsReadCounters(Rc<Cell<OpfsReadStats>>);

impl OpfsReadCounters {
    fn record_call(&self) {
        let mut stats = self.0.get();
        stats.read_at_calls += 1;
        self.0.set(stats);
    }

    fn record_hit(&self) {
        let mut stats = self.0.get();
        stats.cache_hits += 1;
        self.0.set(stats);
    }

    fn record_miss(&self, bytes: u64, elapsed: Duration) {
        let mut stats = self.0.get();
        stats.cache_misses += 1;
        stats.bytes_read_from_opfs += bytes;
        stats.read_time += elapsed;
        self.0.set(stats);
    }

    pub fn snapshot(&self) -> OpfsReadStats {
        self.0.get()
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct OpfsSeqReadStats {
    pub seq_read_calls: u64,
    pub seq_read_time: Duration,
}

#[derive(Clone, Default)]
pub struct OpfsSeqReadCounters(Rc<Cell<OpfsSeqReadStats>>);

impl OpfsSeqReadCounters {
    fn record(&self, elapsed: Duration) {
        let mut stats = self.0.get();
        stats.seq_read_calls += 1;
        stats.seq_read_time += elapsed;
        self.0.set(stats);
    }

    pub fn snapshot(&self) -> OpfsSeqReadStats {
        self.0.get()
    }
}

pub const OPFS_SCRATCH_POOL_SIZE: usize = 256;

const READ_CACHE_BLOCK_BYTES: u64 = 64 * 1024;

const READ_CACHE_MAX_BLOCKS: usize = 64;

fn at(offset: u64) -> FileSystemReadWriteOptions {
    let options = FileSystemReadWriteOptions::new();
    options.set_at_f64(offset as f64);
    options
}

fn js_io_err(context: &str, err: JsValue) -> io::Error {
    let message = js_sys::Error::from(err).message();
    io::Error::other(format!("{context}: {message}"))
}

fn js_copc_err(context: &'static str, err: JsValue) -> Error {
    Error::io(context, js_io_err(context, err))
}

struct Pool {
    handles: Vec<FileSystemSyncAccessHandle>,
    free: Vec<usize>,
}

fn take_free_pool_slot(free: &mut Vec<usize>, pool_len: usize, label: &str) -> Result<usize> {
    free.pop().ok_or_else(|| {
        Error::InvalidInput(format!(
            "OPFS一時ファイルの枠({pool_len}個)を使い切りました(要求元: {label})。\
             max_points_per_nodeを増やすか、点密度の偏りが極端なデータでないか確認してください"
        ))
    })
}

pub struct OpfsScratchFs {
    pool: Rc<RefCell<Pool>>,
    output: Rc<RefCell<Option<FileSystemSyncAccessHandle>>>,
    timer: OpfsIoTimer,
    read_counters: OpfsReadCounters,
    seq_read_counters: OpfsSeqReadCounters,
}

// SAFETY: wasm32-unknown-unknown without atomics is single-threaded (ADR-0012), so these `web_sys` handles never cross threads; `Send + Sync` only satisfy the bounds of `ScratchFs`.
unsafe impl Send for OpfsScratchFs {}
unsafe impl Sync for OpfsScratchFs {}
unsafe impl Send for OpfsTempWriter {}
unsafe impl Sync for OpfsTempWriter {}
unsafe impl Send for OpfsTempReader {}
unsafe impl Sync for OpfsTempReader {}
unsafe impl Send for OpfsOutputWriter {}
unsafe impl Sync for OpfsOutputWriter {}
unsafe impl Send for OpfsSeqReader {}

impl OpfsScratchFs {
    pub fn new(
        scratch_handles: Vec<FileSystemSyncAccessHandle>,
        output_handle: FileSystemSyncAccessHandle,
    ) -> Self {
        let count = scratch_handles.len();
        Self {
            pool: Rc::new(RefCell::new(Pool {
                handles: scratch_handles,
                free: (0..count).collect(),
            })),
            output: Rc::new(RefCell::new(Some(output_handle))),
            timer: OpfsIoTimer::default(),
            read_counters: OpfsReadCounters::default(),
            seq_read_counters: OpfsSeqReadCounters::default(),
        }
    }

    pub fn io_timings(&self) -> Duration {
        self.timer.total()
    }

    pub fn read_stats(&self) -> OpfsReadStats {
        self.read_counters.snapshot()
    }

    pub fn seq_read_stats(&self) -> OpfsSeqReadStats {
        self.seq_read_counters.snapshot()
    }
}

impl ScratchFs for OpfsScratchFs {
    fn create_temp(&self, label: &str) -> Result<Box<dyn ScratchWriter>> {
        let index = {
            let mut pool = self.pool.borrow_mut();
            let pool_len = pool.handles.len();
            take_free_pool_slot(&mut pool.free, pool_len, label)?
        };
        {
            let truncate_start = Instant::now();
            let pool = self.pool.borrow();
            pool.handles[index]
                .truncate_with_u32(0)
                .map_err(|e| js_copc_err("OPFS scratch truncate", e))?;
            drop(pool);
            self.timer.record(truncate_start.elapsed());
        }
        Ok(Box::new(OpfsTempWriter {
            pool: self.pool.clone(),
            index,
            pos: 0,
            timer: self.timer.clone(),
            read_counters: self.read_counters.clone(),
            seq_read_counters: self.seq_read_counters.clone(),
        }))
    }

    fn create_output(&self, _final_path: &Path) -> Result<Box<dyn ScratchWriter>> {
        let handle = self
            .output
            .borrow_mut()
            .take()
            .ok_or_else(|| Error::InvalidInput("OPFS出力ハンドルは既に使用済みです".into()))?;
        let truncate_start = Instant::now();
        handle
            .truncate_with_u32(0)
            .map_err(|e| js_copc_err("OPFS output truncate", e))?;
        self.timer.record(truncate_start.elapsed());
        Ok(Box::new(OpfsOutputWriter {
            handle,
            pos: 0,
            timer: self.timer.clone(),
        }))
    }
}

struct OpfsTempWriter {
    pool: Rc<RefCell<Pool>>,
    index: usize,
    pos: u64,
    timer: OpfsIoTimer,
    read_counters: OpfsReadCounters,
    seq_read_counters: OpfsSeqReadCounters,
}

impl Write for OpfsTempWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let write_start = Instant::now();
        let written = {
            let pool = self.pool.borrow();
            pool.handles[self.index]
                .write_with_u8_array_and_options(buf, &at(self.pos))
                .map_err(|e| js_io_err("OPFS scratch write", e))?
        };
        self.timer.record(write_start.elapsed());
        let written = check_opfs_len("書き込み", written, self.pos, buf.len(), ZeroLength::Error)
            .map_err(io::Error::other)?;
        self.pos += written as u64;
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl Seek for OpfsTempWriter {
    fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
        self.pos = resolve_seek(&self.pool, self.index, self.pos, pos, &self.timer)?;
        Ok(self.pos)
    }
}

impl ScratchWriter for OpfsTempWriter {
    fn finish_temp(self: Box<Self>) -> Result<Box<dyn ScratchReader>> {
        let get_size_start = Instant::now();
        let len = {
            let pool = self.pool.borrow();
            pool.handles[self.index]
                .get_size()
                .map_err(|e| js_copc_err("OPFS scratch get_size", e))?
        };
        self.timer.record(get_size_start.elapsed());
        Ok(Box::new(OpfsTempReader {
            pool: self.pool,
            index: self.index,
            len: len as u64,
            cache: RefCell::new(ReadCache::new()),
            timer: self.timer,
            read_counters: self.read_counters,
            seq_read_counters: self.seq_read_counters,
        }))
    }

    fn finish_output(self: Box<Self>) -> Result<()> {
        Err(Error::InvalidInput(
            "OpfsTempWriter::finish_outputは呼ばれない想定(create_tempが作った \
             ハンドルはfinish_tempで確定する)"
                .into(),
        ))
    }
}

struct CacheBlock {
    block_index: u64,
    data: Vec<u8>,
}

struct ReadCache {
    blocks: Vec<CacheBlock>,
}

impl ReadCache {
    fn new() -> Self {
        Self { blocks: Vec::new() }
    }

    fn get(&mut self, block_index: u64) -> Option<&[u8]> {
        let position = self
            .blocks
            .iter()
            .position(|b| b.block_index == block_index)?;
        let block = self.blocks.remove(position);
        self.blocks.push(block);
        Some(&self.blocks.last().expect("just pushed").data)
    }

    fn insert(&mut self, block_index: u64, data: Vec<u8>) {
        if self.blocks.len() >= READ_CACHE_MAX_BLOCKS {
            self.blocks.remove(0);
        }
        self.blocks.push(CacheBlock { block_index, data });
    }
}

struct OpfsTempReader {
    pool: Rc<RefCell<Pool>>,
    index: usize,
    len: u64,
    cache: RefCell<ReadCache>,
    timer: OpfsIoTimer,
    read_counters: OpfsReadCounters,
    seq_read_counters: OpfsSeqReadCounters,
}

impl Drop for OpfsTempReader {
    fn drop(&mut self) {
        self.pool.borrow_mut().free.push(self.index);
    }
}

impl OpfsTempReader {
    fn read_opfs_exact(&self, start: u64, buf: &mut [u8]) -> Result<()> {
        let read_start = Instant::now();
        let pool = self.pool.borrow();
        let handle = &pool.handles[self.index];
        let mut read_total = 0usize;
        while read_total < buf.len() {
            let pos = start + read_total as u64;
            let remaining = buf.len() - read_total;
            let n = handle
                .read_with_u8_array_and_options(&mut buf[read_total..], &at(pos))
                .map_err(|e| js_copc_err("OPFS scratch read", e))?;
            let n = check_opfs_len("読み出し", n, pos, remaining, ZeroLength::Error)
                .map_err(Error::InvalidData)?;
            read_total += n;
        }
        drop(pool);
        let elapsed = read_start.elapsed();
        self.timer.record(elapsed);
        self.read_counters.record_miss(buf.len() as u64, elapsed);
        Ok(())
    }
}

impl ScratchReader for OpfsTempReader {
    fn open_at(&self, offset: u64) -> Result<Box<dyn Read + Send>> {
        Ok(Box::new(OpfsSeqReader {
            pool: self.pool.clone(),
            index: self.index,
            pos: offset,
            timer: self.timer.clone(),
            seq_read_counters: self.seq_read_counters.clone(),
        }))
    }

    fn read_at(&self, offset: u64, buf: &mut [u8]) -> Result<()> {
        self.read_counters.record_call();
        let end = offset
            .checked_add(buf.len() as u64)
            .ok_or_else(|| Error::InvalidData("OPFS scratch read offset overflow".into()))?;
        if end > self.len {
            return Err(Error::InvalidData(format!(
                "OPFS scratch read range [{offset}, {end}) exceeds file length {}",
                self.len
            )));
        }
        let mut filled = 0usize;
        while filled < buf.len() {
            let pos = offset + filled as u64;
            let block_index = pos / READ_CACHE_BLOCK_BYTES;
            let block_start = block_index * READ_CACHE_BLOCK_BYTES;
            let block_end = (block_start + READ_CACHE_BLOCK_BYTES).min(self.len);
            let block_len = (block_end - block_start) as usize;
            let in_block_offset = (pos - block_start) as usize;
            let want = (buf.len() - filled).min(block_len - in_block_offset);

            let mut cache = self.cache.borrow_mut();
            if let Some(cached) = cache.get(block_index) {
                self.read_counters.record_hit();
                buf[filled..filled + want]
                    .copy_from_slice(&cached[in_block_offset..in_block_offset + want]);
                filled += want;
                continue;
            }
            drop(cache);

            let mut block_buf = vec![0u8; block_len];
            self.read_opfs_exact(block_start, &mut block_buf)?;
            buf[filled..filled + want]
                .copy_from_slice(&block_buf[in_block_offset..in_block_offset + want]);
            filled += want;
            self.cache.borrow_mut().insert(block_index, block_buf);
        }
        Ok(())
    }

    fn len(&self) -> Result<u64> {
        Ok(self.len)
    }
}

struct OpfsSeqReader {
    pool: Rc<RefCell<Pool>>,
    index: usize,
    pos: u64,
    timer: OpfsIoTimer,
    seq_read_counters: OpfsSeqReadCounters,
}

impl Read for OpfsSeqReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let read_start = Instant::now();
        let n = {
            let pool = self.pool.borrow();
            pool.handles[self.index]
                .read_with_u8_array_and_options(buf, &at(self.pos))
                .map_err(|e| js_io_err("OPFS scratch read", e))?
        };
        let elapsed = read_start.elapsed();
        self.timer.record(elapsed);
        self.seq_read_counters.record(elapsed);
        let n = check_opfs_len("読み出し", n, self.pos, buf.len(), ZeroLength::EndOfFile)
            .map_err(io::Error::other)?;
        self.pos += n as u64;
        Ok(n)
    }
}

struct OpfsOutputWriter {
    handle: FileSystemSyncAccessHandle,
    pos: u64,
    timer: OpfsIoTimer,
}

impl Write for OpfsOutputWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let write_start = Instant::now();
        let written = self
            .handle
            .write_with_u8_array_and_options(buf, &at(self.pos))
            .map_err(|e| js_io_err("OPFS output write", e))?;
        self.timer.record(write_start.elapsed());
        let written = check_opfs_len("書き込み", written, self.pos, buf.len(), ZeroLength::Error)
            .map_err(io::Error::other)?;
        self.pos += written as u64;
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        let flush_start = Instant::now();
        let result = self
            .handle
            .flush()
            .map_err(|e| js_io_err("OPFS output flush", e));
        self.timer.record(flush_start.elapsed());
        result
    }
}

impl Seek for OpfsOutputWriter {
    fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
        self.pos = match pos {
            SeekFrom::Start(p) => p,
            SeekFrom::End(offset) => {
                let get_size_start = Instant::now();
                let size = self
                    .handle
                    .get_size()
                    .map_err(|e| js_io_err("OPFS output get_size", e))?;
                self.timer.record(get_size_start.elapsed());
                apply_offset(size as u64, offset)?
            }
            SeekFrom::Current(offset) => apply_offset(self.pos, offset)?,
        };
        Ok(self.pos)
    }
}

impl ScratchWriter for OpfsOutputWriter {
    fn finish_temp(self: Box<Self>) -> Result<Box<dyn ScratchReader>> {
        Err(Error::InvalidInput(
            "OpfsOutputWriter::finish_tempは呼ばれない想定(create_outputが作った \
             ハンドルはfinish_outputで確定する)"
                .into(),
        ))
    }

    fn finish_output(self: Box<Self>) -> Result<()> {
        let flush_start = Instant::now();
        let result = self
            .handle
            .flush()
            .map_err(|e| js_copc_err("OPFS output finish flush", e));
        self.timer.record(flush_start.elapsed());
        result
    }
}

fn apply_offset(base: u64, offset: i64) -> io::Result<u64> {
    let resolved = base as i64 + offset;
    if resolved < 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "seek position underflowed 0",
        ));
    }
    Ok(resolved as u64)
}

fn resolve_seek(
    pool: &Rc<RefCell<Pool>>,
    index: usize,
    current: u64,
    pos: SeekFrom,
    timer: &OpfsIoTimer,
) -> io::Result<u64> {
    match pos {
        SeekFrom::Start(p) => Ok(p),
        SeekFrom::End(offset) => {
            let get_size_start = Instant::now();
            let size = {
                let pool = pool.borrow();
                pool.handles[index]
                    .get_size()
                    .map_err(|e| js_io_err("OPFS scratch get_size", e))?
            };
            timer.record(get_size_start.elapsed());
            apply_offset(size as u64, offset)
        }
        SeekFrom::Current(offset) => apply_offset(current, offset),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn check_opfs_len_accepts_normal_value() {
        assert_eq!(
            check_opfs_len("書き込み", 1024.0, 0, 1024, ZeroLength::Error),
            Ok(1024)
        );
        assert_eq!(
            check_opfs_len("書き込み", 10.0, 0, 1024, ZeroLength::Error),
            Ok(10)
        );
    }

    #[test]
    fn check_opfs_len_zero_depends_on_zero_length() {
        assert_eq!(
            check_opfs_len("読み出し", 0.0, 5, 16, ZeroLength::EndOfFile),
            Ok(0)
        );
        assert!(check_opfs_len("書き込み", 0.0, 5, 16, ZeroLength::Error).is_err());
    }

    #[test]
    fn check_opfs_len_rejects_larger_than_buffer() {
        assert!(check_opfs_len("書き込み", 1025.0, 0, 1024, ZeroLength::Error).is_err());
    }

    #[test]
    fn check_opfs_len_rejects_2_pow_32_minus_8_with_clear_message() {
        let err =
            check_opfs_len("書き込み", 4294967288.0, 100, 1048576, ZeroLength::Error).unwrap_err();
        assert!(err.contains("4294967288"), "{err}");
        assert!(err.contains("シークレットウィンドウ"), "{err}");
        assert!(err.contains("1048576"), "{err}");
    }

    #[test]
    fn check_opfs_len_rejects_nan_infinite_negative_and_fraction() {
        for raw in [f64::NAN, f64::INFINITY, -8.0, 0.5] {
            assert!(
                check_opfs_len("読み出し", raw, 0, 16, ZeroLength::EndOfFile).is_err(),
                "{raw}"
            );
        }
    }

    #[test]
    fn opfs_io_timer_accumulates_across_clones() {
        let timer = OpfsIoTimer::default();
        assert_eq!(timer.total(), Duration::ZERO);

        timer.record(Duration::from_millis(10));
        let cloned = timer.clone();
        cloned.record(Duration::from_millis(5));

        assert_eq!(timer.total(), Duration::from_millis(15));
        assert_eq!(cloned.total(), Duration::from_millis(15));
    }

    #[test]
    fn opfs_read_counters_accumulate_across_clones() {
        let counters = OpfsReadCounters::default();
        counters.record_call();
        counters.record_call();
        counters.record_hit();
        let cloned = counters.clone();
        cloned.record_call();
        cloned.record_miss(1024, Duration::from_millis(3));

        let stats = counters.snapshot();
        assert_eq!(stats.read_at_calls, 3);
        assert_eq!(stats.cache_hits, 1);
        assert_eq!(stats.cache_misses, 1);
        assert_eq!(stats.bytes_read_from_opfs, 1024);
        assert_eq!(stats.read_time, Duration::from_millis(3));
        assert_eq!(
            cloned.snapshot().read_at_calls,
            3,
            "クローン先からも同じ合計が見える"
        );
    }

    #[test]
    fn opfs_seq_read_counters_accumulate_across_clones() {
        let counters = OpfsSeqReadCounters::default();
        counters.record(Duration::from_micros(200));
        let cloned = counters.clone();
        cloned.record(Duration::from_micros(300));

        let stats = counters.snapshot();
        assert_eq!(stats.seq_read_calls, 2);
        assert_eq!(stats.seq_read_time, Duration::from_micros(500));
        assert_eq!(
            cloned.snapshot().seq_read_calls,
            2,
            "クローン先からも同じ合計が見える"
        );
    }

    #[test]
    fn take_free_pool_slot_returns_clear_error_when_exhausted() {
        let mut free: Vec<usize> = Vec::new();
        let err = take_free_pool_slot(&mut free, 256, "order")
            .expect_err("空のプールから借りようとしたらエラーになるはず");
        let message = err.to_string();
        assert!(
            message.contains("256"),
            "プールのサイズがエラーメッセージに含まれるはず: {message}"
        );
        assert!(
            message.contains("order"),
            "要求元のラベルがエラーメッセージに含まれるはず: {message}"
        );
    }

    #[test]
    fn take_free_pool_slot_succeeds_while_slots_remain() {
        let mut free: Vec<usize> = vec![0, 1, 2];
        assert_eq!(take_free_pool_slot(&mut free, 3, "partition").unwrap(), 2);
        assert_eq!(take_free_pool_slot(&mut free, 3, "partition").unwrap(), 1);
        assert_eq!(take_free_pool_slot(&mut free, 3, "partition").unwrap(), 0);
        assert!(take_free_pool_slot(&mut free, 3, "partition").is_err());
    }

    #[test]
    fn read_cache_returns_cached_block_on_hit() {
        let mut cache = ReadCache::new();
        cache.insert(3, vec![1, 2, 3]);
        assert_eq!(cache.get(3), Some(&[1, 2, 3][..]));
        assert_eq!(cache.get(5), None, "未登録のブロックはNone");
    }

    #[test]
    fn read_cache_evicts_least_recently_used_block_when_full() {
        let mut cache = ReadCache::new();
        for i in 0..READ_CACHE_MAX_BLOCKS as u64 {
            cache.insert(i, vec![i as u8]);
        }
        assert!(cache.get(0).is_some());
        cache.insert(READ_CACHE_MAX_BLOCKS as u64, vec![0xff]);
        assert!(cache.get(0).is_some(), "直前に使ったブロックは残るはず");
        assert!(
            cache.get(1).is_none(),
            "最も使われていなかったブロックは追い出されるはず"
        );
        assert_eq!(
            cache.blocks.len(),
            READ_CACHE_MAX_BLOCKS,
            "上限を超えないはず"
        );
    }

    #[test]
    fn read_cache_never_exceeds_max_blocks_regardless_of_insert_count() {
        let mut cache = ReadCache::new();
        for i in 0..(READ_CACHE_MAX_BLOCKS as u64 * 100) {
            cache.insert(i, vec![0u8; READ_CACHE_BLOCK_BYTES as usize]);
            assert!(cache.blocks.len() <= READ_CACHE_MAX_BLOCKS);
        }
        assert_eq!(cache.blocks.len(), READ_CACHE_MAX_BLOCKS);
    }
}
