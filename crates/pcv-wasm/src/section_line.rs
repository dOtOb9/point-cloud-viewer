use pcv_core::profile::SectionLine;
use pcv_core::section_line::{SectionLineJob, SectionLineRequest, DEFAULT_SECTION_LINE_CELL_CAP};
use wasm_bindgen::prelude::*;

use crate::{to_js_error, WasmCopcFile};

#[wasm_bindgen]
pub struct WasmSectionLine {
    job: Option<SectionLineJob>,
    done: bool,
}

#[wasm_bindgen]
impl WasmSectionLine {
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

    pub fn finish(&mut self) -> Result<Vec<u8>, JsValue> {
        let job = self
            .job
            .take()
            .ok_or_else(|| JsValue::from_str("finishは既に呼ばれている"))?;
        job.finish().map_err(to_js_error)
    }
}
