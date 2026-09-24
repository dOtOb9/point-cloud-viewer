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
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use copc_writer::CopcWriterParams;
use pcv_convert::streaming::{convert, AtomicCancel, ReadProgress};
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

#[derive(Debug, Clone, serde::Serialize)]
pub struct ConversionDoneEvent {
    pub output_path: String,
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

    let app_for_thread = app.clone();
    let output_for_thread = output_path.clone();
    std::thread::spawn(move || {
        run_conversion_thread(
            app_for_thread,
            open_for_convert,
            output_for_thread,
            spill_dir,
            source_fingerprint,
            cancel_flag,
        );
    });

    Ok(ConversionOutcome::Converting)
}

/// 一時ファイルの置き場所を決める。優先順:
/// 1. 所有者が設定で明示した場所(`temp_dir_override`)
/// 2. Android: アプリのキャッシュディレクトリ配下(`content://`から得た
///    `content://`ルートの外にファイルを書けないため。`ContentResolver`は
///    ファイルシステムの一般的な一時領域を持たない)
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

#[allow(clippy::too_many_arguments)]
fn run_conversion_thread(
    app: AppHandle,
    open_for_convert: impl FnOnce() -> Result<std::fs::File, String>,
    output_path: PathBuf,
    spill_dir: PathBuf,
    source_fingerprint: cache::SourceFingerprint,
    cancel_flag: Arc<AtomicBool>,
) {
    let file = match open_for_convert() {
        Ok(file) => file,
        Err(message) => {
            emit_failed(&app, message, false);
            return;
        }
    };

    let started = Instant::now();
    let app_for_progress = app.clone();
    let on_progress = move |progress: ReadProgress| {
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
    let result = convert(
        BufReader::new(file),
        &output_path,
        &spill_dir,
        &CopcWriterParams::default(),
        &cancel,
        on_progress,
    );

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

fn emit_failed(app: &AppHandle, message: String, cancelled: bool) {
    let event = ConversionFailedEvent { message, cancelled };
    if let Err(e) = app.emit(EVENT_FAILED, &event) {
        log::warn!("[conversion] failed イベントの送出に失敗した: {e}");
    }
}
