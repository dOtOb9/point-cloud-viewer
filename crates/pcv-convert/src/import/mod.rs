//! M4-9: E57 / PLY / PCD → COPC のインポータ(中間LASを経ない)。
//!
//! # 経緯(M4-4→M4-9)
//!
//! M4-4時点は「E57/PLY/PCDをいったんプレーンなLASへ書き出し、既存のLAS/LAZ→COPC
//! 経路にそのまま乗せる」設計だった(`las_out.rs`、現在は削除済み)。この設計には
//! 2つの問題があった(`TaskSheets/M4-import-and-conversion.md`のM4-9参照):
//!
//! 1. 各形式の読み込みが全点を`Vec`に貯めてからLASへ書いていた(メモリが点数に
//!    比例する。数千万点で数GBになり、Android・Webでは破綻する)
//! 2. 中間LAS(非圧縮)を書いてから読み直しており、余計なディスクI/Oと時間がかかる
//!
//! M4-9で、各形式の読み込みを「1点読むたびに即座にCOPCの書き出しへ渡す」形
//! (`point::PointSource`)に作り直し、中間LASを無くした。`to_las`と`las_out.rs`は
//! 削除した。
//!
//! # モジュール構成
//!
//! - [`point`][]: 3形式が共通で使う、1点ぶんの値(`RawPoint`)とストリーミングの口
//!   (`PointSource`トレイト)
//! - [`scale`][]: LASのscale/offsetの選び方(純粋関数、mm以下の精度を保証)。
//!   M4-4からそのまま流用する
//! - [`convert`][]: `PointSource`からCOPCへ書き出す本体(`run_import`)
//! - [`e57`][]・[`ply`][]・[`pcd`][]: 各形式の読み込み(形式ごとの属性の対応・
//!   単位の違いはそれぞれのモジュール冒頭のコメントに記録する)

mod convert;
pub mod e57;
pub mod pcd;
pub mod ply;
mod point;
mod scale;

use std::io::{Read, Seek};
use std::path::Path;

use copc_core::CancelCheck;
use copc_writer::CopcWriterParams;

use crate::stage_timings::ConversionStageTimings;
use crate::streaming::ReadProgress;

/// 拡張子から取り込み元の形式を判定する。大文字小文字は区別しない。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceFormat {
    E57,
    Ply,
    Pcd,
}

/// パスの拡張子から`SourceFormat`を判定する。`src-tauri`側がE57/PLY/PCD/LAS/LAZの
/// どれを開いたかを振り分けるために使う(LAS/LAZ自身はこのモジュールの対象外なので
/// `None`を返す)。
pub fn detect_format(path: &Path) -> Option<SourceFormat> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    match ext.as_str() {
        "e57" => Some(SourceFormat::E57),
        "ply" => Some(SourceFormat::Ply),
        "pcd" => Some(SourceFormat::Pcd),
        _ => None,
    }
}

/// `convert_to_copc`の結果。
#[derive(Debug, Clone)]
pub struct ImportSummary {
    /// 実際にCOPCへ書き出した点数。
    pub point_count: u64,
    /// CRS(座標参照系)が分かっているか。`false`なら「不明」として扱われており、
    /// 呼び出し側は推測でCRSを補ってはならない(ADR-0008「対応しないもの」節、
    /// M4-4受け入れ条件「不明のまま計測や重ね合わせをさせない」)。
    pub crs_known: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum ImportError {
    #[error("対応していない拡張子: {0}")]
    UnknownFormat(String),
    #[error("E57の読み込みに失敗した: {0}")]
    E57(#[from] ::e57::Error),
    #[error("PLYの読み込みに失敗した: {0}")]
    Ply(#[from] ply::PlyError),
    #[error("PCDの読み込みに失敗した: {0}")]
    Pcd(#[from] pcd::PcdError),
    #[error("{0}")]
    Copc(#[from] copc_core::Error),
}

/// `src-tauri`がLAS/LAZ経路(`crate::streaming::convert`、`copc_core::Error`を
/// 直接返す)とこの経路(`convert_to_copc`、`ImportError`を返す)を同じ
/// `match`で扱えるようにする変換。`Copc`はそのまま中身を取り出す
/// (`copc_core::Error::Cancelled`かどうかの判定を呼び出し側が引き続き
/// できるようにするため)。それ以外(形式の解析に失敗した等)は
/// `InvalidInput`として包む(キャンセルではない、ただの失敗として扱う)。
impl From<ImportError> for copc_core::Error {
    fn from(err: ImportError) -> Self {
        match err {
            ImportError::Copc(e) => e,
            other => copc_core::Error::InvalidInput(other.to_string()),
        }
    }
}

/// `input`(E57/PLY/PCD)を読み、`output`へCOPCとして直接書き出す(中間LASを
/// 経ない。モジュール冒頭コメント参照)。
///
/// - `format`: `detect_format`で判定した形式。呼び出し側が既に判定済みの値を
///   渡す形にしている(このバイト列ソースが「どのパスから開かれたか」を
///   このモジュール自身は知らないため)
/// - `spill_dir`・`params`・`cancel`・`on_progress`: LAS/LAZ経路
///   (`crate::streaming::convert`)と同じ役割・同じ型。`src-tauri`側は両方の
///   経路を同じ呼び出し形で扱える(`src-tauri/src/conversion.rs`参照)
/// - `crs_wkt`: 利用者がCRSを指定する口。分かっているCRSのWKT文字列を渡すと
///   出力に書き込む。`None`なら「不明」のままにする(PLY/PCDにCRSの概念が
///   無いこと、E57も一般に測地系を持たないローカル座標であることがADR-0008に
///   記録されている。推測で平面直角座標系などを補わない)。UIでの選択画面は
///   作らない(タスクシートの指示どおり)
#[allow(clippy::too_many_arguments)]
pub fn convert_to_copc<R>(
    source: R,
    format: SourceFormat,
    output: &Path,
    spill_dir: &Path,
    params: &CopcWriterParams,
    cancel: &(dyn CancelCheck + Sync),
    crs_wkt: Option<String>,
    on_progress: impl FnMut(ReadProgress),
) -> Result<ImportSummary, ImportError>
where
    R: Read + Seek + Send + Sync + 'static,
{
    let mut discarded = ConversionStageTimings::default();
    convert_to_copc_and_timings(
        source,
        format,
        output,
        spill_dir,
        params,
        cancel,
        crs_wkt,
        on_progress,
        &mut discarded,
    )
}

/// M4-12(`TaskSheets/M4-import-and-conversion.md`): `convert_to_copc`と同じ処理を
/// 行い、あわせて段階ごとの所要時間(`timings`)を埋める
/// (`crate::streaming::convert_and_timings`と同じ理由。`src-tauri/src/
/// conversion.rs`が本番の変換経路として呼ぶ)。
#[allow(clippy::too_many_arguments)]
pub fn convert_to_copc_and_timings<R>(
    source: R,
    format: SourceFormat,
    output: &Path,
    spill_dir: &Path,
    params: &CopcWriterParams,
    cancel: &(dyn CancelCheck + Sync),
    crs_wkt: Option<String>,
    on_progress: impl FnMut(ReadProgress),
    timings: &mut ConversionStageTimings,
) -> Result<ImportSummary, ImportError>
where
    R: Read + Seek + Send + Sync + 'static,
{
    // 3形式とも`BufRead`(PLY/PCD)または`Read + Seek`(E57)で足りるため、
    // 1箇所で`BufReader`に包んでおけば全形式で使い回せる。
    let buffered = std::io::BufReader::new(source);
    match format {
        SourceFormat::E57 => convert::run_import(
            e57::E57Source::open(buffered)?,
            output,
            spill_dir,
            params,
            cancel,
            crs_wkt,
            on_progress,
            timings,
        ),
        SourceFormat::Ply => convert::run_import(
            ply::PlySource::open(buffered)?,
            output,
            spill_dir,
            params,
            cancel,
            crs_wkt,
            on_progress,
            timings,
        ),
        SourceFormat::Pcd => convert::run_import(
            pcd::PcdSource::open(buffered)?,
            output,
            spill_dir,
            params,
            cancel,
            crs_wkt,
            on_progress,
            timings,
        ),
    }
}

/// パスから開く便利関数(デスクトップの通常経路。テストからも使う)。
/// Android(`content://`)は`convert_to_copc`を直接、`tauri-plugin-fs`で開いた
/// `File`を渡して呼ぶ(`crate::streaming::convert_path`と同じ考え方)。
#[allow(clippy::too_many_arguments)]
pub fn convert_path_to_copc(
    input: &Path,
    output: &Path,
    spill_dir: &Path,
    params: &CopcWriterParams,
    cancel: &(dyn CancelCheck + Sync),
    crs_wkt: Option<String>,
    on_progress: impl FnMut(ReadProgress),
) -> Result<ImportSummary, ImportError> {
    let mut discarded = ConversionStageTimings::default();
    convert_path_to_copc_and_timings(
        input,
        output,
        spill_dir,
        params,
        cancel,
        crs_wkt,
        on_progress,
        &mut discarded,
    )
}

/// `convert_path_to_copc`の内訳付き版(`convert_to_copc_and_timings`と同じ理由)。
#[allow(clippy::too_many_arguments)]
pub fn convert_path_to_copc_and_timings(
    input: &Path,
    output: &Path,
    spill_dir: &Path,
    params: &CopcWriterParams,
    cancel: &(dyn CancelCheck + Sync),
    crs_wkt: Option<String>,
    on_progress: impl FnMut(ReadProgress),
    timings: &mut ConversionStageTimings,
) -> Result<ImportSummary, ImportError> {
    let format = detect_format(input).ok_or_else(|| {
        ImportError::UnknownFormat(
            input
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("(拡張子無し)")
                .to_string(),
        )
    })?;
    let file = std::fs::File::open(input)
        .map_err(|e| ImportError::Copc(copc_core::Error::io("open source E57/PLY/PCD", e)))?;
    convert_to_copc_and_timings(
        file,
        format,
        output,
        spill_dir,
        params,
        cancel,
        crs_wkt,
        on_progress,
        timings,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn detect_format_by_extension() {
        assert_eq!(
            detect_format(&PathBuf::from("scan.e57")),
            Some(SourceFormat::E57)
        );
        assert_eq!(
            detect_format(&PathBuf::from("SCAN.E57")),
            Some(SourceFormat::E57)
        );
        assert_eq!(
            detect_format(&PathBuf::from("mesh.ply")),
            Some(SourceFormat::Ply)
        );
        assert_eq!(
            detect_format(&PathBuf::from("cloud.pcd")),
            Some(SourceFormat::Pcd)
        );
        assert_eq!(detect_format(&PathBuf::from("raw.las")), None);
        assert_eq!(detect_format(&PathBuf::from("raw.laz")), None);
        assert_eq!(detect_format(&PathBuf::from("no_extension")), None);
    }

    #[test]
    fn convert_path_to_copc_rejects_unknown_extension() {
        let err = convert_path_to_copc(
            Path::new("unknown.xyz"),
            Path::new("out.copc.laz"),
            Path::new("."),
            &CopcWriterParams::default(),
            &copc_core::NeverCancel,
            None,
            |_| {},
        )
        .unwrap_err();
        assert!(matches!(err, ImportError::UnknownFormat(ext) if ext == "xyz"));
    }
}
