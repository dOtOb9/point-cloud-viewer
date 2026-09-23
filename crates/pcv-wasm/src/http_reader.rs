//! URL越しのCOPCファイルを、HTTP Rangeリクエストで範囲読みする`Read + Seek`。
//!
//! `XMLHttpRequest`は第3引数(`async`)に`false`を渡すと**同期的に**動く
//! （Worker内でのみ許可されている。メインスレッドで使うと非推奨警告と共に
//! ブロッキングする)。`fetch`は常に非同期なので使えない
//! (TaskSheets/ADR-0012-web-worker-sync-io.md「なぜfetchではないか」参照)。
//!
//! サーバーがRangeヘッダとCORSに対応している必要がある。対応していない場合は
//! `HttpRangeReader::new`がエラーを返す(全体を読みにいくフォールバックはしない。
//! 2GB級のファイルで全体取得は破綻するため、原則どおり拒否する)。

use std::io::{self, Read, Seek, SeekFrom};

use wasm_bindgen::{JsCast, JsValue};
use web_sys::{XmlHttpRequest, XmlHttpRequestResponseType};

use crate::range_math::{
    clamp_range, resolve_seek_from_current, resolve_seek_from_end, resolve_seek_from_start,
};
use crate::stats::Stats;
use crate::util::js_err_to_io;

pub struct HttpRangeReader {
    url: String,
    size: u64,
    pos: u64,
    stats: Stats,
}

// FileRangeReaderと同じ理由(`unsafe impl Send`のコメント参照): wasm32はシングル
// スレッドで、`XmlHttpRequest`(JsValueを内部に持つ)を実際にスレッド間で
// 共有することはない。
unsafe impl Send for HttpRangeReader {}

impl HttpRangeReader {
    /// `bytes=0-0`のRangeリクエストを1回投げ、`Content-Range`レスポンスヘッダから
    /// ファイル全体のサイズを得る。これ自体も1バイトしか取得しないので、
    /// 「ファイル全体を読まない」という制約に沿っている。
    pub fn new(url: String, stats: Stats) -> Result<Self, JsValue> {
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

    /// ファイル全体のバイト数(`Content-Range`から得た値)。
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

        // Rangeは両端inclusiveなので、半開区間[start, end)の最後の1バイト手前を指定する。
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

/// 同期`XMLHttpRequest`で`Range: bytes=start-end`(両端inclusive)を送る。
fn send_range_request(url: &str, start: u64, end: u64) -> Result<XmlHttpRequest, JsValue> {
    let xhr = XmlHttpRequest::new()?;
    // 第3引数 false = 同期。Worker内でのみ許可される。
    xhr.open_with_async("GET", url, false)?;
    xhr.set_response_type(XmlHttpRequestResponseType::Arraybuffer);
    xhr.set_request_header("Range", &format!("bytes={start}-{end}"))?;
    xhr.send()?;

    let status = xhr.status()?;
    // 206 = Partial Content(正常なRange応答)。200はサーバーがRangeを無視して
    // 全体を返してきた場合で、これも許容してしまうと「全体を読まない」という
    // 制約が崩れるため、206だけを成功として扱う。
    if status != 206 {
        return Err(JsValue::from_str(&format!(
            "Rangeリクエストが206を返さなかった(status={status}, url={url})。\
             サーバーがHTTP Rangeに対応していないか、CORSでブロックされている可能性がある"
        )));
    }
    Ok(xhr)
}

/// `"bytes 0-0/12345"`形式の`Content-Range`ヘッダから、末尾の全体サイズを取り出す。
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
        // sofi.copc.laz相当(2.03GB)でu64パースが破綻しないことの確認。
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
}
