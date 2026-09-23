//! pcv-core を Web Worker から呼べるようにする wasm-bindgen 層。
//!
//! wasm固有の依存(wasm-bindgen/js-sys/web-sys)はこのクレートに閉じ、
//! `pcv-core`自体には持ち込まない(ARCHITECTURE.md規約1)。設計の経緯・
//! 検討した代替案は `TaskSheets/ADR-0012-web-worker-sync-io.md` を参照。
//!
//! ## 全体の流れ
//!
//! `WasmCopcFile::open_file`(ローカルファイル)/`open_url`(HTTP)で
//! `pcv_core::CopcFile`を開き、以降は`info()`/`hierarchy()`/`read_node()`を
//! `src/datasource/web.ts`のWorker(`src/datasource/copc.worker.ts`)から呼ぶ。
//! ローカルファイルとURLは、どちらも`Read + Seek + Send`を実装する型
//! (`file_reader::FileRangeReader` / `http_reader::HttpRangeReader`)にして
//! `Box<dyn ReadSeek>`に型消去することで、`WasmCopcFile`という1つの型で
//! 両方を扱えるようにしている。

mod dto;
mod file_reader;
mod http_reader;
mod range_math;
mod stats;
mod util;

use std::io::{Read, Seek};

use file_reader::FileRangeReader;
use http_reader::HttpRangeReader;
use stats::Stats;
use wasm_bindgen::prelude::*;
use web_sys::File;

/// `pcv_core::CopcFile<R>`の`R: Read + Seek + Send`を満たす、型消去した入力源。
/// `ReadSeek: Read + Seek + Send`と宣言してあるので、`dyn ReadSeek`自体が
/// `Read`・`Seek`・`Send`を実装する(スーパートレイトはトレイトオブジェクトに
/// そのまま伝播する。`Box<dyn ReadSeek>`は標準ライブラリの
/// `impl<R: Read + ?Sized> Read for Box<R>`等を通じて`Read + Seek`になり、
/// `Send`も同様にトレイトオブジェクトへ伝播する)。
trait ReadSeek: Read + Seek + Send {}
impl<T: Read + Seek + Send> ReadSeek for T {}

fn to_js_error<E: std::fmt::Display>(err: E) -> JsValue {
    JsValue::from_str(&err.to_string())
}

/// 開いたCOPCファイル。ローカルファイル(`openFile`)かURL(`openUrl`)かは
/// 内部の`Box<dyn ReadSeek>`にしまってあるので、以降のメソッドは区別しない。
#[wasm_bindgen]
pub struct WasmCopcFile {
    inner: pcv_core::CopcFile<Box<dyn ReadSeek>>,
    stats: Stats,
    /// 元の入力(ファイル/URL)の全体バイト数。`Box<dyn ReadSeek>`に包む前の
    /// 具体型から一度だけ取り出しておく(包んだ後は型消去されて取れないため)。
    total_size: u64,
}

#[wasm_bindgen]
impl WasmCopcFile {
    /// `<input type="file">`やドラッグ&ドロップで得た`File`を開く。
    /// `FileReaderSync`を使うため、この呼び出し自体もWorker内でしか動かない。
    #[wasm_bindgen(js_name = openFile)]
    pub fn open_file(file: File) -> Result<WasmCopcFile, JsValue> {
        let stats = Stats::new();
        let reader = FileRangeReader::new(file, stats.clone());
        let total_size = reader.total_size();
        let inner = pcv_core::CopcFile::from_reader(Box::new(reader) as Box<dyn ReadSeek>)
            .map_err(to_js_error)?;
        Ok(Self {
            inner,
            stats,
            total_size,
        })
    }

    /// CORSとHTTP Rangeに対応したURLを開く。対応していないサーバーの場合は
    /// 最初のRangeプローブの時点でエラーになる(`http_reader::HttpRangeReader::new`参照)。
    #[wasm_bindgen(js_name = openUrl)]
    pub fn open_url(url: String) -> Result<WasmCopcFile, JsValue> {
        let stats = Stats::new();
        let reader = HttpRangeReader::new(url, stats.clone())?;
        let total_size = reader.total_size();
        let inner = pcv_core::CopcFile::from_reader(Box::new(reader) as Box<dyn ReadSeek>)
            .map_err(to_js_error)?;
        Ok(Self {
            inner,
            stats,
            total_size,
        })
    }

    /// 点群全体の情報(`src/datasource/copc-dto.ts`の`CloudInfoDto`と同じ形)。
    pub fn info(&self) -> Result<JsValue, JsValue> {
        let dto = dto::CloudInfoDto::from(self.inner.info());
        serde_wasm_bindgen::to_value(&dto).map_err(to_js_error)
    }

    /// octreeのノード一覧(`HierarchyNodeDto`の配列)。
    pub fn hierarchy(&self) -> Result<JsValue, JsValue> {
        let nodes: Vec<dto::HierarchyNodeDto> = self
            .inner
            .hierarchy()
            .nodes()
            .map(dto::HierarchyNodeDto::from)
            .collect();
        serde_wasm_bindgen::to_value(&nodes).map_err(to_js_error)
    }

    /// 指定ノードの点データを読み、`src/datasource/node-format.ts`が読める
    /// バイト列(M1-2の形式)を返す。`Vec<u8>`はwasm-bindgen越しに`Uint8Array`になる。
    #[wasm_bindgen(js_name = readNode)]
    pub fn read_node(&mut self, key: String) -> Result<Vec<u8>, JsValue> {
        let key: pcv_core::NodeKey = key.parse().map_err(|e: String| JsValue::from_str(&e))?;
        let buf = self.inner.read_node(key).map_err(to_js_error)?;
        Ok(buf.bytes)
    }

    /// これまでにJS側へ渡したバイト数の合計。ファイルサイズと比べることで
    /// 「ファイル全体を読んでいないこと」を確認できる(受け入れ条件)。
    #[wasm_bindgen(js_name = bytesRead)]
    pub fn bytes_read(&self) -> f64 {
        // JSのNumberはf64なので、ここでu64→f64に変換する。2^53を超えるまでは
        // 誤差なく表現できる(8PB相当なので、統計表示用途には十分)。
        self.stats.total() as f64
    }

    /// 元のファイル/URL全体のバイト数。`bytesRead()`と比べることで
    /// 「ファイル全体を読んでいないこと」を確認できる(受け入れ条件)。
    #[wasm_bindgen(js_name = totalSize)]
    pub fn total_size(&self) -> f64 {
        self.total_size as f64
    }
}

/// Worker起動時に一度だけ呼ぶ。パニック時にブラウザのconsoleへ理由を出す
/// (GUIを目視できない開発フローでも、devtoolsのconsoleでwasm側の異常が
/// 追えるようにするため。標準の`std::panic`フックをそのまま`console.error`に
/// 繋ぐだけで、専用クレート(`console_error_panic_hook`)は増やしていない)。
#[wasm_bindgen(start)]
pub fn init_panic_hook() {
    std::panic::set_hook(Box::new(|info| {
        web_sys::console::error_1(&JsValue::from_str(&info.to_string()));
    }));
}
