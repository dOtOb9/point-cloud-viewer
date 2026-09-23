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

/// M2: `pcv://` 並行リクエストの計測ハーネス（`useNodeConcurrencyBench`）用。
/// `TaskSheets/TEST-DATA.md` のテストデータはリポジトリにコミットしないため
/// （`.gitignore`済み、CIには無い）、`data/<filename>` を実行時に探して絶対パスを返す。
/// 見つからなければ `None`（呼び出し側はベンチをスキップする）。
///
/// `env!("CARGO_MANIFEST_DIR")` はこのクレート（`src-tauri`）のディレクトリに
/// 展開されるコンパイル時定数なので、`npm run tauri dev` を実行するカレント
/// ディレクトリが何であっても同じ場所（リポジトリ直下の `data/`）を指す。
#[tauri::command]
fn default_bench_data_path(filename: String) -> Option<String> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("data")
        .join(&filename);
    if path.is_file() {
        path.to_str().map(str::to_string)
    } else {
        None
    }
}

/// `pcv://<path>` の1セグメントを見て、M0のベンチ用ダミーデータ（`/<size>`）か
/// M1のノードデータ（`/<level>-<x>-<y>-<z>`）かを振り分ける。
///
/// フロントは `convertFileSrc` でURLを組み立てる。この関数はパス全体を
/// `encodeURIComponent` で1セグメントとしてエンコードするため、パスに `/` を含めず
/// 数値やダッシュ区切りの文字列だけを渡す（`/node/<key>` のような複数セグメントにしない。
/// M1-point-rendering.md 参照）。
///
/// M2: 非同期版（`register_asynchronous_uri_scheme_protocol`）を使う。ノード読み出し
/// （ディスクI/O + LAZ伸長）は`tauri::async_runtime::spawn_blocking`でブロッキング用
/// スレッドプールに逃がし、Rustのメインスレッドを塞がない。これにより並行リクエストが
/// 直列化しなくなる（`CopcState`側のロック粒度と`CopcFile`の`&mut self`制約への対処は
/// `copc_state.rs`冒頭のコメントと`CopcPool`を参照。計測結果は
/// `TaskSheets/ADR-0007-pcv-protocol-concurrency.md`）。
///
/// ベンチ用ダミーデータ（`/<size>`）は`vec![0u8; size]`を確保するだけでCPUを
/// 使わないため、スレッドを分けずその場で応答する。
fn handle_pcv_protocol(
    ctx: tauri::UriSchemeContext<'_, tauri::Wry>,
    request: tauri::http::Request<Vec<u8>>,
    responder: tauri::UriSchemeResponder,
) {
    let path = request.uri().path();
    let segment = path.strip_prefix('/').unwrap_or(path);

    if let Ok(size) = segment.parse::<usize>() {
        responder.respond(octet_stream_response(vec![0u8; size]));
        return;
    }

    let Ok(key) = segment.parse::<pcv_core::NodeKey>() else {
        responder.respond(bad_request_response(&format!(
            "unknown pcv:// path (expected /<size> or /<level>-<x>-<y>-<z>): {segment}"
        )));
        return;
    };

    // `ctx`はこのハンドラ呼び出しの間しか生きないので、spawn_blockingへ渡すために
    // `AppHandle`を複製する（`AppHandle`は内部でArcを持つ薄いハンドルで、複製は安い）。
    let app_handle = ctx.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<CopcState>();
        let response = match copc_state::read_node_bytes(&state, key) {
            Ok(bytes) => octet_stream_response(bytes),
            Err(message) => {
                eprintln!("[pcv] failed to serve node {key}: {message}");
                bad_request_response(&message)
            }
        };
        responder.respond(response);
    });
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
        // OSのファイル選択ダイアログ(デスクトップ・Android共通)。UI側は
        // src/datasource/tauri.ts の pickLocalFile() 経由でしか呼ばない(規約2)。
        .plugin(tauri_plugin_dialog::init())
        // Androidの content:// URI からファイルを開くために使う(copc_state::CopcPool::open_uri
        // 参照)。デスクトップではダイアログが返す通常のパスをそのまま開くだけで、
        // 挙動は変わらない(CopcPool::open_pathはこのプラグインを経由しない)。
        .plugin(tauri_plugin_fs::init())
        .manage(CopcState::default())
        .register_asynchronous_uri_scheme_protocol("pcv", handle_pcv_protocol)
        .invoke_handler(tauri::generate_handler![
            report_diagnostic,
            bench_invoke,
            default_bench_data_path,
            copc_state::open_copc
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
