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

mod conversion;
mod copc_state;

use conversion::ConversionState;
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

/// M4-3(`TaskSheets/ADR-0006-conversion-strategy.md`追記): Androidの
/// `std::env::temp_dir()`は既定で`/data/local/tmp`(アプリから書き込めない)を
/// 返す。`copc-writer`のLOD構築が使う一時ファイルは常にこの既定値を経由する
/// (`src-tauri/src/conversion.rs`のドキュメント参照)ため、起動直後にアプリの
/// キャッシュディレクトリへ向け直す。`setup`フックは他のスレッドがまだ
/// 環境変数を読んでいないタイミングで呼ばれるので、ここで書き換える。
/// デスクトップでは何もしない(`std::env::temp_dir()`の既定値のままでよい。
/// `ADR-0006`のM4-1b実測もこの既定値で行われている)。
#[cfg(target_os = "android")]
fn setup_android_temp_dir(app: &tauri::App) {
    match app.path().app_cache_dir() {
        Ok(cache_dir) => {
            conversion::redirect_os_temp_dir(&cache_dir);
            log::info!(
                "[pcv] Android: TMPDIRをアプリのキャッシュディレクトリへ向けた: {}",
                cache_dir.display()
            );
        }
        Err(e) => {
            log::error!(
                "[pcv] アプリのキャッシュディレクトリを取得できなかった。変換時の一時ファイルが書き込めない可能性がある: {e}"
            );
        }
    }
}

#[cfg(not(target_os = "android"))]
fn setup_android_temp_dir(_app: &tauri::App) {}

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

/// `parse_pcv_path` が返す、パス解析の結果。
#[derive(Debug, PartialEq, Eq)]
enum PcvRequest {
    /// M0のベンチ用ダミーデータ要求: `/<size>`。
    Bench { size: usize },
    /// M1のノードデータ要求: `/<generation>/<level>-<x>-<y>-<z>`。
    Node {
        generation: u64,
        key: pcv_core::NodeKey,
    },
}

/// `pcv://<path>` を見て、M0のベンチ用ダミーデータ（`/<size>`）か
/// M1のノードデータ（`/<generation>/<level>-<x>-<y>-<z>`）かを振り分ける。
///
/// # 緊急修正（v0.1.3ノード読み出し全滅）: パーセントデコードが必須
///
/// フロントは `convertFileSrc` でURLを組み立てる。この関数（`@tauri-apps/api`が
/// 読み込むJSから使われる、`tauri`クレートが注入する
/// `window.__TAURI_INTERNALS__.convertFileSrc`。実体は`tauri`クレート
/// `scripts/core.js`の`encodeURIComponent(filePath)`）は**渡した文字列全体を
/// 1回の`encodeURIComponent`でエンコードしてから1セグメントとしてURLに埋め込む**。
/// このため、ここで組み立てる文字列に含めた区切り文字（`/`や、v0.1.3までの`:`）も
/// 丸ごとパーセントエンコードされて届く（`/`→`%2F`、`:`→`%3A`）。
///
/// v0.1.3では区切りに`:`を使っていたが、**このデコードを一度も行っていなかった**
/// ため、実際に届く`generation_str`は常に`"0%3A1-1-1-1"`のような文字列全体になり、
/// `split_once(':')`が常に失敗して全てのノード要求が「unknown pcv:// path」で
/// 失敗していた（Rust側のテストは`read_node_bytes`を`parse_pcv_path`を経由せず
/// 直接呼んでいたため、この壊れ方を一度も検出できなかった。
/// `TaskSheets/M1-point-rendering.md`参照）。
///
/// 今回の修正: ①区切りを`:`から`/`に変更（`%2F`になってもデコードすれば`/`に戻る。
/// 可読性のため、かつ後述のベンチ用`/<size>`と見た目で区別しやすいようにした。
/// 動作上の正しさ自体は②のデコードが担っている）、②**解析の前に必ず一度
/// パーセントデコードする**（`percent_encoding::percent_decode_str`。この
/// クレートは`tauri`が内部で使う`url`クレート経由で既にビルドグラフに含まれて
/// いるため、新しいクレートをビルドに追加するわけではない。`Cargo.toml`参照）。
///
/// 旧形式（`:`区切り、`%3A`）は受け付けない: v0.1.3は上記の通りノード読み出しが
/// 100%失敗しており、この形式で動いていたクライアントは存在しない
/// （デスクトップ・Androidともにフロントとバックエンドは同じビルドで配布される
/// ため、新旧混在も起きない）。互換コードを足す理由がないため追加しなかった。
fn parse_pcv_path(path: &str) -> Result<PcvRequest, String> {
    let segment = path.strip_prefix('/').unwrap_or(path);
    let decoded = percent_encoding::percent_decode_str(segment).decode_utf8_lossy();

    if let Ok(size) = decoded.parse::<usize>() {
        return Ok(PcvRequest::Bench { size });
    }

    // ノードデータ要求の形式: "<generation>/<level>-<x>-<y>-<z>"。`generation`は
    // `open_copc`がフロントに返した値（`src/datasource/tauri.ts`の
    // `TauriSource.currentGeneration`）をそのまま送り返したもの。ファイルを
    // 切り替えた後に届いた古い世代のリクエストを`copc_state::read_node_bytes`が
    // 見分けられるようにするため（`src-tauri/src/copc_state.rs`の`OpenedFile`の
    // ドキュメントコメント、`TaskSheets/M4-import-and-conversion.md`参照）。
    let Some((generation_str, key_str)) = decoded.split_once('/') else {
        return Err(format!(
            "unknown pcv:// path (expected /<size> or /<generation>/<level>-<x>-<y>-<z>): {decoded}"
        ));
    };
    let generation = generation_str
        .parse::<u64>()
        .map_err(|_| format!("invalid generation in pcv:// path: {generation_str}"))?;
    let key = key_str
        .parse::<pcv_core::NodeKey>()
        .map_err(|_| format!("unknown pcv:// node key: {key_str}"))?;
    Ok(PcvRequest::Node { generation, key })
}

/// M2: 非同期版（`register_asynchronous_uri_scheme_protocol`）を使う。ノード読み出し
/// （ディスクI/O + LAZ伸長）は`tauri::async_runtime::spawn_blocking`でブロッキング用
/// スレッドプールに逃がし、Rustのメインスレッドを塞がない。これにより並行リクエストが
/// 直列化しなくなる（`CopcState`側のロック粒度と`CopcFile`の`&mut self`制約への対処は
/// `copc_state.rs`冒頭のコメントと`CopcPool`を参照。計測結果は
/// `TaskSheets/ADR-0007-pcv-protocol-concurrency.md`）。
///
/// ベンチ用ダミーデータ（`/<size>`）は`vec![0u8; size]`を確保するだけでCPUを
/// 使わないため、スレッドを分けずその場で応答する。
///
/// パス自体の解析（パーセントデコード含む）は`parse_pcv_path`に分離してある。
/// `Request`/`UriSchemeResponder`を作らずに文字列だけでテストできるようにするため
/// （下記`tests`モジュール参照）。
fn handle_pcv_protocol(
    ctx: tauri::UriSchemeContext<'_, tauri::Wry>,
    request: tauri::http::Request<Vec<u8>>,
    responder: tauri::UriSchemeResponder,
) {
    let (generation, key) = match parse_pcv_path(request.uri().path()) {
        Ok(PcvRequest::Bench { size }) => {
            responder.respond(octet_stream_response(vec![0u8; size]));
            return;
        }
        Ok(PcvRequest::Node { generation, key }) => (generation, key),
        Err(message) => {
            responder.respond(bad_request_response(&message));
            return;
        }
    };

    // `ctx`はこのハンドラ呼び出しの間しか生きないので、spawn_blockingへ渡すために
    // `AppHandle`を複製する（`AppHandle`は内部でArcを持つ薄いハンドルで、複製は安い）。
    let app_handle = ctx.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<CopcState>();
        let response = match copc_state::read_node_bytes(&state, generation, key) {
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
            // ファイル切り替え時の不具合の修正: リクエストが指定した世代が、
            // 現在開いているファイルの世代と一致しない。クライアントの呼び方の
            // 誤りでも、サーバの異常でもない正常な競合状態なのでwarn/errorログは
            // 出さず、専用のステータス(409)で返す。フロント（`StaleNodeRequestError`、
            // `src/datasource/stale-node-error.ts`）はこれをエラーバナーに出さず
            // 黙って捨てる。
            Err(copc_state::ReadNodeError::Stale) => {
                log::debug!(
                    "[pcv] discarding stale request for node {key} (requested generation {generation})"
                );
                stale_generation_response()
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

/// `copc_state::ReadNodeError::Stale`用（ファイルを切り替えた後に届いた、古い
/// 世代のリクエスト）。400（クライアントの入力ミス）でも500（サーバの異常）でも
/// ない、「切り替えのタイミングで古いリクエストが追いついてきただけ」の正常な
/// 競合状態を表すため、専用のステータス(409 Conflict)にする。フロントの
/// `TauriSource.readNode()`（`src/datasource/tauri.ts`）がこのステータスを見分け、
/// `StaleNodeRequestError`を投げる。
fn stale_generation_response() -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(tauri::http::StatusCode::CONFLICT)
        .header(tauri::http::header::CONTENT_TYPE, "text/plain")
        .header(tauri::http::header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(b"stale generation (file was switched)".to_vec())
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
        .manage(ConversionState::default())
        .setup(|app| {
            setup_android_temp_dir(app);
            Ok(())
        })
        .register_asynchronous_uri_scheme_protocol("pcv", handle_pcv_protocol)
        .invoke_handler(tauri::generate_handler![
            report_diagnostic,
            bench_invoke,
            default_bench_data_path,
            copc_state::open_copc,
            conversion::start_las_conversion,
            conversion::cancel_las_conversion,
            conversion::supports_custom_temp_dir
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use pcv_core::NodeKey;

    #[test]
    fn parses_bench_path() {
        assert_eq!(parse_pcv_path("/123"), Ok(PcvRequest::Bench { size: 123 }));
    }

    #[test]
    fn parses_node_path_unencoded() {
        // 開発中にcurlやブラウザで直接叩く場合などに通る、デコード不要な形。
        assert_eq!(
            parse_pcv_path("/0/1-1-1-1"),
            Ok(PcvRequest::Node {
                generation: 0,
                key: NodeKey {
                    level: 1,
                    x: 1,
                    y: 1,
                    z: 1,
                },
            })
        );
    }

    /// v0.1.3でノード読み出しが全滅した不具合の再発防止テスト。フロントが
    /// `convertFileSrc("0/1-1-1-1", "pcv")` を呼んだときに実際にWindows/Androidで
    /// 生成されるURLのパス部分をそのまま通す。
    ///
    /// 根拠: `tauri`クレート（`Cargo.lock`でv2.11.6、`@tauri-apps/api/core.js`の
    /// `convertFileSrc`が呼ぶ`window.__TAURI_INTERNALS__.convertFileSrc`の実体）の
    /// `scripts/core.js`は次の通り実装されている（
    /// `~/.cargo/registry/src/*/tauri-2.11.6/scripts/core.js`で確認した）。
    ///
    /// ```js
    /// Object.defineProperty(window.__TAURI_INTERNALS__, 'convertFileSrc', {
    ///   value: function (filePath, protocol = 'asset') {
    ///     const path = encodeURIComponent(filePath)
    ///     return osName === 'windows' || osName === 'android'
    ///       ? `${protocolScheme}://${protocol}.localhost/${path}`
    ///       : `${protocol}://localhost/${path}`
    ///   }
    /// })
    /// ```
    ///
    /// つまり`filePath`全体（区切り文字含む）が1回`encodeURIComponent`される。
    /// `encodeURIComponent`は英数字・`- _ . ! ~ * ' ( )`以外をパーセントエンコード
    /// するため、`encodeURIComponent("0/1-1-1-1")`は`"0%2F1-1-1-1"`になる
    /// （`-`は非エンコード対象なので変化しない）。Windows/Androidでは
    /// `http://pcv.localhost/<path>`の形でリクエストされ、
    /// `request.uri().path()`は`"/0%2F1-1-1-1"`を返す
    /// （`http::Uri`はパーセントエンコードをデコードしない。実際、修正前の
    /// バグ報告のエラーメッセージに`%3A`がそのまま出ていたことからも、
    /// デコードされずに届くことが分かる）。
    #[test]
    fn parses_node_path_as_sent_by_convert_file_src_on_windows_and_android() {
        assert_eq!(
            parse_pcv_path("/0%2F1-1-1-1"),
            Ok(PcvRequest::Node {
                generation: 0,
                key: NodeKey {
                    level: 1,
                    x: 1,
                    y: 1,
                    z: 1,
                },
            })
        );
    }

    /// macOS/Linuxの`convertFileSrc`は`pcv://localhost/<path>`の形になるが、
    /// `<path>`部分（`encodeURIComponent`の結果）はプラットフォームによらず同じ
    /// なので、`request.uri().path()`に渡る文字列は上のテストと変わらない。
    #[test]
    fn generation_with_multiple_digits_and_negative_coordinates_decode_correctly() {
        // COPCの正当なキーは非負整数のみだが（copc.rsのコメント参照）、
        // パス解析自体は数値のパースをNodeKey::from_strに任せているだけなので、
        // ここでは世代番号が複数桁の場合の区切り位置だけを確認する。
        assert_eq!(
            parse_pcv_path("/42%2F3-0-0-0"),
            Ok(PcvRequest::Node {
                generation: 42,
                key: NodeKey {
                    level: 3,
                    x: 0,
                    y: 0,
                    z: 0,
                },
            })
        );
    }

    #[test]
    fn rejects_legacy_colon_separated_path() {
        // v0.1.3まで使っていた"<generation>:<key>"形式（パーセントデコード後は
        // "0:1-1-1-1"）。デコードはされるが"/"が無いため拒否される。v0.1.3は
        // ノード読み出しが100%失敗していたため、この形式を実際に使えていた
        // クライアントは存在せず、後方互換を足す理由がない（`parse_pcv_path`の
        // ドキュメントコメント参照）。
        assert!(parse_pcv_path("/0%3A1-1-1-1").is_err());
        assert!(parse_pcv_path("/0:1-1-1-1").is_err());
    }

    #[test]
    fn rejects_invalid_generation() {
        let err = parse_pcv_path("/abc/1-1-1-1").unwrap_err();
        assert!(
            err.contains("invalid generation"),
            "unexpected message: {err}"
        );
    }

    #[test]
    fn rejects_invalid_node_key() {
        let err = parse_pcv_path("/0/not-a-key").unwrap_err();
        assert!(
            err.contains("unknown pcv:// node key"),
            "unexpected message: {err}"
        );
    }

    #[test]
    fn rejects_path_without_separator_that_is_not_a_bench_size() {
        let err = parse_pcv_path("/not-a-number-or-node").unwrap_err();
        assert!(
            err.contains("unknown pcv:// path"),
            "unexpected message: {err}"
        );
    }
}
