//! E57(地上型レーザースキャナの事実上の標準) → ストリーミングの点ソース。
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
//! ここでは複数のスキャンを順番にイテレートし、点が来るたびに`visit`へ
//! 渡すだけでよい。姿勢適用の正しさは`tests/import_e57.rs`の
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
//!
//! # M4-9: ストリーミング化
//!
//! M4-4時点は全スキャンの全点を`Vec<ImportedPoint>`にまとめてから返していた。
//! `e57`クレート自身の`PointCloudReaderSimple`は元々1点ずつ読むイテレータ
//! なので、`Vec`に貯める代わりに読んだその場で`visit`へ渡すだけで
//! ストリーミングになる(クレート側の読み方自体は変えていない)。

use std::io::{Read, Seek};

use e57::{CartesianCoordinate, E57Reader};

use super::point::{PointSource, RawPoint};
use super::ImportError;

/// `read_from`で開いたE57から、ストリーミングで点を取り出す。
///
/// `pointclouds`・`has_color`・`total_points`は`open`の時点でメタデータだけから
/// 分かる(全点を読まない)。`for_each_point`が消費する`PointSource`の設計
/// (`point.rs`のドキュメント参照)と、E57の借用イテレータの制約がちょうど
/// 噛み合う。
pub(crate) struct E57Source<R: Read + Seek> {
    reader: E57Reader<R>,
    pointclouds: Vec<e57::PointCloud>,
    has_color: bool,
    total_points: u64,
}

impl<R: Read + Seek> E57Source<R> {
    /// パスだけでなく`Read + Seek`から開けるコア実装(Androidの`content://`の
    /// URIから得たファイル記述子を直接渡せるようにするための分離。
    /// `crate::streaming::convert`と同じ考え方)。
    pub(crate) fn open(reader: R) -> Result<Self, ImportError> {
        let reader = E57Reader::new(reader)?;
        let pointclouds = reader.pointclouds();
        let has_color = pointclouds.iter().any(e57::PointCloud::has_color);
        let total_points = pointclouds.iter().map(|pc| pc.records).sum();
        Ok(Self {
            reader,
            pointclouds,
            has_color,
            total_points,
        })
    }
}

impl<R: Read + Seek> PointSource for E57Source<R> {
    fn has_color(&self) -> bool {
        self.has_color
    }

    fn declared_point_count(&self) -> u64 {
        self.total_points
    }

    fn for_each_point(
        mut self,
        visit: &mut dyn FnMut(RawPoint) -> Result<(), ImportError>,
    ) -> Result<(), ImportError> {
        for pc in &self.pointclouds {
            let mut pc_reader = self.reader.pointcloud_simple(pc)?;
            for point in &mut pc_reader {
                let point = point?;
                // 姿勢適用・球面→直交変換は既定で済んでいる(モジュール冒頭コメント参照)。
                // それでもCartesianが無効なのは、方向のみ(Direction)か、
                // 構造化(グリッド)データの欠測スロットのように「実点が無い」場合。
                // どちらも測量的な意味を持つ3D点ではないため書き出さない
                // (この分だけE57ヘッダの申告点数`pc.records`の合計より、実際に
                // `visit`が呼ばれる回数が少なくなりうる。テストで使う合成データは
                // 全点validにしているため、この食い違いは起きない)。
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

                visit(RawPoint {
                    x,
                    y,
                    z,
                    color,
                    intensity,
                })?;
            }
        }
        Ok(())
    }
}

/// `PointCloudReaderSimple`が既定で0.0..=1.0へ正規化した値を、
/// LASの16bit幅[0, 65535]へ写す。
fn normalize_unit_to_u16(value: f32) -> u16 {
    (value.clamp(0.0, 1.0) * 65535.0).round() as u16
}
