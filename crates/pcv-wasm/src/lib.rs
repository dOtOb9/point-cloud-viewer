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

mod alloc_guard;
mod convert;
mod dto;
mod e57_import;
mod extract;
mod file_reader;
mod http_reader;
mod opfs;
mod pcd_import;
mod ply_import;
mod point_file_import;
mod point_merge;
// --- G1: rasterize ---
mod raster;
// ---
mod range_math;
// --- G2: section line ---
mod section_line;
// ---
mod stats;
// --- G3: thinning and outlier filters ---
mod thin_filter;
// ---
mod util;
mod write_metadata;

use std::io::{Read, Seek};

use file_reader::FileRangeReader;
use http_reader::HttpRangeReader;
use stats::Stats;
use wasm_bindgen::prelude::*;
use web_sys::File;

// M4-6b: Web版の変換(WasmConverter)。`src/datasource/copc.worker.ts`が使う。
pub use convert::WasmConverter;
// L2-C: Web extraction (point selection, cross section). Used by `src/datasource/copc.worker.ts`.
pub use extract::WasmExtractor;
// --- G1: rasterize --- Web rasterization (the Rasterize tool). Used by `src/datasource/copc.worker.ts`.
pub use raster::{WasmRasterPreview, WasmRasterizer};
// ---
// R7 / M4-17: Web PLY / PCD / E57 (and mixed LAS) to COPC conversion, one or several files. Used by `src/datasource/copc.worker.ts`.
pub use point_file_import::WasmPointFileConverter;
// --- G2: section line --- Web version of the section line. Used by `src/datasource/copc.worker.ts`.
pub use section_line::WasmSectionLine;
// ---
// --- G3: thinning and outlier filters --- Web thinning / ROR / SOR. Used by `src/datasource/copc.worker.ts`.
pub use thin_filter::WasmThinFilter;
// ---

/// 2026-10-07追記: 直前にメモリ確保の失敗(`alloc_guard.rs`)が起きていれば
/// そのメッセージを返す。`src/datasource/copc.worker.ts`が変換失敗の
/// catchブロックで呼び、`unreachable`トラップしか伝わらないエラーメッセージに
/// この詳細を足して画面にも出す(`alloc_guard.rs`のドキュメント参照)。
#[wasm_bindgen(js_name = lastAllocationFailureMessage)]
pub fn last_allocation_failure_message() -> Option<String> {
    alloc_guard::last_allocation_failure_message()
}

/// `opfs.rs`の`OPFS_SCRATCH_POOL_SIZE`をJS側にも公開する。TypeScript側
/// (`src/datasource/opfs.ts`)が事前に開くOPFS一時ファイルの個数を、この値と
/// 二重管理せずに揃えるため(値がずれると「Rustは600個用意されている前提で
/// 動くのにTS側は別の数しか開いていない」という食い違いが起きる)。
#[wasm_bindgen(js_name = opfsScratchPoolSize)]
pub fn opfs_scratch_pool_size() -> u32 {
    opfs::OPFS_SCRATCH_POOL_SIZE as u32
}

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

    // --- G2: cross-section view ---
    /// Reads the whole file as `(s, z)` points of a cross section (`pcv_core::profile`).
    /// `line` is the `SectionLine` JSON (a, b, up); `cap` 0 means the default. The result is the binary
    /// buffer described in `crates/pcv-core/src/profile.rs` (at most 24 bytes + cap * 12 bytes).
    #[wasm_bindgen(js_name = readSectionProfile)]
    pub fn read_section_profile(&mut self, line: JsValue, cap: u32) -> Result<Vec<u8>, JsValue> {
        let line: pcv_core::profile::SectionLine = serde_wasm_bindgen::from_value(line)
            .map_err(|e| JsValue::from_str(&format!("断面の指定が正しくありません: {e}")))?;
        pcv_core::profile::read_section_profile(&mut self.inner, &line, cap as usize)
            .map_err(to_js_error)
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
///
/// `#[wasm_bindgen(start)]`により、`init()`が解決した時点でwasm-bindgenの
/// 生成コードが自動的に1回呼ぶ(`src/datasource/copc.worker.ts`の
/// `ensureWasmReady`も、実装を追いやすくするため明示的にもう一度呼んでいる。
/// 副作用はない)。
///
/// **メモリ確保の失敗はこのpanicフックを経由しない**(`std::alloc`は
/// 確保失敗時にpanicせず`handle_alloc_error`→`unreachable`で即座にトラップ
/// するため)。そちらは`alloc_guard.rs`の`#[global_allocator]`が別途検知する。
#[wasm_bindgen(start)]
pub fn init_panic_hook() {
    std::panic::set_hook(Box::new(|info| {
        web_sys::console::error_1(&JsValue::from_str(&info.to_string()));
    }));
}
