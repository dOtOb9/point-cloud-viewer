// M0 の計測用コマンド・プロトコルをここに置く。GUI を目視しなくても
// `npm run tauri dev` の標準出力から判断できるよう、フロントの計測結果はここで println! する。
//
// M1-2以降: COPCノードの配信もここに置く（`copc_state`モジュール）。src-tauriは薄く保ち、
// COPCのパースやノードのバイナリエンコードは全て `pcv-core` に任せる（ARCHITECTURE.md参照）。

mod copc_state;

use copc_state::CopcState;
use tauri::Manager;

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

/// `pcv://<path>` の1セグメントを見て、M0のベンチ用ダミーデータ（`/<size>`）か
/// M1のノードデータ（`/<level>-<x>-<y>-<z>`）かを振り分ける。
///
/// フロントは `convertFileSrc` でURLを組み立てる。この関数はパス全体を
/// `encodeURIComponent` で1セグメントとしてエンコードするため、パスに `/` を含めず
/// 数値やダッシュ区切りの文字列だけを渡す（`/node/<key>` のような複数セグメントにしない。
/// M1-point-rendering.md 参照）。
fn handle_pcv_protocol(
    ctx: tauri::UriSchemeContext<'_, tauri::Wry>,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    let path = request.uri().path();
    let segment = path.strip_prefix('/').unwrap_or(path);

    if let Ok(size) = segment.parse::<usize>() {
        return octet_stream_response(vec![0u8; size]);
    }

    if let Ok(key) = segment.parse::<pcv_core::NodeKey>() {
        let state = ctx.app_handle().state::<CopcState>();
        return match copc_state::read_node_bytes(&state, key) {
            Ok(bytes) => octet_stream_response(bytes),
            Err(message) => {
                eprintln!("[pcv] failed to serve node {key}: {message}");
                bad_request_response(&message)
            }
        };
    }

    bad_request_response(&format!(
        "unknown pcv:// path (expected /<size> or /<level>-<x>-<y>-<z>): {segment}"
    ))
}

/// 開発時は devUrl (http://localhost:1420) からの fetch になり、pcv:// とは
/// オリジンが異なるため、CORS ヘッダが無いと "Failed to fetch" になる。
/// (tauri::app::register_uri_scheme_protocol のドキュメント参照)
fn octet_stream_response(body: Vec<u8>) -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(tauri::http::StatusCode::OK)
        .header(
            tauri::http::header::CONTENT_TYPE,
            "application/octet-stream",
        )
        .header(tauri::http::header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(body)
        .unwrap()
}

fn bad_request_response(message: &str) -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(tauri::http::StatusCode::BAD_REQUEST)
        .header(tauri::http::header::CONTENT_TYPE, "text/plain")
        .header(tauri::http::header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(message.as_bytes().to_vec())
        .unwrap()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(CopcState::default())
        .register_uri_scheme_protocol("pcv", handle_pcv_protocol)
        .invoke_handler(tauri::generate_handler![
            report_diagnostic,
            bench_invoke,
            copc_state::open_copc
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
