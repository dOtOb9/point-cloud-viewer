use std::io::{self, Read, Seek, SeekFrom};

use wasm_bindgen::{JsCast, JsValue};
use web_sys::{XmlHttpRequest, XmlHttpRequestResponseType};

use crate::range_math::{
    clamp_range, resolve_seek_from_current, resolve_seek_from_end, resolve_seek_from_start,
};
use crate::stats::BytesReadCounter;
use crate::util::js_err_to_io;

pub struct HttpRangeReader {
    url: String,
    size: u64,
    pos: u64,
    stats: BytesReadCounter,
}

// SAFETY: wasm32-unknown-unknown without atomics is single-threaded, so the `XmlHttpRequest` (a `JsValue`) never crosses threads.
unsafe impl Send for HttpRangeReader {}

impl HttpRangeReader {
    pub fn new(url: String, stats: BytesReadCounter) -> Result<Self, JsValue> {
        let xhr = send_range_request(&url, 0, 0)?;
        let content_range = xhr.get_response_header("Content-Range")?.ok_or_else(|| {
            JsValue::from_str(
                "サーバーがContent-Rangeを返さなかった(Rangeに対応していない可能性がある)",
            )
        })?;
        let size = parse_total_size_from_content_range(&content_range).ok_or_else(|| {
            JsValue::from_str(&format!(
                "Content-Rangeの形式を解釈できなかった: {content_range}"
            ))
        })?;

        Ok(Self {
            url,
            size,
            pos: 0,
            stats,
        })
    }

    pub fn total_size(&self) -> u64 {
        self.size
    }
}

impl Read for HttpRangeReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let (start, end) = clamp_range(self.pos, buf.len() as u64, self.size);
        if start >= end {
            return Ok(0);
        }

        let xhr = send_range_request(&self.url, start, end - 1).map_err(js_err_to_io)?;
        let response = xhr.response().map_err(js_err_to_io)?;
        let array_buffer = response
            .dyn_into::<js_sys::ArrayBuffer>()
            .map_err(|_| io::Error::other("Rangeレスポンスの型がArrayBufferではなかった"))?;
        let array = js_sys::Uint8Array::new(&array_buffer);

        let n = array.length() as usize;
        array.copy_to(&mut buf[..n]);

        self.pos += n as u64;
        self.stats.add(n as u64);
        Ok(n)
    }
}

impl Seek for HttpRangeReader {
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

const SYNCHRONOUS_ONLY_IN_A_WORKER: bool = false;
const HTTP_PARTIAL_CONTENT: u16 = 206;

fn is_a_range_response_and_not_the_whole_file(status: u16) -> bool {
    status == HTTP_PARTIAL_CONTENT
}

fn send_range_request(
    url: &str,
    start: u64,
    last_byte_inclusive: u64,
) -> Result<XmlHttpRequest, JsValue> {
    let xhr = XmlHttpRequest::new()?;
    xhr.open_with_async("GET", url, SYNCHRONOUS_ONLY_IN_A_WORKER)?;
    xhr.set_response_type(XmlHttpRequestResponseType::Arraybuffer);
    xhr.set_request_header("Range", &format!("bytes={start}-{last_byte_inclusive}"))?;
    xhr.send()?;

    let status = xhr.status()?;
    if !is_a_range_response_and_not_the_whole_file(status) {
        return Err(JsValue::from_str(&format!(
            "Rangeリクエストが206を返さなかった(status={status}, url={url})。\
             サーバーがHTTP Rangeに対応していないか、CORSでブロックされている可能性がある"
        )));
    }
    Ok(xhr)
}

fn parse_total_size_from_content_range(header: &str) -> Option<u64> {
    let total = header.rsplit('/').next()?;
    total.trim().parse::<u64>().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_total_size_from_well_formed_header() {
        assert_eq!(
            parse_total_size_from_content_range("bytes 0-0/12345"),
            Some(12345)
        );
    }

    #[test]
    fn parses_total_size_for_large_files() {
        assert_eq!(
            parse_total_size_from_content_range("bytes 0-0/2180000000"),
            Some(2_180_000_000)
        );
    }

    #[test]
    fn rejects_malformed_header() {
        assert_eq!(
            parse_total_size_from_content_range("not-a-content-range"),
            None
        );
        assert_eq!(parse_total_size_from_content_range(""), None);
    }

    #[test]
    fn a_200_that_ignored_the_range_header_is_rejected_so_the_whole_file_is_never_read() {
        assert!(is_a_range_response_and_not_the_whole_file(206));
        assert!(!is_a_range_response_and_not_the_whole_file(200));
    }
}
