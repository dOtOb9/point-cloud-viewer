//! E57/PLY/PCDの読み込み側が共通で使う、変換中にメモリへ保持する点の表現。
//!
//! `crate::point::RawPoint`/`SourceCloud`(LAS/LAZ読み込み側、M4-1)と同じ設計を
//! そのまま踏襲する: 色は持たない入力でも`[0, 0, 0]`で埋め、ファイル全体で
//! 色を持つかどうかは`ImportedCloud::has_color`1個で管理する(点ごとに
//! `Option`を持たせるとLAS書き出し側の分岐が点数分発生して読みにくくなるため)。

#[derive(Clone, Copy, Debug)]
pub(crate) struct ImportedPoint {
    pub x: f64,
    pub y: f64,
    pub z: f64,
    /// 色を持たない入力、またはこの点だけ色が無効な入力では`[0, 0, 0]`。
    pub color: [u16; 3],
    /// 強度を持たない入力では`0`。
    pub intensity: u16,
}

/// 読み込んだ入力点群。LAS書き出し側(`super::las_out`)が
/// scale/offsetを選び、点フォーマット(色の有無)を決めるための材料を持つ。
///
/// 「元ファイルの申告点数と一致するか」(M4-4受け入れ条件)は、この構造体には
/// 持たせていない。各形式のヘッダ(E57の`records`、PLYの`element vertex`、
/// PCDの`POINTS`)はそのまま読み込みのループ回数として使われ、行数が足りず
/// 途中で終わっているファイルは読み込み時にエラーになる(各`read`関数の実装
/// 参照)。したがって`to_las`が返す`ImportSummary::point_count`と、テストが
/// 組み立てたフィクスチャの点数(=ヘッダに書いた申告点数)を比べれば
/// 一致を確認できる(`tests/import_*.rs`参照)。
pub(crate) struct ImportedCloud {
    pub points: Vec<ImportedPoint>,
    pub has_color: bool,
}
