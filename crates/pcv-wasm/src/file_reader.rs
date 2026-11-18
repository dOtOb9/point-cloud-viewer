use std::io::{self, Read, Seek, SeekFrom};

use web_sys::{File, FileReaderSync};

use crate::range_math::{
    clamp_range, resolve_seek_from_current, resolve_seek_from_end, resolve_seek_from_start,
};
use crate::stats::BytesReadCounter;
use crate::util::js_err_to_io;

pub struct FileRangeReader {
    file: File,
    size: u64,
    pos: u64,
    stats: BytesReadCounter,
}

// SAFETY: wasm32-unknown-unknown without atomics is single-threaded, so the `File` (a `JsValue`) never crosses threads; `Send` only satisfies `CopcFile<R: Send>`.
unsafe impl Send for FileRangeReader {}
// SAFETY: same as `Send` above; `las::Reader::new` requires `R: Sync`.
unsafe impl Sync for FileRangeReader {}

impl FileRangeReader {
    pub fn new(file: File, stats: BytesReadCounter) -> Self {
        let size = file.size() as u64;
        Self {
            file,
            size,
            pos: 0,
            stats,
        }
    }

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
