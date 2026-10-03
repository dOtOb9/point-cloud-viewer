//! E57/PLY/PCDの読み込み側が共通で使う、1点ぶんの値とストリーミングの口。
//!
//! # M4-9: 全点を`Vec`に貯めない
//!
//! M4-4時点はここに`ImportedCloud{ points: Vec<ImportedPoint> }`があり、
//! 3形式とも全点を読み終えてからLASへ書き出していた(メモリが点数に比例する。
//! `TaskSheets/M4-import-and-conversion.md`のM4-9参照)。M4-9でこれをやめ、
//! 各形式が「1点読むたびに即座に`visit`へ渡す」形(`PointSource::for_each_point`)
//! に書き換えた。`RawPoint`はその1点ぶんの値で、スケール・COPCの書式には
//! 一切触れない(色は持たない入力でも`[0, 0, 0]`で埋め、ファイル全体で色を
//! 持つかどうかは`PointSource::has_color`1個で管理する。M4-4時点の
//! `ImportedCloud::has_color`と同じ割り切り)。
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct RawPoint {
    pub x: f64,
    pub y: f64,
    pub z: f64,
    /// 色を持たない入力、またはこの点だけ色が無効な入力では`[0, 0, 0]`。
    pub color: [u16; 3],
    /// 強度を持たない入力では`0`。
    pub intensity: u16,
}

/// 各形式(E57/PLY/PCD)が実装する、ストリーミングの点ソース。
///
/// `for_each_point`を`self`消費(値渡し)にしているのは、E57の実装が
/// `e57::E57Reader::pointcloud_simple`の返す借用イテレータ(`&mut self`に
/// 紐づく)を、スキャンごとに`for`ループのスコープ内だけで使う必要がある
/// ため(スコープを跨いで保持しようとすると自己参照構造体になり、安全に
/// 書けない)。1回限りの「流し込み」操作として設計すれば、この制約が
/// 自然に収まる。
pub(crate) trait PointSource {
    /// 色を持つか。ヘッダー/メタデータだけで判定できる値で、全点を読む前に分かる
    /// (E57の`PointCloud::has_color()`、PLYの`red/green/blue`プロパティの有無、
    /// PCDの`rgb`フィールドの有無。各形式の`open`実装を参照)。
    fn has_color(&self) -> bool;

    /// ヘッダーが申告する点数(進捗の分母)。E57は構造化データの欠測スロットや
    /// 方向のみの点を飛ばすため、実際に`visit`が呼ばれる回数より多いことがある
    /// (`e57.rs`のコメント参照)。
    fn declared_point_count(&self) -> u64;

    /// 全点を順に`visit`へ渡す。`visit`が`Err`を返したら(キャンセル等)、
    /// その場で中断してそのエラーをそのまま返す。
    fn for_each_point(
        self,
        visit: &mut dyn FnMut(RawPoint) -> Result<(), super::ImportError>,
    ) -> Result<(), super::ImportError>;
}
