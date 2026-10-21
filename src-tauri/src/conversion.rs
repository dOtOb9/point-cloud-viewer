//! M4-3: 生のLAS/LAZをCOPCへ変換するTauriコマンド。
//!
//! 重い処理(実際の変換)は`pcv_convert::streaming`に任せ、ここは以下だけを担う
//! (`ARCHITECTURE.md`の「src-tauriは薄く保つ」方針):
//!
//! - パス(デスクトップ)か`content://` URI(Android)かで開き方を振り分ける
//! - 既にCOPCか(`copc_detect`)・変換済みキャッシュがあるか(`cache`)の判定
//! - 空き容量の事前チェック(`disk_space`)
//! - 変換を別スレッドで走らせ、進捗・完了・失敗を`invoke`ではなくイベントで
//!   通知する(ADR-0001: `invoke`は制御メッセージ専用。進捗の連打には向かない)
//! - キャンセル要求の受け口
//!
//! ## Androidの一時ディレクトリについて
//!
//! `copc-writer`のLOD構築が使う一時ファイルは、渡した`spill_dir`に関わらず
//! 常に`std::env::temp_dir()`(`tempfile::Builder::new().tempfile()`、
//! ディレクトリ指定なし)に作られる(`ADR-0006`追記、`copc-writer`の`lod.rs`を
//! 読んで確認済み)。Rust標準ライブラリのソース
//! (`library/std/src/sys/paths/unix.rs`の`temp_dir()`)を確認すると、
//! **`TMPDIR`環境変数が設定されていれば常にそれを優先し**、Android向けの既定値
//! (`/data/local/tmp`。アプリから書き込めない)はTMPDIR未設定時のみ使われる。
//! そのため、`redirect_os_temp_dir`で`TMPDIR`(Unix系)または`TMP`/`TEMP`
//! (Windows。`GetTempPath2W`が読む変数)を書き換えることで、`std::env::temp_dir()`
//! を経由する`copc-writer`側の一時ファイルもまとめて誘導できる。
//! Android起動時(`lib.rs`の`setup`フック)にアプリのキャッシュディレクトリへ、
//! 所有者が設定で一時ディレクトリを指定したときはそのディレクトリへ、
//! それぞれ向け直す。

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

/// 進捗イベント名。フロントは`@tauri-apps/api/event`の`listen()`で購読する
/// (`src/datasource/tauri.ts`に閉じ込める。規約2)。
pub const EVENT_PROGRESS: &str = "conversion-progress";
pub const EVENT_DONE: &str = "conversion-done";
pub const EVENT_FAILED: &str = "conversion-failed";

/// 読み込み段階の進捗報告の間隔と揃えた、UIへ流す頻度の目安
/// (`pcv_convert::streaming::PROGRESS_REPORT_STRIDE`は非公開なので、
/// ここでは`ReadProgress`が届くたびにそのまま流すだけにする。点数が多い
/// ファイルでも4096点ごとなので、イベント送出の頻度としては問題ない)。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "phase", rename_all = "snake_case")]
pub enum ConversionProgressEvent {
    /// 入力を読んでいる段階。正確な割合を出せる。
    Reading {
        points_read: u64,
        total_points: u64,
        elapsed_secs: f64,
    },
    /// 読み込み完了後、octree構築・チャンク圧縮・書き出しをまとめて行っている段階。
    /// `write_streaming_with_cancel`の呼び出し内部で一括して行われ、外から
    /// 個別のフックを挟む口が無いため、割合は出さず段階名だけを示す
    /// (`pcv_convert::streaming`のドキュメント「進捗の粒度」参照)。
    PostProcessing { elapsed_secs: f64 },
}

/// M4-12(`TaskSheets/M4-import-and-conversion.md`): 変換完了後、所有者に
/// 「どこで時間を使っているか」をそのまま報告してもらえるようにするための
/// 段階別の内訳。デスクトップ・Android(ここ)とWeb版
/// (`crates/pcv-wasm/src/dto.rs`の同名のDTO)の両方が同じ形のJSONを作る
/// (フィールド名を合わせ、`src/datasource/conversion-breakdown.ts`の
/// 1つの整形関数をどちらの経路でも使えるようにする)。
///
/// `opfs_io_secs`はOPFS(Web版だけが使う一時ファイル機構)の読み書き時間。
/// デスクトップには存在しないため常に`None`(JSONでは`null`)。
///
/// `opfs_read_at_calls`以下の4つ(M4-13、`TaskSheets/M4-import-and-conversion.md`、
/// `crates/pcv-wasm/src/dto.rs`の同名フィールド参照)も同じ理由で常に`None`。
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
    /// M4-14: 入力ファイル数。単一ファイルの変換では常に1。複数ファイルの
    /// マージ変換(`start_multi_las_conversion`)では選択したファイル数になる
    /// (受け入れ条件「内訳が入力ファイル数・合計サイズを示す」)。
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
    /// M4-12: 形式(拡張子、小文字)は内訳のコピー用テキストに入れる
    /// (`ConversionStageBreakdownDto`自体には持たせず、ここに別フィールドで
    /// 置く。デスクトップは拡張子から機械的に決まるが、Web版は
    /// `FinishResultDto`に形式を持たせていない=呼び出し元のTypeScriptが
    /// 既に知っているため、DTOの対称性よりも「Rust側で決められる情報は
    /// Rust側で埋める」を優先した)。
    pub source_format: String,
    pub stage_timings: ConversionStageBreakdownDto,
    /// L2-C: warnings for the on-screen error log (ADR-0011), e.g. files without a CRS were let through.
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ConversionFailedEvent {
    pub message: String,
    pub cancelled: bool,
}

/// 現在進行中の変換のキャンセルフラグ。`CopcState`と同じく、同時に1つしか
/// 変換しない前提(M1時点ではタブ等は無い)。
#[derive(Default)]
pub struct ConversionState(Mutex<Option<Arc<AtomicBool>>>);

/// `start_las_conversion`が返す、変換を始める前の判定結果。
/// フロントはこれを見て、変換を待たずに`open_copc`を呼ぶか
/// (`AlreadyCopc`/`Cached`)、進捗UIを出してイベントを待つか(`Converting`)、
/// エラーバナーに出すか(`InsufficientSpace`)を決める。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ConversionOutcome {
    /// 既にCOPC(拡張子ではなくヘッダーで判定。`copc_detect`)。変換を挟まず
    /// そのまま`open_copc(path)`を呼べる。
    AlreadyCopc { path: String },
    /// 変換済みキャッシュが有効(元ファイルが変更されていない)。
    Cached { output_path: String },
    /// 空き容量が足りない。変換を始める前に知らせる(受け入れ条件)。
    InsufficientSpace {
        required_bytes: u64,
        available_bytes: u64,
    },
    /// 変換を別スレッドで開始した。進捗・完了・失敗は`EVENT_PROGRESS`等の
    /// イベントで届く。
    Converting,
}

/// Android向け: `TMPDIR`(Windowsは`TMP`/`TEMP`)を書き換え、
/// `std::env::temp_dir()`が返す場所を変える。モジュールのドキュメント参照。
///
/// # Safety呼び出し前の注意
/// `std::env::set_var`は他スレッドが同時に環境変数を読んでいると
/// データ競合になりうるため`unsafe`(Rust 1.82以降)。この関数は
/// Tauriの`setup`フック(アプリ起動直後、他に環境変数を触るスレッドが
/// 走っていない時点)、または変換開始の最初(まだ変換スレッドを
/// 立てる前)にしか呼ばない前提で使う。
pub fn redirect_os_temp_dir(dir: &Path) {
    // SAFETY: 呼び出し元のドキュメント参照。起動直後 or 変換スレッド起動前の
    // 単一スレッド区間でのみ呼ぶ。
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
    // AndroidはOSのディレクトリ選択(SAF)が返す木はcontent:// URIであり、
    // `tempfile`が要求する実在のファイルシステムパスとしては使えないため、
    // 一時ディレクトリの手動選択はデスクトップだけに絞る(Androidは起動時に
    // 自動でアプリのキャッシュディレクトリへ誘導済み。モジュールの
    // ドキュメント参照)。
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

/// `path`はファイルシステムパス、またはAndroidの`content://` URI
/// (`open_copc`と同じ判別。`src/datasource/tauri.ts`の`pickLocalFile()`参照)。
/// `temp_dir`は所有者が設定画面で選んだ一時ファイルの置き場所(省略時は
/// プラットフォームの既定。モジュールのドキュメント参照)。
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
            // `File`はシーク位置を共有できない(`copc_state.rs`冒頭のコメント参照)ため、
            // 判定用(`file`)と変換用(このクロージャ)で別々に開き直す。
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

/// M4-14: 複数のファイルを選択したときの変換開始。M4-17で、LAS/LAZ以外
/// (PLY/PCD/E57)や混在も受け付けるようになった。ルートは形式で決まる
/// (`merge_by_format`): 全部LAS/LAZなら`pcv_convert::merge`(全属性を残す)、
/// 1つでもPLY/PCD/E57があれば`pcv_convert::import::merge`(x, y, z, 色, 強度だけ)。
///
/// `paths`は`start_las_conversion`と同じ文字列の並び(デスクトップのファイル
/// システムパス、またはAndroidの`content://` URI)だが、**マージの実体は
/// `std::fs::File::open`/`las::Reader::from_path`というパス文字列前提の
/// APIのままで、Androidの`content://` URIは読めない。** そのため
/// `content://` URIが混じっていたら、変換を試みる前に明確な日本語エラーで
/// 止める(Android複数選択への対応は見送った=未対応・未検証。
/// `TaskSheets/M4-import-and-conversion.md`のM4-14参照)。
///
/// `paths.len() == 1`のときは`start_las_conversion`へそのまま委譲する
/// (受け入れ条件「単一ファイルの選択は今までと同じ挙動」)。
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
    // `merge::collect_input_paths`(CLI向け)と同じ理由: 選んだ順序に関わらず
    // 出力(点の並び・ファイル名)が決まるようにする。
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
    // 単一ファイル版(`decide_and_start`)と同じ理由(モジュールのドキュメント参照)。
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

/// M4-14: `run_conversion_thread`(単一ファイル版)の複数ファイル版。
/// `pcv_convert::merge::merge_paths_and_timings`を呼ぶだけで、進捗・完了・
/// 失敗イベントの組み立ては単一ファイル版と同じ形にしてある(フロント側の
/// `src/state/useCopcViewer.ts`は単一・複数どちらの経路でも同じイベントハンドラで
/// 受け取れる)。
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
    // M4-12と同じ理由(`run_conversion_thread`参照): マージ本体は最終的な
    // 書き込み点数を返さないため、進捗コールバックが最後に報告した値を使う。
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
                // M4-14: a multi-file conversion has no single extension, so the label is fixed
                // (the "format" column of the breakdown text, see `conversion-breakdown.ts`).
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

/// What a finished multi-file conversion reports to the frontend.
struct MergedOutcome {
    source_format: &'static str,
    warnings: Vec<String>,
}

struct MergeFailure {
    message: String,
    cancelled: bool,
}

/// M4-17: picks the route by the input formats.
/// - all LAS/LAZ: the existing `pcv_convert::merge` (keeps every attribute)
/// - at least one PLY/PCD/E57: the point merge (`pcv_convert::import::merge`; x, y, z, color,
///   intensity only)
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

/// パス/URIどちらの経路でも共通の判定と、変換開始の処理。
///
/// - `display_path`: フロントから渡された文字列そのまま(ログ・エラー表示用)
/// - `path_for_naming`: 出力ファイル名・キャッシュのサイドカーの位置を決める
///   ための「疑似パス」。デスクトップは実在のパス、Androidは`content://` URI
///   文字列をそのまま`Path`として渡す(`pcv_convert::output_path`は文字列の
///   最後の`/`区切りをファイル名として使うだけの純粋なテキスト処理なので、
///   実在するパスである必要が無い。URIの最後のセグメントが元ファイル名の
///   手がかりになる、というだけの割り切り)
/// - `probe_file`: 既にCOPCかどうか・指紋を調べるために開いた1本目のFile
/// - `open_for_convert`: 変換本番用にもう1本(2本目)開くクロージャ。
///   `File`はシーク位置を共有できない(`copc_state.rs`冒頭のコメント参照)ため、
///   判定用と変換用で別々にファイルを開き直す
fn decide_and_start(
    app: &AppHandle,
    display_path: &str,
    path_for_naming: &Path,
    probe_file: std::fs::File,
    temp_dir_override: Option<String>,
    state: &ConversionState,
    open_for_convert: impl FnOnce() -> Result<std::fs::File, String> + Send + 'static,
) -> Result<ConversionOutcome, String> {
    // メタデータの取得はファイルのシーク位置に依存しないため、`is_copc_reader`
    // (ヘッダーを読むために`probe_file`を消費する)より先に済ませる。
    // `File::try_clone()`はシーク位置を共有してしまう(`copc_state.rs`冒頭の
    // コメント参照)ため使わない。
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
    // Androidは既定でアプリのキャッシュ配下(モジュールのドキュメント参照)、
    // 所有者が明示的に選んだ場合はそのディレクトリへ、`std::env::temp_dir()`
    // (`copc-writer`のLOD一時ファイルが使う)自体を誘導する。
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

    // M4-9: E57/PLY/PCDかどうかで変換経路を分ける(`run_conversion_thread`参照)。
    // 拡張子で判定する(`pcv_convert::import::detect_format`。LAS/LAZ自身は
    // `None`を返すので、この場合は今までどおりLAS/LAZ経路を使う)。
    let import_format = import::detect_format(path_for_naming);
    // M4-12: 内訳のコピー用テキストに入れる「形式」表示(拡張子そのまま、
    // 小文字化。無ければ"(不明)")。
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

/// 一時ファイルの置き場所を決める。優先順:
/// 1. 所有者が設定で明示した場所(`temp_dir_override`)
/// 2. Android: アプリのキャッシュディレクトリ配下(`content://`が指す
///    ツリーの外に一般的な一時領域が無いため。`ContentResolver`はファイル
///    システムの一時ディレクトリという概念を持たない)
/// 3. それ以外(デスクトップ、既定): `std::env::temp_dir()`
///    (`ADR-0006`のM4-1b実測がこの既定値で行われている)
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

/// `import_format`が`None`ならLAS/LAZ経路(`pcv_convert::streaming::convert`)、
/// `Some`ならE57/PLY/PCD経路(`pcv_convert::import::convert_to_copc`、M4-9で
/// 中間LASを経ずに追加した)を使う。どちらも同じ`ReadProgress`・
/// `copc_core::Error`でやり取りするため(`import::ImportError`から
/// `copc_core::Error`への変換は`pcv_convert`側に書いた)、この関数の残りの
/// 部分(進捗イベント・キャッシュ・完了/失敗イベント)は経路によらず共通にできる。
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
    // M4-12: LAS/LAZ経路は`convert_and_timings`が点数を返さない(戻り値は
    // `Result<()>`のまま、`import::convert_to_copc_and_timings`の
    // `ImportSummary::point_count`に相当するものが無い)ため、進捗コールバックが
    // 最後に報告した`points_read`を内訳の点数として使う(`on_progress`は
    // `points_read == total_points`の時点で必ず最後に呼ばれる。
    // `pcv_convert::streaming`のドキュメント「進捗の粒度」参照)。
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
        // 読み込み完了と同時に「後処理中」を1回出しておく。ここから
        // `convert`が返るまでの間は追加のイベントが来ないため
        // (`streaming.rs`のドキュメント「進捗の粒度」参照)、フロント側は
        // このイベントを最後に受け取った状態で待つ形になる。
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
    // M4-12(`TaskSheets/M4-import-and-conversion.md`): 所有者向けの内訳表示の
    // ため、計測専用でない本番の変換経路から段階ごとの所要時間を取る
    // (`pcv_convert::stage_timings::ConversionStageTimings`)。
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
            // CRSは推測しない(ADR-0008、`import`モジュールのドキュメント参照)。
            // UIでの選択画面は作らないという指示どおり、常に「不明」のまま渡す。
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
                // サイドカーが書けなくても変換自体は成功しているので、次回
                // 「キャッシュが見つからず作り直す」だけに留まる。致命的では
                // ないためログだけ残す。
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

/// Runs `work` on a new thread and reports a panic as a `conversion-failed` event (ADR-0015).
/// Without this, a panic would end the thread silently and the screen would stay on "converting".
fn spawn_guarded_conversion(app: AppHandle, work: impl FnOnce() + Send + 'static) {
    std::thread::spawn(move || {
        run_guarded(work, |message| emit_failed(&app, message, false));
    });
}

/// Calls `work`; if it panics, calls `on_panic` with an error message. Returns true if `work` finished.
/// Split out from `spawn_guarded_conversion` so that it can be unit-tested without a Tauri app.
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

/// Extracts a readable message from the payload returned by `catch_unwind`.
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

// --- L2-C: commands for the point-cloud tools (extraction, COPC merge) ---
//
// A new layer is created from a chosen layer (ADR-0018). The result is a COPC in the app's
// temp folder; the frontend passes the returned path straight to `open_copc` to make a new layer.
// Progress uses the same `conversion-progress` event as conversion, and cancellation the same
// `cancel_las_conversion` (only one conversion or tool runs at a time).
// No done/failed events are emitted: the result is the command's return value (errors are the `Err` text).

/// Result of an extraction or merge. Matches the frontend `ToolResult` (camelCase conversion is in `tauri.ts`).
#[derive(Debug, Clone, serde::Serialize)]
pub struct ToolOutput {
    pub output_path: String,
    pub point_count: u64,
    /// Warnings for the error log (e.g. files without a CRS were let through).
    pub warnings: Vec<String>,
}

static TOOL_OUTPUT_SEQ: AtomicU64 = AtomicU64::new(0);

/// Makes a non-colliding output path under the temp folder.
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

/// Makes a closure that emits progress events (read phase only).
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

/// Runs `work` on another thread and turns a panic into an error string (ADR-0015).
/// While it runs, the cancel flag is kept in `ConversionState`.
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

/// Writes only the points of `path` (an open COPC) that match `filter` into a new COPC.
/// With zero points it returns `Err("選んだ範囲に点がありません")`.
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

/// Merges several open COPC files into one. Files without a CRS are let through and a warning is returned.
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

// --- G1: rasterize ---

/// The largest raster the desktop accepts (cells). The grid holds up to 36 bytes per cell (RGB),
/// so this is about 2.3 GB of grid at most (an estimate; the measured case was 30.7M RGB cells at
/// 1.29 GiB peak). See `TaskSheets/G1-T6-rasterize-tool.md` for how the value was chosen.
const RASTER_MAX_CELLS_DESKTOP: u64 = 64_000_000;

/// The thinned points of the open Rasterize windows (G1-R2). The key is the id `raster_preview_open`
/// returned. Each store holds at most `PREVIEW_POINT_BUDGET` points (`CoarsePoints`), so the memory is
/// bounded by the number of windows times that, whatever the size of the cloud. The window closes its
/// store with `raster_preview_close`.
#[derive(Default)]
pub struct RasterPreviewState {
    stores: Mutex<std::collections::HashMap<u64, Arc<pcv_core::raster::preview::CoarsePoints>>>,
    next_id: AtomicU64,
}

/// What `raster_preview_open` returns. Matches the frontend `RasterPreviewOpenDto` in `tauri.ts`.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RasterPreviewOpened {
    pub id: u64,
    #[serde(flatten)]
    pub info: pcv_core::raster::preview::PreviewOpenInfo,
}

/// Reads the upper levels of an open COPC for the Rasterize window and keeps them (G1-R2).
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

/// Draws the preview picture from the kept points. The bytes are `PreviewImage::to_bytes`.
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

/// Frees the kept points of a closed Rasterize window.
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

/// Result of an export. Matches the frontend `RasterExportDto` in `tauri.ts`.
#[derive(Debug, Clone, serde::Serialize)]
pub struct RasterOutput {
    pub warnings: Vec<String>,
    /// The GeoTIFF (in the `pcv-tools` temp folder; `save_tool_file` copies it where the user chose).
    pub geotiff_path: String,
    pub width: u32,
    pub height: u32,
}

/// Rasterises an open COPC into a GeoTIFF (G1-3, export of the Rasterize window).
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
    // `tool_output_path` makes `<name>.copc.laz`; the GeoTIFF is `<name>.tif`, in the same folder.
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

/// Copies a file a tool wrote (under the `pcv-tools` temp folder) to the place the user chose
/// in the save dialog. Refuses any other source so that the command cannot be used to copy
/// arbitrary files.
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

// --- G2: section line ---

/// Computes the ground line of a cross section from the SOURCE layer (`generation` of the open file),
/// with a local CSF surface (`pcv_core::section_line`). Returns the binary buffer described there.
/// Progress uses the tool progress event with a 0..1000 scale (per mille), and the cancel flag is the
/// same one `cancel_las_conversion` sets, so the tool progress dialog's cancel button works.
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

#[cfg(test)]
mod tests {
    use super::*;

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
