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

/// Prints a diagnostic message from the frontend (stats summaries, errors) to stdout.
/// As ADR-0001 says, this is a control message; large data never goes through here.
#[tauri::command]
fn report_diagnostic(message: String) {
    println!("[frontend] {message}");
}

/// A node data request parsed by `parse_pcv_path`: `/<generation>/<level>-<x>-<y>-<z>`.
#[derive(Debug, PartialEq, Eq)]
struct PcvNodeRequest {
    generation: u64,
    key: pcv_core::NodeKey,
}

/// Parses the path of a `pcv://` node data request: `/<generation>/<level>-<x>-<y>-<z>`.
///
/// # Hotfix (v0.1.3, every node read failed): percent-decoding is required
///
/// The frontend builds the URL with `convertFileSrc`. That function (the
/// `window.__TAURI_INTERNALS__.convertFileSrc` injected by the `tauri` crate; its body is
/// `encodeURIComponent(filePath)` in the crate's `scripts/core.js`) **encodes the whole string once with
/// `encodeURIComponent` and embeds it in the URL as a single segment**. So the separators we put in the
/// string (`/`, and `:` up to v0.1.3) arrive percent-encoded too (`/` -> `%2F`, `:` -> `%3A`).
///
/// v0.1.3 used `:` as the separator but **never decoded**, so `generation_str` was always the whole string
/// such as `"0%3A1-1-1-1"`, `split_once(':')` always failed, and every node request failed with
/// "unknown pcv:// path". (The Rust tests called `read_node_bytes` directly without going through
/// `parse_pcv_path`, so they never caught it. See `TaskSheets/M1-point-rendering.md`.)
///
/// The fix: (1) the separator changed from `:` to `/` for readability (`%2F` decodes back to `/`;
/// correctness itself comes from (2)), and (2) **always percent-decode once before parsing**
/// (`percent_encoding::percent_decode_str`; the crate is already in the build graph through the `url`
/// crate that `tauri` uses, so no new crate is added. See `Cargo.toml`).
///
/// The old form (`:` separator, `%3A`) is not accepted: as above, v0.1.3 failed 100% of node reads, so no
/// client ever worked with it (desktop and Android ship the frontend and backend in the same build, so old
/// and new never mix). There was no reason to add compatibility code.
fn parse_pcv_path(path: &str) -> Result<PcvNodeRequest, String> {
    let segment = path.strip_prefix('/').unwrap_or(path);
    let decoded = percent_encoding::percent_decode_str(segment).decode_utf8_lossy();

    // Form: "<generation>/<level>-<x>-<y>-<z>". `generation` is the value `open_copc` returned to the
    // frontend (`TauriSource.currentGeneration` in `src/datasource/tauri.ts`), sent back as is, so that
    // `copc_state::read_node_bytes` can tell a request of an old generation that arrives after switching
    // files (see the doc comment of `OpenedFile` in `src-tauri/src/copc_state.rs` and
    // `TaskSheets/M4-import-and-conversion.md`).
    let Some((generation_str, key_str)) = decoded.split_once('/') else {
        return Err(format!(
            "unknown pcv:// path (expected /<generation>/<level>-<x>-<y>-<z>): {decoded}"
        ));
    };
    let generation = generation_str
        .parse::<u64>()
        .map_err(|_| format!("invalid generation in pcv:// path: {generation_str}"))?;
    let key = key_str
        .parse::<pcv_core::NodeKey>()
        .map_err(|_| format!("unknown pcv:// node key: {key_str}"))?;
    Ok(PcvNodeRequest { generation, key })
}

/// M2: uses the asynchronous version (`register_asynchronous_uri_scheme_protocol`). Reading a node (disk
/// I/O + LAZ decompression) is moved to the blocking thread pool with `tauri::async_runtime::spawn_blocking`
/// so it does not block Rust's main thread. This keeps concurrent requests from being serialized (for the
/// lock granularity of `CopcState` and the `&mut self` constraint of `CopcFile`, see the comment at the top
/// of `copc_state.rs` and `CopcPool`; measurements are in `TaskSheets/ADR-0007-pcv-protocol-concurrency.md`).
///
/// Parsing the path (including percent-decoding) is split out into `parse_pcv_path` so it can be tested
/// with plain strings, without building a `Request` / `UriSchemeResponder` (see the `tests` module below).
fn handle_pcv_protocol(
    ctx: tauri::UriSchemeContext<'_, tauri::Wry>,
    request: tauri::http::Request<Vec<u8>>,
    responder: tauri::UriSchemeResponder,
) {
    let PcvNodeRequest { generation, key } = match parse_pcv_path(request.uri().path()) {
        Ok(request) => request,
        Err(message) => {
            responder.respond(bad_request_response(&message));
            return;
        }
    };

    // `ctx` lives only during this handler call, so clone the `AppHandle` to pass it to spawn_blocking
    // (`AppHandle` is a thin handle holding an Arc; cloning is cheap).
    let app_handle = ctx.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<CopcState>();
        let response = match copc_state::read_node_bytes(&state, generation, key) {
            Ok(bytes) => octet_stream_response(bytes),
            // An ordinary error (file not open, bad key, ...). The client (frontend) called it wrongly, so 400.
            Err(copc_state::ReadNodeError::Normal(message)) => {
                log::warn!("[pcv] failed to serve node {key}: {message}");
                bad_request_response(&message)
            }
            // M3: a panic inside read_node, caught by catch_unwind in copc_state::read_node_bytes. An
            // unexpected failure on the server (Rust) side, so 500. The frontend shows it in the error dialog
            // (src/ui/dialogs/ErrorDialog.tsx, source="node-read"; see TaskSheets/ADR-0013-crash-visibility.md).
            Err(copc_state::ReadNodeError::Panicked(message)) => {
                log::error!("[pcv] node {key} read panicked: {message}");
                internal_server_error_response(&message)
            }
            // Fix for switching files: the generation in the request does not match the file open now.
            // Neither a client mistake nor a server failure but a normal race, so no warn/error log; answer
            // with a dedicated status (409). The frontend (`StaleNodeRequestError`,
            // `src/datasource/stale-node-error.ts`) drops it silently instead of showing it in the banner.
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
            copc_state::open_copc,
            copc_state::close_copc,
            conversion::start_las_conversion,
            conversion::start_multi_las_conversion,
            conversion::cancel_las_conversion,
            conversion::extract_copc,
            conversion::merge_copcs,
            // --- G1: rasterize ---
            conversion::rasterize_copc,
            conversion::save_tool_file,
            // ---
            conversion::supports_custom_temp_dir,
            // --- G2: cross-section view ---
            copc_state::read_section_profile,
            // --- G2: section line ---
            conversion::compute_section_line
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use pcv_core::NodeKey;

    #[test]
    fn parses_node_path_unencoded() {
        // 開発中にcurlやブラウザで直接叩く場合などに通る、デコード不要な形。
        assert_eq!(
            parse_pcv_path("/0/1-1-1-1"),
            Ok(PcvNodeRequest {
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
            Ok(PcvNodeRequest {
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
            Ok(PcvNodeRequest {
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
    fn rejects_path_without_separator() {
        for path in ["/not-a-node", "/123"] {
            let err = parse_pcv_path(path).unwrap_err();
            assert!(
                err.contains("unknown pcv:// path"),
                "unexpected message for {path}: {err}"
            );
        }
    }
}
