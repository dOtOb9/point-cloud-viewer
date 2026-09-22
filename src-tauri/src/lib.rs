// M0 の計測用コマンド・プロトコルをここに置く。GUI を目視しなくても
// `npm run tauri dev` の標準出力から判断できるよう、フロントの計測結果はここで println! する。

/// フロントの診断メッセージ（WebGPU プローブ結果、IPCベンチ結果など）を標準出力に出す。
/// ADR-0001 の規約通り、これは制御メッセージであり、大きいデータはここを通さない。
#[tauri::command]
fn report_diagnostic(message: String) {
    println!("[frontend] {message}");
}

/// M0-3: `invoke` 経由でのスループット比較用。指定バイト数のダミーデータを返す。
/// serde によって JSON の数値配列にシリアライズされるため、サイズが大きいと
/// カスタムプロトコル（`pcv://`）に比べて著しく遅くなることを確認するためのコマンド。
#[tauri::command]
fn bench_invoke(size: usize) -> Vec<u8> {
    vec![0u8; size]
}

/// M0-3: `pcv://<size>`（Windows/Androidでは `http://pcv.localhost/<size>`）に
/// アクセスすると、指定バイト数のダミーデータを `application/octet-stream` で返す。
/// JSON を経由しないため、`invoke` より速いはず、というADR-0001の前提を検証するためのハンドラ。
///
/// フロントは `convertFileSrc` でURLを組み立てる。この関数はパス全体を
/// `encodeURIComponent` で1セグメントとしてエンコードするため、パスに `/` を含めず
/// サイズの数値だけを渡す（`/bench/<size>` のような複数セグメントにしない）。
fn handle_pcv_protocol(
    _ctx: tauri::UriSchemeContext<'_, tauri::Wry>,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    let path = request.uri().path();

    let size = path.strip_prefix('/').and_then(|s| s.parse::<usize>().ok());

    // 開発時は devUrl (http://localhost:1420) からの fetch になり、pcv:// とは
    // オリジンが異なるため、CORS ヘッダが無いと "Failed to fetch" になる。
    // (tauri::app::register_uri_scheme_protocol のドキュメント参照)
    match size {
        Some(size) => tauri::http::Response::builder()
            .status(tauri::http::StatusCode::OK)
            .header(
                tauri::http::header::CONTENT_TYPE,
                "application/octet-stream",
            )
            .header(tauri::http::header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .body(vec![0u8; size])
            .unwrap(),
        None => tauri::http::Response::builder()
            .status(tauri::http::StatusCode::BAD_REQUEST)
            .header(tauri::http::header::CONTENT_TYPE, "text/plain")
            .header(tauri::http::header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .body(b"unknown pcv:// path (expected /<size>)".to_vec())
            .unwrap(),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .register_uri_scheme_protocol("pcv", handle_pcv_protocol)
        .invoke_handler(tauri::generate_handler![report_diagnostic, bench_invoke])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
