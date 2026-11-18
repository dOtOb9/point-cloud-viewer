use std::io::BufReader;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use copc_writer::CopcWriterParams;
use pcv_convert::import::{self, SourceFormat};
use pcv_convert::merge;
use pcv_convert::stage_timings::ConversionStageTimings;
use pcv_convert::streaming::{convert_and_timings, AtomicCancel, ReadProgress};
use pcv_convert::{cache, copc_detect, disk_space, output_path};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tauri_plugin_fs::{FilePath, FsExt, OpenOptions};

pub const EVENT_PROGRESS: &str = "conversion-progress";
pub const EVENT_DONE: &str = "conversion-done";
pub const EVENT_FAILED: &str = "conversion-failed";

#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "phase", rename_all = "snake_case")]
pub enum ConversionProgressEvent {
    Reading {
        points_read: u64,
        total_points: u64,
        elapsed_secs: f64,
    },
    PostProcessing {
        elapsed_secs: f64,
    },
}

#[derive(Debug, Clone, Copy, serde::Serialize)]
pub struct ConversionStageBreakdownDto {
    pub source_read_and_decode_secs: f64,
    pub spill_write_secs: f64,
    pub lod_index_build_secs: f64,
    pub node_compression_secs: f64,
    pub header_and_hierarchy_write_secs: f64,
    pub total_secs: f64,
    pub opfs_io_secs: Option<f64>,
    pub opfs_read_at_calls: Option<u64>,
    pub opfs_cache_hits: Option<u64>,
    pub opfs_cache_misses: Option<u64>,
    pub opfs_bytes_read_from_opfs: Option<u64>,
    pub opfs_read_secs: Option<f64>,
    pub opfs_seq_read_calls: Option<u64>,
    pub opfs_seq_read_secs: Option<f64>,
    pub point_count: u64,
    pub file_size_bytes: u64,
    pub input_file_count: u64,
}

impl ConversionStageBreakdownDto {
    fn new(
        timings: ConversionStageTimings,
        point_count: u64,
        file_size_bytes: u64,
        input_file_count: u64,
    ) -> Self {
        Self {
            source_read_and_decode_secs: timings.source_read_and_decode.as_secs_f64(),
            spill_write_secs: timings.spill_write.as_secs_f64(),
            lod_index_build_secs: timings.lod_index_build.as_secs_f64(),
            node_compression_secs: timings.node_compression.as_secs_f64(),
            header_and_hierarchy_write_secs: timings.header_and_hierarchy_write.as_secs_f64(),
            total_secs: timings.total().as_secs_f64(),
            opfs_io_secs: None,
            opfs_read_at_calls: None,
            opfs_cache_hits: None,
            opfs_cache_misses: None,
            opfs_bytes_read_from_opfs: None,
            opfs_read_secs: None,
            opfs_seq_read_calls: None,
            opfs_seq_read_secs: None,
            point_count,
            file_size_bytes,
            input_file_count,
        }
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ConversionDoneEvent {
    pub output_path: String,
    pub source_format: String,
    pub stage_timings: ConversionStageBreakdownDto,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ConversionFailedEvent {
    pub message: String,
    pub cancelled: bool,
}

#[derive(Default)]
pub struct ConversionState(Mutex<Option<Arc<AtomicBool>>>);

#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ConversionOutcome {
    AlreadyCopc {
        path: String,
    },
    Cached {
        output_path: String,
    },
    InsufficientSpace {
        required_bytes: u64,
        available_bytes: u64,
    },
    Converting,
}

pub fn redirect_os_temp_dir(dir: &Path) {
    // SAFETY: only called while no other thread reads the environment (app setup, or before the conversion thread starts).
    unsafe {
        if cfg!(windows) {
            std::env::set_var("TMP", dir);
            std::env::set_var("TEMP", dir);
        } else {
            std::env::set_var("TMPDIR", dir);
        }
    }
}

#[tauri::command]
pub fn supports_custom_temp_dir() -> bool {
    !cfg!(target_os = "android")
}

#[tauri::command]
pub fn cancel_las_conversion(state: State<ConversionState>) -> Result<(), String> {
    let guard = state.0.lock().expect("ConversionState mutex poisoned");
    match guard.as_ref() {
        Some(flag) => {
            flag.store(true, Ordering::Relaxed);
            Ok(())
        }
        None => Err("進行中の変換が無い".to_string()),
    }
}

#[tauri::command]
pub fn start_las_conversion(
    app: AppHandle,
    path: String,
    temp_dir: Option<String>,
    state: State<ConversionState>,
) -> Result<ConversionOutcome, String> {
    match FilePath::from_str(&path).unwrap_or_else(|e: std::convert::Infallible| match e {}) {
        FilePath::Path(source_path) => {
            let file = std::fs::File::open(&source_path)
                .map_err(|e| format!("ファイルを開けなかった ({}): {e}", source_path.display()))?;
            let source_path_for_convert = source_path.clone();
            decide_and_start(
                &app,
                &path,
                &source_path,
                file,
                temp_dir,
                &state,
                move || {
                    std::fs::File::open(&source_path_for_convert)
                        .map_err(|e| format!("ファイルを開けなかった: {e}"))
                },
            )
        }
        FilePath::Url(_) => {
            let file = open_uri_file(&app, &path)?;
            let app_for_convert = app.clone();
            let uri_for_convert = path.clone();
            decide_and_start(
                &app,
                &path,
                Path::new(&path),
                file,
                temp_dir,
                &state,
                move || open_uri_file(&app_for_convert, &uri_for_convert),
            )
        }
    }
}

#[tauri::command]
pub fn start_multi_las_conversion(
    app: AppHandle,
    paths: Vec<String>,
    temp_dir: Option<String>,
    state: State<ConversionState>,
) -> Result<ConversionOutcome, String> {
    if paths.len() == 1 {
        return start_las_conversion(app, paths[0].clone(), temp_dir, state);
    }
    if paths.is_empty() {
        return Err("ファイルが選択されていない".to_string());
    }

    let mut fs_paths: Vec<PathBuf> = Vec::with_capacity(paths.len());
    for raw in &paths {
        match FilePath::from_str(raw).unwrap_or_else(|e: std::convert::Infallible| match e {}) {
            FilePath::Path(p) => fs_paths.push(p),
            FilePath::Url(_) => {
                return Err(format!(
                    "複数ファイルの選択はこの環境(Android等のcontent:// URI)では未対応: {raw}"
                ));
            }
        }
    }
    fs_paths.sort();

    let fingerprint = cache::multi_fingerprint_of_paths(&fs_paths)
        .map_err(|e| format!("入力ファイルの情報取得に失敗した: {e}"))?;

    let sorted_names: Vec<String> = fs_paths
        .iter()
        .map(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("input")
                .to_string()
        })
        .collect();

    let fallback_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("アプリのキャッシュディレクトリを取得できなかった: {e}"))?
        .join("converted");
    let output_path = output_path::resolve_multi_output_path(&sorted_names, &fallback_dir)
        .map_err(|e| format!("出力先の決定に失敗した: {e}"))?;

    if !cache::needs_remerge(fingerprint, cache::read_multi_sidecar(&output_path)) {
        return Ok(ConversionOutcome::Cached {
            output_path: output_path.to_string_lossy().into_owned(),
        });
    }

    let spill_dir = resolve_spill_dir(&app, temp_dir.as_deref())?;
    redirect_os_temp_dir(&spill_dir);
    std::fs::create_dir_all(&spill_dir).map_err(|e| {
        format!(
            "一時ディレクトリを作成できなかった ({}): {e}",
            spill_dir.display()
        )
    })?;

    let available = disk_space::free_bytes_at(&spill_dir)
        .map_err(|e| format!("空き容量を確認できなかった ({}): {e}", spill_dir.display()))?;
    if !disk_space::has_enough_free_space(fingerprint.total_bytes, available) {
        return Ok(ConversionOutcome::InsufficientSpace {
            required_bytes: disk_space::required_free_bytes(fingerprint.total_bytes),
            available_bytes: available,
        });
    }

    let cancel_flag = Arc::new(AtomicBool::new(false));
    *state.0.lock().expect("ConversionState mutex poisoned") = Some(cancel_flag.clone());

    let app_for_thread = app.clone();
    spawn_guarded_conversion(app.clone(), move || {
        run_merge_conversion_thread(
            app_for_thread,
            fs_paths,
            output_path,
            spill_dir,
            fingerprint,
            cancel_flag,
        );
    });

    Ok(ConversionOutcome::Converting)
}

fn run_merge_conversion_thread(
    app: AppHandle,
    paths: Vec<PathBuf>,
    output_path: PathBuf,
    spill_dir: PathBuf,
    fingerprint: cache::MultiSourceFingerprint,
    cancel_flag: Arc<AtomicBool>,
) {
    let input_file_count = paths.len() as u64;
    let started = Instant::now();
    let app_for_progress = app.clone();
    let points_read_for_breakdown = Arc::new(AtomicU64::new(0));
    let points_read_for_breakdown_in_closure = points_read_for_breakdown.clone();
    let on_progress = move |progress: ReadProgress| {
        points_read_for_breakdown_in_closure.store(progress.points_read, Ordering::Relaxed);
        let event = ConversionProgressEvent::Reading {
            points_read: progress.points_read,
            total_points: progress.total_points,
            elapsed_secs: started.elapsed().as_secs_f64(),
        };
        if let Err(e) = app_for_progress.emit(EVENT_PROGRESS, &event) {
            log::warn!("[conversion] progressイベントの送出に失敗した(マージ): {e}");
        }
        if progress.points_read == progress.total_points {
            let event = ConversionProgressEvent::PostProcessing {
                elapsed_secs: started.elapsed().as_secs_f64(),
            };
            if let Err(e) = app_for_progress.emit(EVENT_PROGRESS, &event) {
                log::warn!("[conversion] progressイベントの送出に失敗した(マージ): {e}");
            }
        }
    };

    let cancel = AtomicCancel(cancel_flag);
    let mut timings = ConversionStageTimings::default();
    let result = merge_by_format(
        paths,
        &output_path,
        &spill_dir,
        &cancel,
        on_progress,
        &mut timings,
    );

    match result {
        Ok(merged) => {
            if let Err(e) = cache::write_multi_sidecar(&output_path, fingerprint) {
                log::warn!(
                    "[conversion] キャッシュ情報の保存に失敗した(次回は再変換される、マージ): {e}"
                );
            }
            log::info!("[conversion] マージ完了: {}", output_path.display());
            let point_count = points_read_for_breakdown.load(Ordering::Relaxed);
            let event = ConversionDoneEvent {
                output_path: output_path.to_string_lossy().into_owned(),
                source_format: merged.source_format.to_string(),
                stage_timings: ConversionStageBreakdownDto::new(
                    timings,
                    point_count,
                    fingerprint.total_bytes,
                    input_file_count,
                ),
                warnings: merged.warnings,
            };
            if let Err(e) = app.emit(EVENT_DONE, &event) {
                log::warn!("[conversion] done イベントの送出に失敗した(マージ): {e}");
            }
        }
        Err(failure) if failure.cancelled => {
            log::info!(
                "[conversion] マージがキャンセルされた: {}",
                output_path.display()
            );
            emit_failed(&app, "キャンセルされた".to_string(), true);
        }
        Err(failure) => {
            log::error!("[conversion] マージに失敗した: {}", failure.message);
            emit_failed(&app, failure.message, false);
        }
    }
}

struct MergedOutcome {
    source_format: &'static str,
    warnings: Vec<String>,
}

struct MergeFailure {
    message: String,
    cancelled: bool,
}

fn merge_by_format(
    paths: Vec<PathBuf>,
    output_path: &Path,
    spill_dir: &Path,
    cancel: &AtomicCancel,
    on_progress: impl FnMut(ReadProgress),
    timings: &mut ConversionStageTimings,
) -> Result<MergedOutcome, MergeFailure> {
    let params = CopcWriterParams::default();
    if paths.iter().all(|p| import::merge::is_las_or_laz(p)) {
        return match merge::merge_paths_and_timings(
            paths,
            output_path,
            spill_dir,
            &params,
            cancel,
            on_progress,
            timings,
        ) {
            Ok(summary) => Ok(MergedOutcome {
                source_format: "las/laz(複数ファイル)",
                warnings: summary.crs_warnings(),
            }),
            Err(e) => Err(MergeFailure {
                cancelled: matches!(e, merge::MergeError::Write(copc_core::Error::Cancelled)),
                message: e.to_string(),
            }),
        };
    }
    match import::merge::convert_paths_to_copc_and_timings(
        &paths,
        output_path,
        spill_dir,
        &params,
        cancel,
        on_progress,
        timings,
    ) {
        Ok(summary) => Ok(MergedOutcome {
            source_format: "複数ファイル(形式混在)",
            warnings: summary.warnings,
        }),
        Err(e) => Err(MergeFailure {
            cancelled: matches!(e, import::ImportError::Copc(copc_core::Error::Cancelled)),
            message: e.to_string(),
        }),
    }
}

fn open_uri_file<R: Runtime>(app: &AppHandle<R>, uri: &str) -> Result<std::fs::File, String> {
    let file_path = FilePath::from_str(uri)
        .unwrap_or_else(|infallible: std::convert::Infallible| match infallible {});
    let mut open_options = OpenOptions::new();
    open_options.read(true);
    app.fs()
        .open(file_path, open_options)
        .map_err(|e| format!("URIを開けなかった ({uri}): {e}"))
}

fn decide_and_start(
    app: &AppHandle,
    display_path: &str,
    path_for_naming: &Path,
    probe_file: std::fs::File,
    temp_dir_override: Option<String>,
    state: &ConversionState,
    open_for_convert: impl FnOnce() -> Result<std::fs::File, String> + Send + 'static,
) -> Result<ConversionOutcome, String> {
    let source_fingerprint = cache::fingerprint_of_file(&probe_file)
        .map_err(|e| format!("ファイル情報の取得に失敗した ({display_path}): {e}"))?;
    let input_len = source_fingerprint.len;

    if copc_detect::is_copc_reader(BufReader::new(probe_file))
        .map_err(|e| format!("ヘッダーの読み取りに失敗した ({display_path}): {e}"))?
    {
        return Ok(ConversionOutcome::AlreadyCopc {
            path: display_path.to_string(),
        });
    }

    let fallback_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("アプリのキャッシュディレクトリを取得できなかった: {e}"))?
        .join("converted");
    let output_path = output_path::resolve_output_path(path_for_naming, &fallback_dir)
        .map_err(|e| format!("出力先の決定に失敗した: {e}"))?;

    if !cache::needs_reconversion(source_fingerprint, cache::read_sidecar(&output_path)) {
        return Ok(ConversionOutcome::Cached {
            output_path: output_path.to_string_lossy().into_owned(),
        });
    }

    let spill_dir = resolve_spill_dir(app, temp_dir_override.as_deref())?;
    redirect_os_temp_dir(&spill_dir);
    std::fs::create_dir_all(&spill_dir).map_err(|e| {
        format!(
            "一時ディレクトリを作成できなかった ({}): {e}",
            spill_dir.display()
        )
    })?;

    let available = disk_space::free_bytes_at(&spill_dir)
        .map_err(|e| format!("空き容量を確認できなかった ({}): {e}", spill_dir.display()))?;
    if !disk_space::has_enough_free_space(input_len, available) {
        return Ok(ConversionOutcome::InsufficientSpace {
            required_bytes: disk_space::required_free_bytes(input_len),
            available_bytes: available,
        });
    }

    let cancel_flag = Arc::new(AtomicBool::new(false));
    *state.0.lock().expect("ConversionState mutex poisoned") = Some(cancel_flag.clone());

    let import_format = import::detect_format(path_for_naming);
    let source_format_label = path_for_naming
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_else(|| "(不明)".to_string());

    let app_for_thread = app.clone();
    let output_for_thread = output_path.clone();
    spawn_guarded_conversion(app.clone(), move || {
        run_conversion_thread(
            app_for_thread,
            open_for_convert,
            output_for_thread,
            spill_dir,
            source_fingerprint,
            cancel_flag,
            import_format,
            source_format_label,
        );
    });

    Ok(ConversionOutcome::Converting)
}

fn resolve_spill_dir(app: &AppHandle, temp_dir_override: Option<&str>) -> Result<PathBuf, String> {
    if let Some(dir) = temp_dir_override {
        if !dir.trim().is_empty() {
            return Ok(PathBuf::from(dir));
        }
    }
    if cfg!(target_os = "android") {
        return app
            .path()
            .app_cache_dir()
            .map(|dir| dir.join("convert-tmp"))
            .map_err(|e| format!("アプリのキャッシュディレクトリを取得できなかった: {e}"));
    }
    Ok(std::env::temp_dir())
}

#[allow(clippy::too_many_arguments)]
fn run_conversion_thread(
    app: AppHandle,
    open_for_convert: impl FnOnce() -> Result<std::fs::File, String>,
    output_path: PathBuf,
    spill_dir: PathBuf,
    source_fingerprint: cache::SourceFingerprint,
    cancel_flag: Arc<AtomicBool>,
    import_format: Option<SourceFormat>,
    source_format_label: String,
) {
    let file = match open_for_convert() {
        Ok(file) => file,
        Err(message) => {
            emit_failed(&app, message, false);
            return;
        }
    };
    let input_len = source_fingerprint.len;

    let started = Instant::now();
    let app_for_progress = app.clone();
    let points_read_for_breakdown = Arc::new(AtomicU64::new(0));
    let points_read_for_breakdown_in_closure = points_read_for_breakdown.clone();
    let on_progress = move |progress: ReadProgress| {
        points_read_for_breakdown_in_closure.store(progress.points_read, Ordering::Relaxed);
        let event = ConversionProgressEvent::Reading {
            points_read: progress.points_read,
            total_points: progress.total_points,
            elapsed_secs: started.elapsed().as_secs_f64(),
        };
        if let Err(e) = app_for_progress.emit(EVENT_PROGRESS, &event) {
            log::warn!("[conversion] progressイベントの送出に失敗した: {e}");
        }
        if progress.points_read == progress.total_points {
            let event = ConversionProgressEvent::PostProcessing {
                elapsed_secs: started.elapsed().as_secs_f64(),
            };
            if let Err(e) = app_for_progress.emit(EVENT_PROGRESS, &event) {
                log::warn!("[conversion] progress イベントの送出に失敗した: {e}");
            }
        }
    };

    let cancel = AtomicCancel(cancel_flag);
    let mut timings = ConversionStageTimings::default();
    let mut point_count: u64 = 0;
    let result: copc_core::Result<()> = match import_format {
        None => convert_and_timings(
            BufReader::new(file),
            &output_path,
            &spill_dir,
            &CopcWriterParams::default(),
            &cancel,
            on_progress,
            &mut timings,
        ),
        Some(format) => import::convert_to_copc_and_timings(
            BufReader::new(file),
            format,
            &output_path,
            &spill_dir,
            &CopcWriterParams::default(),
            &cancel,
            None,
            on_progress,
            &mut timings,
        )
        .map(|summary| {
            point_count = summary.point_count;
        })
        .map_err(copc_core::Error::from),
    };

    if import_format.is_none() {
        point_count = points_read_for_breakdown.load(Ordering::Relaxed);
    }

    match result {
        Ok(()) => {
            if let Err(e) = cache::write_sidecar(&output_path, source_fingerprint) {
                log::warn!("[conversion] キャッシュ情報の保存に失敗した(次回は再変換される): {e}");
            }
            log::info!("[conversion] 変換完了: {}", output_path.display());
            let event = ConversionDoneEvent {
                output_path: output_path.to_string_lossy().into_owned(),
                source_format: source_format_label,
                stage_timings: ConversionStageBreakdownDto::new(timings, point_count, input_len, 1),
                warnings: Vec::new(),
            };
            if let Err(e) = app.emit(EVENT_DONE, &event) {
                log::warn!("[conversion] done イベントの送出に失敗した: {e}");
            }
        }
        Err(copc_core::Error::Cancelled) => {
            log::info!("[conversion] キャンセルされた: {}", output_path.display());
            emit_failed(&app, "キャンセルされた".to_string(), true);
        }
        Err(e) => {
            log::error!("[conversion] 変換に失敗した: {e}");
            emit_failed(&app, e.to_string(), false);
        }
    }
}

fn spawn_guarded_conversion(app: AppHandle, work: impl FnOnce() + Send + 'static) {
    std::thread::spawn(move || {
        run_guarded(work, |message| emit_failed(&app, message, false));
    });
}

fn run_guarded(work: impl FnOnce(), on_panic: impl FnOnce(String)) -> bool {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(work)) {
        Ok(()) => true,
        Err(panic) => {
            let message = panic_message(panic.as_ref());
            log::error!("[conversion] thread panicked: {message}");
            on_panic(format!("内部エラー(panic): {message}"));
            false
        }
    }
}

fn panic_message(panic: &(dyn std::any::Any + Send)) -> String {
    panic
        .downcast_ref::<&str>()
        .map(|s| s.to_string())
        .or_else(|| panic.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "(本文なし)".to_string())
}

fn emit_failed(app: &AppHandle, message: String, cancelled: bool) {
    let event = ConversionFailedEvent { message, cancelled };
    if let Err(e) = app.emit(EVENT_FAILED, &event) {
        log::warn!("[conversion] failed イベントの送出に失敗した: {e}");
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ToolOutput {
    pub output_path: String,
    pub point_count: u64,
    pub warnings: Vec<String>,
}

static TOOL_OUTPUT_SEQ: AtomicU64 = AtomicU64::new(0);

fn tool_output_path(
    app: &AppHandle,
    temp_dir: Option<&str>,
    stem: &str,
) -> Result<PathBuf, String> {
    let base = resolve_spill_dir(app, temp_dir)?.join("pcv-tools");
    std::fs::create_dir_all(&base)
        .map_err(|e| format!("一時フォルダを作成できなかった ({}): {e}", base.display()))?;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let seq = TOOL_OUTPUT_SEQ.fetch_add(1, Ordering::Relaxed);
    Ok(base.join(format!("{stem}-{nanos}-{seq}.copc.laz")))
}

fn tool_progress(app: &AppHandle) -> impl FnMut(ReadProgress) + Send + 'static {
    let app = app.clone();
    let started = Instant::now();
    move |progress: ReadProgress| {
        let event = ConversionProgressEvent::Reading {
            points_read: progress.points_read,
            total_points: progress.total_points,
            elapsed_secs: started.elapsed().as_secs_f64(),
        };
        if let Err(e) = app.emit(EVENT_PROGRESS, &event) {
            log::warn!("[tool] progressイベントの送出に失敗した: {e}");
        }
    }
}

async fn run_tool<T: Send + 'static>(
    state: &ConversionState,
    work: impl FnOnce(AtomicCancel) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let cancel_flag = Arc::new(AtomicBool::new(false));
    {
        let mut guard = state
            .0
            .lock()
            .map_err(|_| "内部状態が壊れています".to_string())?;
        if guard.is_some() {
            return Err("別の変換またはツールの処理が進行中です".to_string());
        }
        *guard = Some(cancel_flag.clone());
    }
    let cancel = AtomicCancel(cancel_flag);
    let joined = tauri::async_runtime::spawn_blocking(move || {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| work(cancel)))
    })
    .await;
    if let Ok(mut guard) = state.0.lock() {
        *guard = None;
    }
    match joined {
        Ok(Ok(result)) => result,
        Ok(Err(panic)) => {
            let message = panic_message(panic.as_ref());
            Err(format!("内部エラー(panic): {message}"))
        }
        Err(e) => Err(format!("処理を実行できなかった: {e}")),
    }
}

#[tauri::command]
pub async fn extract_copc(
    app: AppHandle,
    path: String,
    filter: pcv_core::extract::ExtractFilter,
    temp_dir: Option<String>,
    state: State<'_, ConversionState>,
) -> Result<ToolOutput, String> {
    if FilePath::from_str(&path).is_ok_and(|p| matches!(p, FilePath::Url(_))) {
        return Err("この環境(content:// URI)では未対応です".to_string());
    }
    let stem = Path::new(&path)
        .file_name()
        .and_then(|n| n.to_str())
        .map(|n| {
            n.trim_end_matches(".laz")
                .trim_end_matches(".copc")
                .to_string()
        })
        .unwrap_or_else(|| "extract".to_string());
    let output = tool_output_path(&app, temp_dir.as_deref(), &format!("{stem}-extract"))?;
    let spill_dir = resolve_spill_dir(&app, temp_dir.as_deref())?;
    redirect_os_temp_dir(&spill_dir);
    let on_progress = tool_progress(&app);
    run_tool(&state, move |cancel| {
        let mut timings = ConversionStageTimings::default();
        let summary = pcv_convert::extract::extract_path_and_timings(
            Path::new(&path),
            filter,
            &output,
            &spill_dir,
            &CopcWriterParams::default(),
            &cancel,
            on_progress,
            &mut timings,
        )
        .map_err(|e| {
            if e.is_cancelled() {
                "キャンセルされた".to_string()
            } else {
                e.to_string()
            }
        })?;
        Ok(ToolOutput {
            output_path: output.to_string_lossy().into_owned(),
            point_count: summary.point_count,
            warnings: Vec::new(),
        })
    })
    .await
}

#[tauri::command]
pub async fn merge_copcs(
    app: AppHandle,
    paths: Vec<String>,
    temp_dir: Option<String>,
    state: State<'_, ConversionState>,
) -> Result<ToolOutput, String> {
    if paths.len() < 2 {
        return Err("合成するレイヤーが2つ未満です".to_string());
    }
    let mut fs_paths: Vec<PathBuf> = Vec::with_capacity(paths.len());
    for raw in &paths {
        match FilePath::from_str(raw).unwrap_or_else(|e: std::convert::Infallible| match e {}) {
            FilePath::Path(p) => fs_paths.push(p),
            FilePath::Url(_) => {
                return Err(format!("この環境(content:// URI)では未対応です: {raw}"));
            }
        }
    }
    let output = tool_output_path(&app, temp_dir.as_deref(), "merged")?;
    let spill_dir = resolve_spill_dir(&app, temp_dir.as_deref())?;
    redirect_os_temp_dir(&spill_dir);
    let on_progress = tool_progress(&app);
    run_tool(&state, move |cancel| {
        let mut timings = ConversionStageTimings::default();
        let summary = merge::merge_paths_and_timings(
            fs_paths,
            &output,
            &spill_dir,
            &CopcWriterParams::default(),
            &cancel,
            on_progress,
            &mut timings,
        )
        .map_err(|e| match e {
            merge::MergeError::Write(copc_core::Error::Cancelled) => "キャンセルされた".to_string(),
            other => other.to_string(),
        })?;
        Ok(ToolOutput {
            output_path: output.to_string_lossy().into_owned(),
            point_count: summary.declared_points_total,
            warnings: summary.crs_warnings(),
        })
    })
    .await
}

const RASTER_MAX_CELLS_DESKTOP: u64 = 64_000_000;

#[derive(Default)]
pub struct RasterPreviewState {
    stores: Mutex<std::collections::HashMap<u64, Arc<pcv_core::raster::preview::CoarsePoints>>>,
    next_id: AtomicU64,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RasterPreviewOpened {
    pub id: u64,
    #[serde(flatten)]
    pub info: pcv_core::raster::preview::PreviewOpenInfo,
}

#[tauri::command]
pub async fn raster_preview_open(
    path: String,
    state: State<'_, ConversionState>,
    previews: State<'_, RasterPreviewState>,
) -> Result<RasterPreviewOpened, String> {
    if FilePath::from_str(&path).is_ok_and(|p| matches!(p, FilePath::Url(_))) {
        return Err("この環境(content:// URI)では未対応です".to_string());
    }
    let store = run_tool(&state, move |cancel| {
        pcv_convert::raster::read_coarse_path(
            Path::new(&path),
            pcv_core::raster::preview::PREVIEW_POINT_BUDGET as usize,
            &cancel,
            |_| {},
        )
        .map_err(|e| {
            if e.is_cancelled() {
                "キャンセルされた".to_string()
            } else {
                e.to_string()
            }
        })
    })
    .await?;
    let info = store.open_info();
    let id = previews.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    previews
        .stores
        .lock()
        .map_err(|_| "内部状態が壊れています".to_string())?
        .insert(id, Arc::new(store));
    Ok(RasterPreviewOpened { id, info })
}

#[tauri::command]
pub async fn raster_preview_render(
    id: u64,
    options: pcv_core::raster::preview::PreviewOptions,
    previews: State<'_, RasterPreviewState>,
) -> Result<tauri::ipc::Response, String> {
    let store = previews
        .stores
        .lock()
        .map_err(|_| "内部状態が壊れています".to_string())?
        .get(&id)
        .cloned()
        .ok_or_else(|| "ラスタ化のウィンドウが閉じられています".to_string())?;
    let joined = tauri::async_runtime::spawn_blocking(move || {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            store.render(&options).map(|image| image.to_bytes())
        }))
    })
    .await;
    match joined {
        Ok(Ok(Ok(bytes))) => Ok(tauri::ipc::Response::new(bytes)),
        Ok(Ok(Err(e))) => Err(e.to_string()),
        Ok(Err(panic)) => Err(format!(
            "内部エラー(panic): {}",
            panic_message(panic.as_ref())
        )),
        Err(e) => Err(format!("プレビューを作れなかった: {e}")),
    }
}

#[tauri::command]
pub fn raster_preview_close(
    id: u64,
    previews: State<'_, RasterPreviewState>,
) -> Result<(), String> {
    previews
        .stores
        .lock()
        .map_err(|_| "内部状態が壊れています".to_string())?
        .remove(&id);
    Ok(())
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct RasterOutput {
    pub warnings: Vec<String>,
    pub geotiff_path: String,
    pub width: u32,
    pub height: u32,
}

#[tauri::command]
pub async fn rasterize_copc(
    app: AppHandle,
    path: String,
    options: pcv_core::raster::RasterOptions,
    temp_dir: Option<String>,
    state: State<'_, ConversionState>,
) -> Result<RasterOutput, String> {
    if FilePath::from_str(&path).is_ok_and(|p| matches!(p, FilePath::Url(_))) {
        return Err("この環境(content:// URI)では未対応です".to_string());
    }
    let stem = Path::new(&path)
        .file_name()
        .and_then(|n| n.to_str())
        .map(|n| {
            n.trim_end_matches(".laz")
                .trim_end_matches(".copc")
                .to_string()
        })
        .unwrap_or_else(|| "raster".to_string());
    let output = tool_output_path(&app, temp_dir.as_deref(), &format!("{stem}-raster"))?;
    let geotiff_output = output.with_file_name(
        output
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| format!("{}.tif", n.trim_end_matches(".copc.laz")))
            .unwrap_or_else(|| "raster.tif".to_string()),
    );
    let on_progress = tool_progress(&app);
    run_tool(&state, move |cancel| {
        let summary = pcv_convert::raster::rasterize_path(
            Path::new(&path),
            options,
            RASTER_MAX_CELLS_DESKTOP,
            &geotiff_output,
            &cancel,
            on_progress,
        )
        .map_err(|e| {
            if e.is_cancelled() {
                "キャンセルされた".to_string()
            } else {
                e.to_string()
            }
        })?;
        Ok(RasterOutput {
            warnings: summary.warnings,
            geotiff_path: geotiff_output.to_string_lossy().into_owned(),
            width: summary.width,
            height: summary.height,
        })
    })
    .await
}

#[tauri::command]
pub async fn save_tool_file(source: String, destination: String) -> Result<(), String> {
    let source = PathBuf::from(source);
    let in_tools_folder = source
        .parent()
        .and_then(|p| p.file_name())
        .is_some_and(|n| n.to_str() == Some("pcv-tools"));
    if !in_tools_folder {
        return Err("ツールが作ったファイル以外は保存できません".to_string());
    }
    std::fs::copy(&source, &destination)
        .map(|_| ())
        .map_err(|e| format!("ファイルを保存できませんでした ({destination}): {e}"))
}

#[tauri::command]
pub async fn save_text_file(destination: String, text: String) -> Result<(), String> {
    write_text_file(&destination, &text)
}

fn write_text_file(destination: &str, text: &str) -> Result<(), String> {
    std::fs::write(destination, text.as_bytes())
        .map_err(|e| format!("ファイルを保存できませんでした ({destination}): {e}"))
}

#[tauri::command]
pub async fn compute_section_line(
    app: AppHandle,
    generation: u64,
    line: pcv_core::profile::SectionLine,
    request: pcv_core::section_line::SectionLineRequest,
    state: State<'_, ConversionState>,
    copc: State<'_, crate::copc_state::CopcState>,
) -> Result<tauri::ipc::Response, String> {
    let pool = copc.pool_of(generation)?;
    let params = request.to_params(pcv_core::section_line::DEFAULT_SECTION_LINE_CELL_CAP);
    let mut report = tool_progress(&app);
    let bytes = run_tool(&state, move |cancel| {
        let result = pool.run_with_file(|file| {
            pcv_core::section_line::compute_section_line(file, &line, &params, &mut |fraction| {
                report(ReadProgress {
                    points_read: (fraction * 1000.0) as u64,
                    total_points: 1000,
                });
                !cancel.0.load(Ordering::Relaxed)
            })
        })?;
        result.map_err(|e| e.to_string())
    })
    .await?;
    Ok(tauri::ipc::Response::new(bytes))
}

fn tool_stem(path: &str, fallback: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|n| n.to_str())
        .map(|n| {
            n.trim_end_matches(".laz")
                .trim_end_matches(".copc")
                .to_string()
        })
        .unwrap_or_else(|| fallback.to_string())
}

fn thin_filter_error_text(e: pcv_convert::thin_filter::ThinFilterError) -> String {
    if e.is_cancelled() {
        "キャンセルされた".to_string()
    } else {
        e.to_string()
    }
}

#[tauri::command]
pub async fn thin_copc(
    app: AppHandle,
    path: String,
    request: pcv_core::thin_filter_job::ThinRequest,
    temp_dir: Option<String>,
    state: State<'_, ConversionState>,
) -> Result<ToolOutput, String> {
    if FilePath::from_str(&path).is_ok_and(|p| matches!(p, FilePath::Url(_))) {
        return Err("この環境(content:// URI)では未対応です".to_string());
    }
    let stem = tool_stem(&path, "thin");
    let output = tool_output_path(&app, temp_dir.as_deref(), &format!("{stem}-thin"))?;
    let spill_dir = resolve_spill_dir(&app, temp_dir.as_deref())?;
    redirect_os_temp_dir(&spill_dir);
    let on_progress = tool_progress(&app);
    run_tool(&state, move |cancel| {
        let mut timings = ConversionStageTimings::default();
        let summary = pcv_convert::thin_filter::thin_path(
            Path::new(&path),
            &request.settings(),
            &pcv_convert::thin_filter::TilingParams::default(),
            &output,
            &spill_dir,
            &CopcWriterParams::default(),
            &cancel,
            on_progress,
            &mut timings,
        )
        .map_err(thin_filter_error_text)?;
        Ok(ToolOutput {
            output_path: output.to_string_lossy().into_owned(),
            point_count: summary.kept_points,
            warnings: Vec::new(),
        })
    })
    .await
}

#[tauri::command]
pub async fn filter_copc(
    app: AppHandle,
    path: String,
    request: pcv_core::thin_filter_job::FilterRequest,
    temp_dir: Option<String>,
    state: State<'_, ConversionState>,
) -> Result<ToolOutput, String> {
    use pcv_convert::thin_filter::OutlierFilter;
    use pcv_core::thin_filter_job::JobMode;
    if FilePath::from_str(&path).is_ok_and(|p| matches!(p, FilePath::Url(_))) {
        return Err("この環境(content:// URI)では未対応です".to_string());
    }
    let filter = match JobMode::from(request) {
        JobMode::Ror(s) => OutlierFilter::Ror(s),
        JobMode::Sor(s) => OutlierFilter::Sor(s),
        JobMode::Thin(_) => return Err("フィルタの指定が正しくありません".to_string()),
    };
    let stem = tool_stem(&path, "filter");
    let output = tool_output_path(&app, temp_dir.as_deref(), &format!("{stem}-filter"))?;
    let spill_dir = resolve_spill_dir(&app, temp_dir.as_deref())?;
    redirect_os_temp_dir(&spill_dir);
    let on_progress = tool_progress(&app);
    run_tool(&state, move |cancel| {
        let mut timings = ConversionStageTimings::default();
        let summary = pcv_convert::thin_filter::filter_path(
            Path::new(&path),
            &filter,
            &pcv_convert::thin_filter::TilingParams::default(),
            &output,
            &spill_dir,
            &CopcWriterParams::default(),
            &cancel,
            on_progress,
            &mut timings,
        )
        .map_err(thin_filter_error_text)?;
        Ok(ToolOutput {
            output_path: output.to_string_lossy().into_owned(),
            point_count: summary.kept_points,
            warnings: Vec::new(),
        })
    })
    .await
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct DtmOutput {
    pub output_path: String,
    pub point_count: u64,
    pub warnings: Vec<String>,
    pub geotiff_path: Option<String>,
    pub landxml_path: Option<String>,
    pub width: u32,
    pub height: u32,
    pub cell_size: f64,
    pub tin_points: u64,
    pub tin_triangles: u64,
    pub ground_points: u64,
}

#[tauri::command]
pub async fn dtm_copc(
    app: AppHandle,
    path: String,
    request: pcv_core::dtm::DtmRequest,
    temp_dir: Option<String>,
    state: State<'_, ConversionState>,
) -> Result<DtmOutput, String> {
    if FilePath::from_str(&path).is_ok_and(|p| matches!(p, FilePath::Url(_))) {
        return Err("この環境(content:// URI)では未対応です".to_string());
    }
    let stem = tool_stem(&path, "dtm");
    let copc = tool_output_path(&app, temp_dir.as_deref(), &format!("{stem}-dtm"))?;
    let beside = |extension: &str| {
        copc.with_file_name(
            copc.file_name()
                .and_then(|n| n.to_str())
                .map(|n| format!("{}.{extension}", n.trim_end_matches(".copc.laz")))
                .unwrap_or_else(|| format!("dtm.{extension}")),
        )
    };
    let outputs = pcv_convert::dtm::DtmOutputs {
        geotiff: beside("tif"),
        landxml: beside("xml"),
        copc,
    };
    let spill_dir = resolve_spill_dir(&app, temp_dir.as_deref())?;
    redirect_os_temp_dir(&spill_dir);
    let on_progress = tool_progress(&app);
    let unix_seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    run_tool(&state, move |cancel| {
        let summary = pcv_convert::dtm::dtm_path_desktop(
            Path::new(&path),
            request,
            &outputs,
            &spill_dir,
            unix_seconds,
            &cancel,
            on_progress,
        )
        .map_err(|e| {
            if e.is_cancelled() {
                "キャンセルされた".to_string()
            } else {
                e.to_string()
            }
        })?;
        let path_if = |wanted: bool, p: &Path| wanted.then(|| p.to_string_lossy().into_owned());
        Ok(DtmOutput {
            output_path: outputs.copc.to_string_lossy().into_owned(),
            point_count: summary.point_count,
            warnings: summary.warnings,
            geotiff_path: path_if(request.output.geotiff, &outputs.geotiff),
            landxml_path: path_if(request.output.landxml, &outputs.landxml),
            width: summary.width,
            height: summary.height,
            cell_size: summary.cell_size,
            tin_points: summary.tin_points as u64,
            tin_triangles: summary.tin_triangles as u64,
            ground_points: summary.ground_points,
        })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_text_file_writes_the_text_as_it_is() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("line.csv");
        write_text_file(path.to_str().unwrap(), "s,z\r\n1.000,2.000\r\n").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"s,z\r\n1.000,2.000\r\n");
    }

    #[test]
    fn write_text_file_reports_a_missing_folder() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("no-such-folder").join("line.csv");
        let err = write_text_file(path.to_str().unwrap(), "x").unwrap_err();
        assert!(err.contains("ファイルを保存できませんでした"));
    }

    #[test]
    fn run_guarded_does_not_report_when_work_finishes() {
        let mut reported = None;
        let finished = run_guarded(|| {}, |m| reported = Some(m));
        assert!(finished);
        assert!(reported.is_none());
    }

    #[test]
    fn run_guarded_reports_a_str_panic() {
        let mut reported = None;
        let finished = run_guarded(|| panic!("boom"), |m| reported = Some(m));
        assert!(!finished);
        assert_eq!(reported.as_deref(), Some("内部エラー(panic): boom"));
    }

    #[test]
    fn run_guarded_reports_a_formatted_panic() {
        let mut reported = None;
        run_guarded(|| panic!("bad value {}", 7), |m| reported = Some(m));
        assert_eq!(reported.as_deref(), Some("内部エラー(panic): bad value 7"));
    }
}
