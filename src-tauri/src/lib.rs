// M0 の計測用コマンド・プロトコルをここに置く。GUI を目視しなくても
// `npm run tauri dev` の標準出力から判断できるよう、フロントの計測結果はここで println! する。
//
// M1-2以降: COPCノードの配信もここに置く（`copc_state`モジュール）。src-tauriは薄く保ち、
// COPCのパースやノードのバイナリエンコードは全て `pcv-core` に任せる（ARCHITECTURE.md参照）。
//
// M3: panic・エラーログをAndroidのlogcatに出す（`TaskSheets/ADR-0013-crash-visibility.md`）。
// Androidの標準出力・標準エラーは通常logcatに出ないため、`println!`/`eprintln!`だけでは
// 所有者が実機で何が起きたか確認できない。`log`クレートを経由させ、Androidでは
// `android_logger`（`__android_log_write`に橋渡しする）、デスクトップでは`env_logger`
// （従来どおりstderrに出す）をバックエンドとして使う。`init_logging()`で
// プラットフォームに応じたバックエンドを選び、`run()`の最初で1回だけ呼ぶ。
// あわせて`std::panic::set_hook`でpanicメッセージ・発生位置を`log::error!`に流し、
// `pcv://`ノード読み出し以外の場所で起きた（想定していない）panicも、
// 「abortする直前に何が起きたか」だけは必ずlogcat/stderrに残るようにする
// （`panic = "unwind"`にした今も、捕まえていないpanicはunwindがトップまで
// 届いた時点でプロセスが終了する。ここでの目的は「落ちるのを防ぐ」ことではなく
// 「落ちる前にメッセージを残す」こと）。

mod copc_state;

use copc_state::CopcState;
use tauri::Manager;

/// 所有者が`adb logcat`で絞り込むためのタグ。Androidでは
/// `adb logcat -s pcv:*`のように指定する（`TaskSheets/ADR-0013-crash-visibility.md`
/// 参照）。
#[cfg(target_os = "android")]
const ANDROID_LOG_TAG: &str = "pcv";

/// `log`クレートの出力先を、プラットフォームに応じて1回だけ初期化する。
///
/// - Android: `android_logger`。`log::error!`等の呼び出しを
///   `__android_log_write`経由でlogcatに書く。タグは`ANDROID_LOG_TAG`（"pcv"）。
/// - それ以外（デスクトップ）: `env_logger`。既定の出力先はstderrで、
///   これまでの`eprintln!`と同じ場所に出る（「デスクトップでは今までどおり
///   stderrに出る」という要件を満たす）。`RUST_LOG`環境変数が無い場合は
///   `info`以上を出す。
///
/// `tauri-plugin-log`ではなくこの組み合わせを選んだ理由: 今回必要なのは
/// 「Rustのpanic・エラーメッセージをネイティブ側のログ経路（logcat/stderr）に
/// 残す」ことだけで、フロントのJS側からログを出す・webviewのdevtoolsに出す・
/// ログファイルをローテーションする、といった機能は要らない。
/// `tauri-plugin-log`はそれら全部を持つ大きめのプラグインで、`invoke`ハンドラの
/// 登録やJS側API（`@tauri-apps/plugin-log`）まで付いてくる。今回の要件に対して
/// 依存が増えすぎると判断し、`log`ファサード＋プラットフォームごとの薄い
/// バックエンド（`android_logger`/`env_logger`）という最小構成にした
/// （所有者が実装を追えることを優先する方針、ARCHITECTURE.md）。
fn init_logging() {
    #[cfg(target_os = "android")]
    {
        android_logger::init_once(
            android_logger::Config::default()
                .with_max_level(log::LevelFilter::Info)
                .with_tag(ANDROID_LOG_TAG),
        );
    }
    #[cfg(not(target_os = "android"))]
    {
        // 環境変数`RUST_LOG`で上書き可能にしつつ、既定は"info"（今までの
        // println!/eprintln!による診断メッセージと同程度の粒度）にする。
        env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    }
}

/// panicのメッセージと発生位置を`log::error!`に流す。`Cargo.toml`の
/// `panic = "unwind"`（`TaskSheets/ADR-0013-crash-visibility.md`参照）と対になる
/// 仕組みで、`pcv://`のノード読み出し（`copc_state::read_node_bytes`）のように
/// 明示的に`catch_unwind`で囲んでいない場所でpanicが起きても、少なくとも
/// 「何が・どこで」起きたかはlogcat/stderrに残す（unwindが最後まで届けば
/// プロセスは終了するので、これは「落とさない」仕組みではなく「落ちる前に
/// 記録を残す」仕組み）。
fn install_panic_hook() {
    std::panic::set_hook(Box::new(|info| {
        log::error!("[pcv] panic: {info}");
    }));
}

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
            // 通常のエラー（ファイル未オープン、キー不正など）。クライアント
            // （フロント）の呼び方が悪いケースなので400。
            Err(copc_state::ReadNodeError::Normal(message)) => {
                log::warn!("[pcv] failed to serve node {key}: {message}");
                bad_request_response(&message)
            }
            // M3: read_node内でpanicが起き、copc_state::read_node_bytesの
            // catch_unwindで捕まえたもの。サーバ側（Rust側）の予期しない異常
            // なので500。フロントはこれをGpuErrorBanner（src/ui/shell/GpuErrorBanner.tsx、
            // source="node-read"）に表示する（TaskSheets/ADR-0013-crash-visibility.md参照）。
            Err(copc_state::ReadNodeError::Panicked(message)) => {
                log::error!("[pcv] node {key} read panicked: {message}");
                internal_server_error_response(&message)
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

/// M3: `copc_state::ReadNodeError::Panicked`用（panicから回復した1リクエスト）。
/// `bad_request_response`と同じ形だがステータスだけ500にする
/// （`TaskSheets/ADR-0013-crash-visibility.md`参照）。
fn internal_server_error_response(message: &str) -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(tauri::http::StatusCode::INTERNAL_SERVER_ERROR)
        .header(tauri::http::header::CONTENT_TYPE, "text/plain")
        .header(tauri::http::header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(message.as_bytes().to_vec())
        .unwrap()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    init_logging();
    install_panic_hook();
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
