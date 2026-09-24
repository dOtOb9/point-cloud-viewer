//! E57(地上型レーザースキャナの事実上の標準) → 共通の点群表現への変換。
//!
//! # クレート選定
//!
//! `e57` 0.11.13(純Rust)を使う。選定理由は`TaskSheets/ADR-0008-formats-and-crs.md`
//! のM4-4追記を参照。
//!
//! # 複数スキャン・姿勢・球面座標(タスクシートの要求)
//!
//! E57は1ファイルに複数のスキャン(`PointCloud`、E57用語では"pointcloud"だが
//! 実体は1回のスキャン)を持て、それぞれ個別の姿勢(回転+並進、`pc.transform`)を
//! 持てる。`e57`クレートの`PointCloudReaderSimple`は**既定で**
//! (`apply_pose`/`spherical_to_cartesian`とも初期値`true`)以下を行う:
//!
//! - 各スキャン自身の姿勢をそのスキャンの点だけに適用する
//!   (`prepare_transform`が`pc.transform`から回転行列・並進を作る)
//! - 球面座標(range/azimuth/elevation)しか持たない点を直交座標に変換する
//!
//! つまり「姿勢を適用してから1つにまとめる」「球面座標を直交座標に直す」は
//! いずれもこのイテレータの既定動作そのものであり、自前実装は不要。
//! ここでは複数のスキャンを順番にイテレートし、結果をそのまま1つの
//! `Vec`にまとめるだけでよい。姿勢適用の正しさは`tests/import_e57.rs`の
//! `applies_per_scan_pose_before_merging`で確認する。
//!
//! # 強度・色の範囲の違いへの対応
//!
//! E57はスキャナ機種ごとに強度・色の値域が異なりうる(例: 0-255、0-1023、
//! 0.0-1.0など)ため、ファイルは`intensityLimits`/`colorLimits`で
//! センサの実際の値域を申告できる。`PointCloudReaderSimple`は既定で
//! (`normalize_intensity`/`normalize_color`とも初期値`true`)この値域を使って
//! 0.0..1.0へ正規化してくれるため、こちら側は**単純に65535を掛けるだけ**で
//! LASの16bit幅に写せる(値域の違いを個別に処理する必要が無い)。
//! 値域の申告が無いファイルでは、クレートが記録型自体の範囲
//! (`RecordDataType`のmin/max)にフォールバックする(`e57`クレート
//! `pc_reader_simple.rs`の`Range::intensity_from_pointcloud`参照)。

use std::io::{BufReader, Read, Seek};
use std::path::Path;

use e57::{CartesianCoordinate, E57Reader};

use super::point::{ImportedCloud, ImportedPoint};

pub(crate) fn read(path: &Path) -> e57::Result<ImportedCloud> {
    let file = std::fs::File::open(path)
        .or_else(|e| e57::Error::invalid(format!("E57ファイルを開けなかった: {e}")))?;
    read_from(BufReader::new(file))
}

/// パスだけでなく`Read + Seek`から読めるコア実装。将来Androidで
/// `content://`のURIから得たファイル記述子(`std::fs::File`、Read+Seekを実装)を
/// 直接渡せるようにするための分離(ADR-0006「Android」追記参照。
/// 現時点ではこのモジュールの外には公開していない。理由は
/// `TaskSheets/ADR-0008-formats-and-crs.md`のM4-4追記を参照)。
pub(crate) fn read_from<R: Read + Seek>(reader: R) -> e57::Result<ImportedCloud> {
    let mut reader = E57Reader::new(reader)?;
    let pointclouds = reader.pointclouds();

    let mut points = Vec::new();
    let mut has_color = false;

    for pc in &pointclouds {
        if pc.has_color() {
            has_color = true;
        }

        let mut pc_reader = reader.pointcloud_simple(pc)?;
        for point in &mut pc_reader {
            let point = point?;
            // 姿勢適用・球面→直交変換は既定で済んでいる(モジュール冒頭コメント参照)。
            // それでもCartesianが無効なのは、方向のみ(Direction)か、
            // 構造化(グリッド)データの欠測スロットのように「実点が無い」場合。
            // どちらも測量的な意味を持つ3D点ではないため書き出さない
            // (この分だけE57ヘッダの申告点数`pc.records`より`points.len()`が
            // 少なくなりうる。テストで使う合成データは全点validにしているため、
            // この食い違いは起きない)。
            let CartesianCoordinate::Valid { x, y, z } = point.cartesian else {
                continue;
            };

            let color = point
                .color
                .map(|c| {
                    [
                        normalize_unit_to_u16(c.red),
                        normalize_unit_to_u16(c.green),
                        normalize_unit_to_u16(c.blue),
                    ]
                })
                .unwrap_or([0, 0, 0]);
            let intensity = point.intensity.map(normalize_unit_to_u16).unwrap_or(0);

            points.push(ImportedPoint {
                x,
                y,
                z,
                color,
                intensity,
            });
        }
    }

    Ok(ImportedCloud { points, has_color })
}

/// `PointCloudReaderSimple`が既定で0.0..=1.0へ正規化した値を、
/// LASの16bit幅[0, 65535]へ写す。
fn normalize_unit_to_u16(value: f32) -> u16 {
    (value.clamp(0.0, 1.0) * 65535.0).round() as u16
}
