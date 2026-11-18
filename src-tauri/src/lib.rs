mod conversion;
mod copc_state;

use conversion::ConversionState;
use copc_state::CopcState;
use tauri::Manager;

#[cfg(target_os = "android")]
const ANDROID_LOG_TAG: &str = "pcv";

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
        env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    }
}

fn install_panic_hook() {
    std::panic::set_hook(Box::new(|info| {
        log::error!("[pcv] panic: {info}");
    }));
}

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

#[tauri::command]
fn report_diagnostic(message: String) {
    println!("[frontend] {message}");
}

#[derive(Debug, PartialEq, Eq)]
struct PcvNodeRequest {
    generation: u64,
    key: pcv_core::NodeKey,
}

fn parse_pcv_path(path: &str) -> Result<PcvNodeRequest, String> {
    let segment = path.strip_prefix('/').unwrap_or(path);
    let decoded = percent_encoding::percent_decode_str(segment).decode_utf8_lossy();

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

    let app_handle = ctx.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<CopcState>();
        let response = match copc_state::read_node_bytes(&state, generation, key) {
            Ok(bytes) => octet_stream_response(bytes),
            Err(copc_state::ReadNodeError::Normal(message)) => {
                log::warn!("[pcv] failed to serve node {key}: {message}");
                bad_request_response(&message)
            }
            Err(copc_state::ReadNodeError::Panicked(message)) => {
                log::error!("[pcv] node {key} read panicked: {message}");
                internal_server_error_response(&message)
            }
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

fn allow_fetch_from_dev_server_origin(
    response: tauri::http::response::Builder,
) -> tauri::http::response::Builder {
    response.header(tauri::http::header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
}

fn octet_stream_response(body: Vec<u8>) -> tauri::http::Response<Vec<u8>> {
    allow_fetch_from_dev_server_origin(tauri::http::Response::builder())
        .status(tauri::http::StatusCode::OK)
        .header(
            tauri::http::header::CONTENT_TYPE,
            "application/octet-stream",
        )
        .body(body)
        .unwrap()
}

fn bad_request_response(message: &str) -> tauri::http::Response<Vec<u8>> {
    allow_fetch_from_dev_server_origin(tauri::http::Response::builder())
        .status(tauri::http::StatusCode::BAD_REQUEST)
        .header(tauri::http::header::CONTENT_TYPE, "text/plain")
        .body(message.as_bytes().to_vec())
        .unwrap()
}

fn internal_server_error_response(message: &str) -> tauri::http::Response<Vec<u8>> {
    allow_fetch_from_dev_server_origin(tauri::http::Response::builder())
        .status(tauri::http::StatusCode::INTERNAL_SERVER_ERROR)
        .header(tauri::http::header::CONTENT_TYPE, "text/plain")
        .body(message.as_bytes().to_vec())
        .unwrap()
}

fn stale_generation_response() -> tauri::http::Response<Vec<u8>> {
    allow_fetch_from_dev_server_origin(tauri::http::Response::builder())
        .status(tauri::http::StatusCode::CONFLICT)
        .header(tauri::http::header::CONTENT_TYPE, "text/plain")
        .body(b"stale generation (file was switched)".to_vec())
        .unwrap()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    init_logging();
    install_panic_hook();
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(CopcState::default())
        .manage(ConversionState::default())
        .manage(conversion::RasterPreviewState::default())
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
            conversion::rasterize_copc,
            conversion::raster_preview_open,
            conversion::raster_preview_render,
            conversion::raster_preview_close,
            conversion::save_tool_file,
            conversion::save_text_file,
            conversion::supports_custom_temp_dir,
            copc_state::read_section_profile,
            conversion::compute_section_line,
            conversion::thin_copc,
            conversion::filter_copc,
            conversion::dtm_copc
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use pcv_core::NodeKey;

    #[test]
    fn every_pcv_response_allows_fetch_from_the_dev_server_origin_localhost_1420_which_differs_from_pcv(
    ) {
        let responses = [
            octet_stream_response(vec![1, 2, 3]),
            bad_request_response("bad"),
            internal_server_error_response("panic"),
            stale_generation_response(),
        ];
        for response in responses {
            assert_eq!(
                response
                    .headers()
                    .get(tauri::http::header::ACCESS_CONTROL_ALLOW_ORIGIN)
                    .map(|value| value.as_bytes()),
                Some(&b"*"[..])
            );
        }
    }

    #[test]
    fn parses_node_path_unencoded() {
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

    #[test]
    fn generation_with_multiple_digits_and_negative_coordinates_decode_correctly() {
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
