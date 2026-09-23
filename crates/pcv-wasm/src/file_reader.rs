//! ローカルファイル(`File`)を、読んだ範囲だけ取り出す`Read + Seek`にする。
//!
//! `FileReaderSync::read_as_array_buffer`はWeb Worker専用のAPI(メインスレッドには
//! 存在しない)で、名前の通り**同期的に**Blobを読める。`File.slice(start, end)`で
//! 欲しい範囲だけを指すBlobを作ってから同期読みすることで、ファイル全体を
//! メモリに載せずに済む(TaskSheets/ADR-0012-web-worker-sync-io.md 参照)。

use std::io::{self, Read, Seek, SeekFrom};

use web_sys::{File, FileReaderSync};

use crate::range_math::{
    clamp_range, resolve_seek_from_current, resolve_seek_from_end, resolve_seek_from_start,
};
use crate::stats::Stats;
use crate::util::js_err_to_io;

pub struct FileRangeReader {
    file: File,
    size: u64,
    pos: u64,
    stats: Stats,
}

// `File`は内部でJSオブジェクトへの参照(`JsValue`)を持つため、コンパイラは自動では
// `Send`と認めない。wasm32-unknown-unknown はatomics抜きでは実際にはスレッドを
// またがない(このWorker1本の中で`FileRangeReader`が生成・使用・破棄される)ため、
// ここでの`Send`はコンパイル上の形式要件(`pcv_core::CopcFile<R>`が`R: Send`を
// 要求している。ネイティブ版でスレッドプールに`CopcFile`を渡す設計と型を
// 揃えるため)を満たすためのものであり、実際にスレッド間で共有されることはない。
unsafe impl Send for FileRangeReader {}

impl FileRangeReader {
    pub fn new(file: File, stats: Stats) -> Self {
        let size = file.size() as u64;
        Self {
            file,
            size,
            pos: 0,
            stats,
        }
    }

    /// ファイル全体のバイト数。「全体を読んでいないこと」の確認に使う
    /// (`WasmCopcFile::total_size`参照)。
    pub fn total_size(&self) -> u64 {
        self.size
    }
}

impl Read for FileRangeReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let (start, end) = clamp_range(self.pos, buf.len() as u64, self.size);
        if start >= end {
            return Ok(0);
        }

        let blob = self
            .file
            .slice_with_f64_and_f64(start as f64, end as f64)
            .map_err(js_err_to_io)?;
        let reader = FileReaderSync::new().map_err(js_err_to_io)?;
        let array_buffer = reader.read_as_array_buffer(&blob).map_err(js_err_to_io)?;
        let array = js_sys::Uint8Array::new(&array_buffer);

        let n = array.length() as usize;
        array.copy_to(&mut buf[..n]);

        self.pos += n as u64;
        self.stats.add(n as u64);
        Ok(n)
    }
}

impl Seek for FileRangeReader {
    fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
        let resolved = match pos {
            SeekFrom::Start(p) => resolve_seek_from_start(p as i64),
            SeekFrom::End(offset) => resolve_seek_from_end(self.size, offset),
            SeekFrom::Current(offset) => resolve_seek_from_current(self.pos, offset),
        };
        let resolved = resolved.ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "seek position underflowed 0")
        })?;
        self.pos = resolved;
        Ok(self.pos)
    }
}
