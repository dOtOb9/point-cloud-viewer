// M0 の計測用コマンドをここに置く。GUI を目視しなくても `npm run tauri dev` の標準出力から
// 判断できるよう、フロントの計測結果はここで println! する。

/// フロントの診断メッセージ（WebGPU プローブ結果など）を標準出力に出す。
/// ADR-0001 の規約通り、これは制御メッセージであり、大きいデータはここを通さない。
#[tauri::command]
fn report_diagnostic(message: String) {
    println!("[frontend] {message}");
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![report_diagnostic])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
