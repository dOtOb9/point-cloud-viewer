//! `ImportedCloud`をプレーンなLASファイルへ書き出す。
//!
//! # なぜCOPCのバイナリ構造を自分で組み立てないのか
//!
//! `crate::writer`(M4-1)はCOPCのhierarchy/VLRまで自分で組み立てているが、
//! ここでは要らない。E57/PLY/PCDの取り込みが作るのは**中間ファイル**であり、
//! この後は既存のLAS/LAZ→COPC経路(`copc-writer`、ADR-0006)にそのまま渡す
//! 設計になっている(タスクシートの指示どおり)。したがってここは
//! `las`クレートの`Writer`へ1点ずつ書くだけの、素直なLAS書き出しでよい。

use std::path::Path;

use las::{Builder, Color, Point, Transform, Vector, Version};

use super::point::ImportedCloud;
use super::{ImportError, ImportSummary};

/// 色を持つ入力の点フォーマット(RGB、GPS時刻なし)。
const POINT_FORMAT_WITH_COLOR: u8 = 2;
/// 色を持たない入力の点フォーマット(最小構成)。
const POINT_FORMAT_WITHOUT_COLOR: u8 = 0;

pub(crate) fn write(
    output: &Path,
    cloud: &ImportedCloud,
    crs_wkt: Option<Vec<u8>>,
) -> Result<ImportSummary, ImportError> {
    if cloud.points.is_empty() {
        return Err(ImportError::Empty);
    }

    let mut min = (f64::MAX, f64::MAX, f64::MAX);
    let mut max = (f64::MIN, f64::MIN, f64::MIN);
    for p in &cloud.points {
        min.0 = min.0.min(p.x);
        min.1 = min.1.min(p.y);
        min.2 = min.2.min(p.z);
        max.0 = max.0.max(p.x);
        max.1 = max.1.max(p.y);
        max.2 = max.2.max(p.z);
    }
    let (scale, offset) = super::scale::choose_scale_offset(min, max);

    let mut builder = Builder::default();
    // WKT CRSはLAS 1.4でしか書けない(`las`クレートの制約、
    // `crs.rs`の`set_wkt_crs`のドキュメント参照)ため、常に1.4を使う。
    builder.version = Version::new(1, 4);
    builder.point_format = las::point::Format::new(if cloud.has_color {
        POINT_FORMAT_WITH_COLOR
    } else {
        POINT_FORMAT_WITHOUT_COLOR
    })?;
    builder.transforms = Vector {
        x: Transform {
            scale: scale.0,
            offset: offset.0,
        },
        y: Transform {
            scale: scale.1,
            offset: offset.1,
        },
        z: Transform {
            scale: scale.2,
            offset: offset.2,
        },
    };
    let mut header = builder.into_header()?;

    // CRSが分かっている(呼び出し側からWKTバイト列が渡された)場合だけ書く。
    // 分からないものを「不明」のまま扱う、というADR-0008の方針どおり、
    // ここでは何も推測しない。
    let crs_known = if let Some(wkt) = crs_wkt {
        header.set_wkt_crs(wkt)?;
        true
    } else {
        false
    };

    let mut writer = las::Writer::from_path(output, header)?;
    for p in &cloud.points {
        let point = Point {
            x: p.x,
            y: p.y,
            z: p.z,
            intensity: p.intensity,
            color: cloud
                .has_color
                .then(|| Color::new(p.color[0], p.color[1], p.color[2])),
            ..Default::default()
        };
        writer.write_point(point)?;
    }
    writer.close()?;

    Ok(ImportSummary {
        point_count: cloud.points.len() as u64,
        crs_known,
    })
}
