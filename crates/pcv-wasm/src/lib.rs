mod alloc_guard;
mod convert;
mod dtm;
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
mod range_math;
mod raster;
mod section_line;
mod stats;
mod thin_filter;
mod util;
mod write_metadata;

use std::io::{Read, Seek};

use file_reader::FileRangeReader;
use http_reader::HttpRangeReader;
use stats::BytesReadCounter;
use wasm_bindgen::prelude::*;
use web_sys::File;

pub use convert::WasmConverter;
pub use dtm::WasmDtm;
pub use extract::WasmExtractor;
pub use point_file_import::WasmPointFileConverter;
pub use raster::{WasmRasterPreview, WasmRasterizer};
pub use section_line::WasmSectionLine;
pub use thin_filter::WasmThinFilter;

#[wasm_bindgen(js_name = lastAllocationFailureMessage)]
pub fn last_allocation_failure_message() -> Option<String> {
    alloc_guard::last_allocation_failure_message()
}

#[wasm_bindgen(js_name = opfsScratchPoolSize)]
pub fn opfs_scratch_pool_size() -> u32 {
    opfs::OPFS_SCRATCH_POOL_SIZE as u32
}

trait ReadSeek: Read + Seek + Send {}
impl<T: Read + Seek + Send> ReadSeek for T {}

fn to_js_error<E: std::fmt::Display>(err: E) -> JsValue {
    JsValue::from_str(&err.to_string())
}

#[wasm_bindgen]
pub struct WasmCopcFile {
    inner: pcv_core::CopcFile<Box<dyn ReadSeek>>,
    stats: BytesReadCounter,
    total_size: u64,
}

#[wasm_bindgen]
impl WasmCopcFile {
    #[wasm_bindgen(js_name = openFile)]
    pub fn open_file(file: File) -> Result<WasmCopcFile, JsValue> {
        let stats = BytesReadCounter::new();
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

    #[wasm_bindgen(js_name = openUrl)]
    pub fn open_url(url: String) -> Result<WasmCopcFile, JsValue> {
        let stats = BytesReadCounter::new();
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

    pub fn info(&self) -> Result<JsValue, JsValue> {
        let dto = dto::CloudInfoDto::from(self.inner.info());
        serde_wasm_bindgen::to_value(&dto).map_err(to_js_error)
    }

    pub fn hierarchy(&self) -> Result<JsValue, JsValue> {
        let nodes: Vec<dto::HierarchyNodeDto> = self
            .inner
            .hierarchy()
            .nodes()
            .map(dto::HierarchyNodeDto::from)
            .collect();
        serde_wasm_bindgen::to_value(&nodes).map_err(to_js_error)
    }

    #[wasm_bindgen(js_name = readNode)]
    pub fn read_node(&mut self, key: String) -> Result<Vec<u8>, JsValue> {
        let key: pcv_core::NodeKey = key.parse().map_err(|e: String| JsValue::from_str(&e))?;
        let buf = self.inner.read_node(key).map_err(to_js_error)?;
        Ok(buf.bytes)
    }

    #[wasm_bindgen(js_name = readSectionProfile)]
    pub fn read_section_profile(&mut self, line: JsValue, cap: u32) -> Result<Vec<u8>, JsValue> {
        let line: pcv_core::profile::SectionLine = serde_wasm_bindgen::from_value(line)
            .map_err(|e| JsValue::from_str(&format!("断面の指定が正しくありません: {e}")))?;
        pcv_core::profile::read_section_profile(&mut self.inner, &line, cap as usize)
            .map_err(to_js_error)
    }

    #[wasm_bindgen(js_name = bytesRead)]
    pub fn bytes_read(&self) -> f64 {
        self.stats.total() as f64
    }

    #[wasm_bindgen(js_name = totalSize)]
    pub fn total_size(&self) -> f64 {
        self.total_size as f64
    }
}

#[wasm_bindgen(start)]
pub fn init_panic_hook() {
    std::panic::set_hook(Box::new(|info| {
        web_sys::console::error_1(&JsValue::from_str(&info.to_string()));
    }));
}
