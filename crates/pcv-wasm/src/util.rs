use std::io;
use wasm_bindgen::JsValue;

pub fn js_err_to_io(err: JsValue) -> io::Error {
    let message = js_sys::Error::from(err).message();
    io::Error::other(String::from(message))
}
