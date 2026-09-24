//! M4-4: E57 / PLY / PCD → LAS のインポータ。
//!
//! # なぜLASを経由するのか
//!
//! `copc-writer`によるLAS/LAZ→COPC変換(ADR-0006)は入力にLAS/LAZしか取らない。
//! そこでE57/PLY/PCDは、いったんプレーンなLAS(`.las`、非圧縮)へ書き出し、
//! あとは既存のLAS/LAZ→COPC経路にそのまま乗せる設計にした
//! (`TaskSheets/M4-import-and-conversion.md`のM4-4「設計」参照)。
//! このモジュールの担当は「E57/PLY/PCD → LAS」の変換だけで、COPCには一切触れない。
//!
//! # モジュール構成
//!
//! - [`point`][]: 3形式の読み込み側が共通で使う、メモリ上の点の表現
//! - [`scale`][]: LASのscale/offsetの選び方(純粋関数、mm以下の精度を保証)
//! - [`las_out`][]: 共通の点群表現からプレーンなLASを書き出す
//! - [`e57`][]・[`ply`][]・[`pcd`][]: 各形式の読み込み(形式ごとの属性の対応・
//!   単位の違いはそれぞれのモジュール冒頭のコメントに記録する)

pub mod e57;
mod las_out;
pub mod pcd;
pub mod ply;
mod point;
mod scale;

use std::path::Path;

/// 拡張子から取り込み元の形式を判定する。大文字小文字は区別しない。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceFormat {
    E57,
    Ply,
    Pcd,
}

/// パスの拡張子から`SourceFormat`を判定する。M4-3(呼び出し側)がこれで
/// E57/PLY/PCD/LAS/LAZのどれを開いたかを振り分けられるようにする
/// (LAS/LAZ自身はこのモジュールの対象外なので`None`を返す)。
pub fn detect_format(path: &Path) -> Option<SourceFormat> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    match ext.as_str() {
        "e57" => Some(SourceFormat::E57),
        "ply" => Some(SourceFormat::Ply),
        "pcd" => Some(SourceFormat::Pcd),
        _ => None,
    }
}

/// `to_las`の結果。
#[derive(Debug, Clone)]
pub struct ImportSummary {
    /// 実際にLASへ書き出した点数。
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
    #[error("LASの書き出しに失敗した: {0}")]
    Las(#[from] las::Error),
    #[error("入力に点が1つも無い")]
    Empty,
}

/// `input`(E57/PLY/PCD)を読み、`output`へプレーンなLASとして書き出す。
///
/// - `input`の拡張子から形式を自動判定する(`detect_format`)
/// - `crs_wkt`: 利用者がCRSを指定する口。分かっているCRSのWKTバイト列を渡すと
///   出力LASのヘッダーに書き込む(`las::Header::set_wkt_crs`)。`None`なら
///   「不明」のままにする(PLY/PCDにCRSの概念が無いこと、E57も一般に
///   測地系を持たないローカル座標であることがADR-0008に記録されている。
///   推測で平面直角座標系などを補わない)。WKT文字列そのものを組み立てる処理
///   ―― 例えばEPSGコードからの変換 ―― は今回の範囲外
///   (`TaskSheets/ADR-0008-formats-and-crs.md`のM4-4追記を参照)。UIでの
///   選択画面は作らない(タスクシートの指示どおり)
pub fn to_las(
    input: &Path,
    output: &Path,
    crs_wkt: Option<Vec<u8>>,
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

    let cloud = match format {
        SourceFormat::E57 => e57::read(input)?,
        SourceFormat::Ply => ply::read(input)?,
        SourceFormat::Pcd => pcd::read(input)?,
    };

    las_out::write(output, &cloud, crs_wkt)
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
    fn to_las_rejects_unknown_extension() {
        let err = to_las(Path::new("unknown.xyz"), Path::new("out.las"), None).unwrap_err();
        assert!(matches!(err, ImportError::UnknownFormat(ext) if ext == "xyz"));
    }
}
