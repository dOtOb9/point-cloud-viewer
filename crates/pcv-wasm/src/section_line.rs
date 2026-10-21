//! G2-4: Web version of the section line (the ground line of a cross section, from a local CSF surface).
//!
//! The work is `pcv_core::section_line::SectionLineJob`, the same as on desktop. A Worker cannot be
//! told to stop while a long call runs, so the job is run in small steps: the Worker calls `advance`
//! repeatedly and yields to the event loop between calls (a cancel message is handled there), exactly
//! like `WasmExtractor::feed`.
//!
//! The job reads the points from an open `WasmCopcFile` (the SOURCE layer), which is passed to every call.

use pcv_core::profile::SectionLine;
use pcv_core::section_line::{SectionLineJob, SectionLineRequest, DEFAULT_SECTION_LINE_CELL_CAP};
use wasm_bindgen::prelude::*;

use crate::{to_js_error, WasmCopcFile};

#[wasm_bindgen]
pub struct WasmSectionLine {
    /// `None` once `finish` has consumed it.
    job: Option<SectionLineJob>,
    done: bool,
}

#[wasm_bindgen]
impl WasmSectionLine {
    /// `line` is the `SectionLine` JSON (a, b, up) and `request` the `SectionLineRequest` JSON
    /// (preset, corridorHalfWidth, clothResolution). Lengths are in the file's unit.
    #[wasm_bindgen(constructor)]
    pub fn new(
        file: &WasmCopcFile,
        line: JsValue,
        request: JsValue,
    ) -> Result<WasmSectionLine, JsValue> {
        let line: SectionLine = serde_wasm_bindgen::from_value(line)
            .map_err(|e| JsValue::from_str(&format!("断面の指定が正しくありません: {e}")))?;
        let request: SectionLineRequest = serde_wasm_bindgen::from_value(request)
            .map_err(|e| JsValue::from_str(&format!("断面線の指定が正しくありません: {e}")))?;
        let params = request.to_params(DEFAULT_SECTION_LINE_CELL_CAP);
        let job = SectionLineJob::new(&file.inner, &line, &params).map_err(to_js_error)?;
        Ok(Self {
            job: Some(job),
            done: false,
        })
    }

    /// Does a small piece of work and returns the progress (0 to 1). When `isDone()` is true, call `finish`.
    pub fn advance(&mut self, file: &mut WasmCopcFile) -> Result<f32, JsValue> {
        let job = self
            .job
            .as_mut()
            .ok_or_else(|| JsValue::from_str("advanceはfinishの後には呼べない"))?;
        let progress = job.advance(&mut file.inner).map_err(to_js_error)?;
        self.done = progress.done;
        Ok(progress.fraction)
    }

    #[wasm_bindgen(js_name = isDone)]
    pub fn is_done(&self) -> bool {
        self.done
    }

    /// Builds the TIN and returns the result buffer described in `crates/pcv-core/src/section_line.rs`.
    pub fn finish(&mut self) -> Result<Vec<u8>, JsValue> {
        let job = self
            .job
            .take()
            .ok_or_else(|| JsValue::from_str("finishは既に呼ばれている"))?;
        job.finish().map_err(to_js_error)
    }
}
