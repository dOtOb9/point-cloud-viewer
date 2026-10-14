//! L2-C: 「COPCを読み、条件に合う点だけを取り出す」ための部品。
//!
//! 点群ツール(点の選択・断面)は、選んだレイヤーから新しい点群レイヤーを作る
//! (`TaskSheets/ADR-0018-layer-centric-operations.md`)。このファイルは
//! その「読む側」で、**書き出し(COPCを作る)は含まない**。書き出しは
//! デスクトップが `crates/pcv-convert/src/extract.rs`、Webが
//! `crates/pcv-wasm/src/extract.rs` で、既存の変換と同じ
//! `vendor/copc-writer` に点のイテレータを渡して行う。
//! ここに置いたのは、どちらからも使える(wasm32でもビルドできる、Tauri非依存)ためである。
//!
//! # 構成
//!
//! - `ExtractFilter`: 条件。画面上の多角形(`ScreenPolygon`)か、向きのある箱
//!   (`OrientedBox`)。座標はどちらもファイルの実座標(f64)。
//! - `ExtractPoints`: COPCの階層から、条件と交わるノードだけを選び、
//!   そのノードを1つずつ読んで条件に合う点を1点ずつ返すイテレータ。
//!
//! # メモリが点数に比例しない理由
//!
//! `ExtractPoints` が抱えるのは「いま読んでいる1ノードの点」だけで、次のノードを
//! 読む前に前のノードの点は捨てる。1ノードの点数は書き出し時の
//! `max_points_per_node`(既定10万)で決まり、ファイルの総点数にもノード数にも
//! 比例しない(ノード数に比例するのは階層の一覧と、選ばれたノードのキーの一覧だけ)。
//! 上限はテスト(`crates/pcv-convert/src/extract.rs`の
//! `buffer_is_bounded_by_largest_node`)で確かめている。
//!
//! # ノードの絞り込みは「保守的」
//!
//! `may_intersect` は、交わらないと**確実に言える**ときだけ `false` を返す。
//! 迷うとき(画面の手前にはみ出すノードなど)は `true` で、読んだ上で点ごとの
//! `contains` が正確に判定する。したがって結果の正しさは絞り込みの精度に
//! 左右されず、絞り込みが粗いと読むノードが増えて遅くなるだけである。

use std::collections::VecDeque;
use std::io::{Read, Seek};

use copc_core::{CopcInfo, LasPointRecord, VoxelKey};
use copc_reader::CopcReader;

use crate::copc::voxel_bounds;

/// 画面上の多角形。投影して多角形の内側に映り、かつカメラの前(w>0)にある点が対象。
/// 奥行きは問わない(手前から奥まで全部)。
#[derive(Debug, Clone, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenPolygon {
    /// ビュー射影行列。列優先の16要素(WebGPU/glMatrixの並び)。
    /// ワールド座標(ファイルの実座標)→クリップ座標。
    pub view_proj: [f64; 16],
    /// 多角形の頂点。NDC(x,y とも -1..1)。閉じなくてよい(最後と最初を結ぶ)。
    pub polygon_ndc: Vec<[f64; 2]>,
}

/// 向きのある箱(断面の板など)。
#[derive(Debug, Clone, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrientedBox {
    pub center: [f64; 3],
    /// 正規直交な3軸(長さ1)。
    pub axes: [[f64; 3]; 3],
    /// 各軸方向の半分の長さ(0以上)。
    pub half_extents: [f64; 3],
}

#[derive(Debug, Clone, PartialEq, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ExtractFilter {
    ScreenPolygon(ScreenPolygon),
    OrientedBox(OrientedBox),
}

impl ExtractFilter {
    /// 入力の形を確かめる(有限の数か、頂点が3つ以上か等)。条件に使う前に呼ぶ。
    pub fn validate(&self) -> Result<(), String> {
        match self {
            ExtractFilter::ScreenPolygon(p) => {
                if p.polygon_ndc.len() < 3 {
                    return Err("多角形の頂点が3つ未満です".to_string());
                }
                if p.view_proj.iter().any(|v| !v.is_finite()) {
                    return Err("ビュー射影行列に有限でない値があります".to_string());
                }
                if p.polygon_ndc
                    .iter()
                    .any(|v| !v[0].is_finite() || !v[1].is_finite())
                {
                    return Err("多角形の頂点に有限でない値があります".to_string());
                }
                Ok(())
            }
            ExtractFilter::OrientedBox(b) => {
                let finite = b.center.iter().all(|v| v.is_finite())
                    && b.axes.iter().flatten().all(|v| v.is_finite())
                    && b.half_extents.iter().all(|v| v.is_finite());
                if !finite {
                    return Err("箱の指定に有限でない値があります".to_string());
                }
                if b.half_extents.iter().any(|v| *v < 0.0) {
                    return Err("箱の半分の長さが負です".to_string());
                }
                Ok(())
            }
        }
    }

    /// 点が条件に合うか(正確な判定)。
    pub fn contains(&self, p: [f64; 3]) -> bool {
        match self {
            ExtractFilter::ScreenPolygon(s) => match project(&s.view_proj, p) {
                Some(ndc) => point_in_polygon(ndc, &s.polygon_ndc),
                None => false,
            },
            ExtractFilter::OrientedBox(b) => {
                let d = sub(p, b.center);
                (0..3).all(|i| dot(d, b.axes[i]).abs() <= b.half_extents[i])
            }
        }
    }

    /// 軸に平行な箱 `[min, max]` が条件と交わりうるか。`false` なら確実に交わらない
    /// (モジュール冒頭「ノードの絞り込みは保守的」)。
    pub fn may_intersect(&self, min: [f64; 3], max: [f64; 3]) -> bool {
        match self {
            ExtractFilter::ScreenPolygon(s) => screen_may_intersect(s, min, max),
            ExtractFilter::OrientedBox(b) => box_may_intersect(b, min, max),
        }
    }
}

fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

/// ワールド座標を投影してNDCの(x,y)にする。w>0でなければ`None`(カメラの後ろ)。
fn project(m: &[f64; 16], p: [f64; 3]) -> Option<[f64; 2]> {
    let w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
    if w <= 0.0 || !w.is_finite() {
        return None;
    }
    let x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
    let y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
    Some([x / w, y / w])
}

/// 偶奇規則(半直線を右へ伸ばし、辺と交わる回数が奇数なら内側)。
fn point_in_polygon(p: [f64; 2], polygon: &[[f64; 2]]) -> bool {
    let mut inside = false;
    let n = polygon.len();
    if n < 3 {
        return false;
    }
    let mut j = n - 1;
    for i in 0..n {
        let (xi, yi) = (polygon[i][0], polygon[i][1]);
        let (xj, yj) = (polygon[j][0], polygon[j][1]);
        if (yi > p[1]) != (yj > p[1]) && p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi {
            inside = !inside;
        }
        j = i;
    }
    inside
}

fn corners(min: [f64; 3], max: [f64; 3]) -> [[f64; 3]; 8] {
    let mut out = [[0.0; 3]; 8];
    for (i, c) in out.iter_mut().enumerate() {
        *c = [
            if i & 1 == 0 { min[0] } else { max[0] },
            if i & 2 == 0 { min[1] } else { max[1] },
            if i & 4 == 0 { min[2] } else { max[2] },
        ];
    }
    out
}

/// 画面の多角形と箱の交差の保守的な判定。
/// 箱の8頂点のうち1つでもカメラの後ろ(w<=0)なら、投影が破綻するので`true`(読んで点ごとに判定)。
/// 全頂点がカメラの前なら、投影した8頂点のNDC上の外接矩形が、多角形の外接矩形と
/// 重なるかで判定する(外接矩形どうしが離れていれば確実に交わらない)。
fn screen_may_intersect(s: &ScreenPolygon, min: [f64; 3], max: [f64; 3]) -> bool {
    let mut bx = (f64::INFINITY, f64::NEG_INFINITY);
    let mut by = (f64::INFINITY, f64::NEG_INFINITY);
    for c in corners(min, max) {
        match project(&s.view_proj, c) {
            Some(n) => {
                bx = (bx.0.min(n[0]), bx.1.max(n[0]));
                by = (by.0.min(n[1]), by.1.max(n[1]));
            }
            None => return true,
        }
    }
    let mut px = (f64::INFINITY, f64::NEG_INFINITY);
    let mut py = (f64::INFINITY, f64::NEG_INFINITY);
    for v in &s.polygon_ndc {
        px = (px.0.min(v[0]), px.1.max(v[0]));
        py = (py.0.min(v[1]), py.1.max(v[1]));
    }
    bx.0 <= px.1 && px.0 <= bx.1 && by.0 <= py.1 && py.0 <= by.1
}

/// 向きのある箱と軸平行な箱の、分離軸による保守的な判定。
/// 軸は「向きのある箱の3軸」と「ワールドの3軸」だけを調べる(辺どうしの外積の
/// 9軸は調べない)。調べる軸が少ないぶん「交わらない」と言い切れる場面が減る
/// だけで、`true`を返しすぎる方向にしか間違えない。
fn box_may_intersect(b: &OrientedBox, min: [f64; 3], max: [f64; 3]) -> bool {
    let c = [
        (min[0] + max[0]) * 0.5,
        (min[1] + max[1]) * 0.5,
        (min[2] + max[2]) * 0.5,
    ];
    let h = [
        (max[0] - min[0]) * 0.5,
        (max[1] - min[1]) * 0.5,
        (max[2] - min[2]) * 0.5,
    ];
    let d = sub(c, b.center);
    // 向きのある箱の軸で調べる: 軸平行な箱をその軸へ投影した半径は Σ h_k |axis_k|。
    for i in 0..3 {
        let axis = b.axes[i];
        let r = h[0] * axis[0].abs() + h[1] * axis[1].abs() + h[2] * axis[2].abs();
        if dot(d, axis).abs() > b.half_extents[i] + r {
            return false;
        }
    }
    // ワールドの軸で調べる: 向きのある箱をその軸へ投影した半径は Σ e_i |axis_i[k]|。
    for k in 0..3 {
        let r = (0..3)
            .map(|i| b.half_extents[i] * b.axes[i][k].abs())
            .sum::<f64>();
        if d[k].abs() > h[k] + r {
            return false;
        }
    }
    true
}

/// 抽出の途中経過(進捗表示とテスト用)。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ExtractStats {
    /// 階層にある点データ付きノードの数。
    pub nodes_total: usize,
    /// そのうち条件と交わりうるとして選んだノードの数(読む予定のノード)。
    pub nodes_selected: usize,
    /// 読み終えたノードの数。
    pub nodes_read: usize,
    /// 選んだノードの点数の合計(読む点数の上限。進捗の分母に使う)。
    pub candidate_points: u64,
    /// これまでに読んだ点数。
    pub points_scanned: u64,
    /// そのうち条件に合って返した点数。
    pub points_matched: u64,
    /// 同時に抱えた点数の最大(1ノード分。テストで上限を確かめる)。
    pub max_buffered_points: usize,
}

/// COPCから条件に合う点だけを1点ずつ返すイテレータ。
pub struct ExtractPoints<R: Read + Seek + Send> {
    reader: CopcReader<R>,
    filter: ExtractFilter,
    pending: VecDeque<VoxelKey>,
    /// いま読んでいるノードの、条件に合った点(読み終えたら捨てる)。
    current: VecDeque<LasPointRecord>,
    stats: ExtractStats,
}

impl<R: Read + Seek + Send> ExtractPoints<R> {
    /// `reader`の階層を調べ、条件と交わるノードを選ぶ。点はまだ読まない。
    pub fn new(reader: CopcReader<R>, filter: ExtractFilter) -> Result<Self, copc_core::Error> {
        filter
            .validate()
            .map_err(copc_core::Error::InvalidInput)?;
        let info: CopcInfo = *reader.copc_info();
        let mut stats = ExtractStats::default();
        let mut pending = VecDeque::new();
        // 階層は BTreeMap なので、キー順(level, x, y, z)=毎回同じ順で読む。
        for entry in reader.file().hierarchy_entries() {
            if !entry.has_point_data() {
                continue;
            }
            stats.nodes_total += 1;
            let (min, max) = voxel_bounds(entry.key, &info);
            if filter.may_intersect(min, max) {
                stats.nodes_selected += 1;
                stats.candidate_points += u64::try_from(entry.point_count).unwrap_or(0);
                pending.push_back(entry.key);
            }
        }
        Ok(Self {
            reader,
            filter,
            pending,
            current: VecDeque::new(),
            stats,
        })
    }

    pub fn stats(&self) -> ExtractStats {
        self.stats
    }

    /// 次のノードを読み、条件に合う点を`current`に入れる。読むノードが無ければ`false`。
    fn load_next_node(&mut self) -> Result<bool, copc_core::Error> {
        let Some(key) = self.pending.pop_front() else {
            return Ok(false);
        };
        let points = self.reader.read_node(key)?;
        self.stats.nodes_read += 1;
        self.stats.points_scanned += points.len() as u64;
        self.stats.max_buffered_points = self.stats.max_buffered_points.max(points.len());
        for point in &points {
            if self.filter.contains([point.x, point.y, point.z]) {
                self.current.push_back(LasPointRecord::from_las_point(point));
            }
        }
        // `points`はここで捨てられる(次のノードを読む前に手放す)。
        Ok(true)
    }
}

impl<R: Read + Seek + Send> Iterator for ExtractPoints<R> {
    type Item = copc_core::Result<LasPointRecord>;

    fn next(&mut self) -> Option<Self::Item> {
        loop {
            if let Some(record) = self.current.pop_front() {
                self.stats.points_matched += 1;
                return Some(Ok(record));
            }
            match self.load_next_node() {
                Ok(true) => {}
                Ok(false) => return None,
                Err(e) => {
                    // 以降は読まない(壊れたノードの後ろを読み続けない)。
                    self.pending.clear();
                    return Some(Err(e));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// x,y をそのままNDCにする行列(w=1)。
    fn identity_view_proj() -> [f64; 16] {
        let mut m = [0.0; 16];
        m[0] = 1.0;
        m[5] = 1.0;
        m[10] = 1.0;
        m[15] = 1.0;
        m
    }

    /// w = -z になる行列。z<0 がカメラの前、z>0 は後ろ。
    fn looking_down_minus_z() -> [f64; 16] {
        let mut m = identity_view_proj();
        m[11] = -1.0;
        m[15] = 0.0;
        m
    }

    fn square(min: f64, max: f64) -> Vec<[f64; 2]> {
        vec![[min, min], [max, min], [max, max], [min, max]]
    }

    #[test]
    fn polygon_contains_points_inside_only() {
        let f = ExtractFilter::ScreenPolygon(ScreenPolygon {
            view_proj: identity_view_proj(),
            polygon_ndc: square(-0.5, 0.5),
        });
        assert!(f.contains([0.0, 0.0, 100.0]), "奥行きは問わない");
        assert!(f.contains([0.4, -0.4, -100.0]));
        assert!(!f.contains([0.6, 0.0, 0.0]));
        assert!(!f.contains([0.0, -0.6, 0.0]));
    }

    #[test]
    fn polygon_excludes_points_behind_camera() {
        let f = ExtractFilter::ScreenPolygon(ScreenPolygon {
            view_proj: looking_down_minus_z(),
            polygon_ndc: square(-1.0, 1.0),
        });
        assert!(f.contains([0.0, 0.0, -2.0]));
        assert!(!f.contains([0.0, 0.0, 2.0]), "w<=0は対象外");
    }

    #[test]
    fn polygon_node_culling_is_conservative() {
        let f = ExtractFilter::ScreenPolygon(ScreenPolygon {
            view_proj: identity_view_proj(),
            polygon_ndc: square(-0.5, 0.5),
        });
        assert!(f.may_intersect([0.0, 0.0, 0.0], [1.0, 1.0, 1.0]));
        assert!(
            !f.may_intersect([0.6, 0.0, 0.0], [1.0, 1.0, 1.0]),
            "離れた箱は読まない"
        );
        // カメラの前後にまたがる箱は、判定せず読む側に倒す。
        let g = ExtractFilter::ScreenPolygon(ScreenPolygon {
            view_proj: looking_down_minus_z(),
            polygon_ndc: square(-0.1, 0.1),
        });
        assert!(g.may_intersect([5.0, 5.0, -1.0], [6.0, 6.0, 1.0]));
    }

    fn axis_aligned_box(center: [f64; 3], half: [f64; 3]) -> ExtractFilter {
        ExtractFilter::OrientedBox(OrientedBox {
            center,
            axes: [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]],
            half_extents: half,
        })
    }

    #[test]
    fn oriented_box_contains_and_culls() {
        let f = axis_aligned_box([10.0, 10.0, 10.0], [1.0, 2.0, 3.0]);
        assert!(f.contains([10.5, 11.9, 12.9]));
        assert!(!f.contains([11.1, 10.0, 10.0]));
        assert!(f.may_intersect([9.0, 9.0, 9.0], [10.5, 10.5, 10.5]));
        assert!(!f.may_intersect([20.0, 20.0, 20.0], [21.0, 21.0, 21.0]));
    }

    #[test]
    fn rotated_box_uses_its_own_axes() {
        // z軸まわりに45度回した細い板(長さ10、幅0.5)。
        let s = std::f64::consts::FRAC_1_SQRT_2;
        let f = ExtractFilter::OrientedBox(OrientedBox {
            center: [0.0, 0.0, 0.0],
            axes: [[s, s, 0.0], [-s, s, 0.0], [0.0, 0.0, 1.0]],
            half_extents: [5.0, 0.25, 1.0],
        });
        assert!(f.contains([3.0, 3.0, 0.0]), "板の長手方向の上");
        assert!(!f.contains([3.0, -3.0, 0.0]), "板の幅の外");
        // 板から離れた角のノードは読まない。
        assert!(!f.may_intersect([4.0, -6.0, -1.0], [6.0, -4.0, 1.0]));
    }

    #[test]
    fn validate_rejects_bad_input() {
        let few = ExtractFilter::ScreenPolygon(ScreenPolygon {
            view_proj: identity_view_proj(),
            polygon_ndc: vec![[0.0, 0.0], [1.0, 1.0]],
        });
        assert!(few.validate().is_err());
        let nan = axis_aligned_box([f64::NAN, 0.0, 0.0], [1.0, 1.0, 1.0]);
        assert!(nan.validate().is_err());
        let neg = axis_aligned_box([0.0, 0.0, 0.0], [-1.0, 1.0, 1.0]);
        assert!(neg.validate().is_err());
    }

    #[test]
    fn filter_deserializes_from_camel_case_json() {
        // フロント(TypeScript)が送る形。
        let json = r#"{"kind":"orientedBox","center":[1,2,3],
            "axes":[[1,0,0],[0,1,0],[0,0,1]],"halfExtents":[1,1,1]}"#;
        let f: ExtractFilter = serde_json::from_str(json).expect("json");
        assert!(matches!(f, ExtractFilter::OrientedBox(_)));
        let json = r#"{"kind":"screenPolygon","viewProj":[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],
            "polygonNdc":[[0,0],[1,0],[1,1]]}"#;
        let f: ExtractFilter = serde_json::from_str(json).expect("json");
        assert!(matches!(f, ExtractFilter::ScreenPolygon(_)));
    }
}
