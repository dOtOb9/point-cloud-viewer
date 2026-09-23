//! 細々としたヘルパー。

use std::io;
use wasm_bindgen::JsValue;

/// JS側のエラー(`JsValue`)を`std::io::Error`に変換する。
/// `Read`/`Seek`トレイトの実装はエラー型が`io::Error`固定なので、
/// wasm-bindgen呼び出しの失敗(`Result<_, JsValue>`)をここで包み直す。
pub fn js_err_to_io(err: JsValue) -> io::Error {
    let message = js_sys::Error::from(err).message();
    io::Error::other(String::from(message))
}
