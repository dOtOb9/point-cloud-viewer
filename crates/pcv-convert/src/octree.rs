//! 素朴なoctree分割。
//!
//! アルゴリズム(`TaskSheets/M4-import-and-conversion.md`のM4-1が指定するとおり):
//!
//! 1. 全点を1つのルートノードに割り当てる
//! 2. ノードの点数が`max_points_per_node`を超えたら、ストライドで等間隔に
//!    間引いた`max_points_per_node`点をそのノードに残し(COPCは上位ノードに
//!    粗い点を持つ、という決まりに対応する)、残りを8分木の子へ渡して再帰する
//! 3. 子への割り振りは、ノード中心からの符号(各軸が中心以上か)で決める
//!    (`copc-core::VoxelKey::child`と同じ規則。ビット0=x, 1=y, 2=z)
//!
//! out-of-core化・並列化はしない。ポイントの間引きも「乱数」や「ボクセルグリッド
//! 均一化」のような凝ったサンプリングはせず、単純なストライド抽出にとどめる
//! (最適化しない、というM4-1の指示に従う)。

use copc_core::VoxelKey;

use crate::point::RawPoint;

pub struct Node {
    pub key: VoxelKey,
    pub indices: Vec<u32>,
}

/// ルート立方体の中心と半径。COPCの`CopcInfo`はルートを立方体として持つため、
/// データのAABBそのものではなく、最も長い軸に合わせた立方体を使う。
pub fn cube_from_bounds(min: (f64, f64, f64), max: (f64, f64, f64)) -> ((f64, f64, f64), f64) {
    let center = (
        (min.0 + max.0) / 2.0,
        (min.1 + max.1) / 2.0,
        (min.2 + max.2) / 2.0,
    );
    let half = ((max.0 - min.0) / 2.0)
        .max((max.1 - min.1) / 2.0)
        .max((max.2 - min.2) / 2.0)
        // 全点が同一平面/直線/点に潰れている退化データでも0除算にならないよう下限を敷く。
        .max(f64::MIN_POSITIVE);
    (center, half)
}

pub fn build(
    points: &[RawPoint],
    center: (f64, f64, f64),
    halfsize: f64,
    max_points_per_node: usize,
) -> Vec<Node> {
    assert!(max_points_per_node > 0, "max_points_per_nodeは1以上");
    let all_indices: Vec<u32> = (0..points.len() as u32).collect();
    let mut out = Vec::new();
    split(
        points,
        all_indices,
        VoxelKey::root(),
        center,
        halfsize,
        max_points_per_node,
        &mut out,
    );
    out
}

fn split(
    points: &[RawPoint],
    indices: Vec<u32>,
    key: VoxelKey,
    center: (f64, f64, f64),
    halfsize: f64,
    max_points_per_node: usize,
    out: &mut Vec<Node>,
) {
    if indices.len() <= max_points_per_node {
        out.push(Node { key, indices });
        return;
    }

    // ストライド抽出: len/max を切り上げた間隔で等間隔に取る。
    let stride = indices.len().div_ceil(max_points_per_node);
    let mut kept = Vec::with_capacity(max_points_per_node);
    let mut rest = Vec::with_capacity(indices.len() - max_points_per_node);
    for (i, idx) in indices.into_iter().enumerate() {
        if i % stride == 0 && kept.len() < max_points_per_node {
            kept.push(idx);
        } else {
            rest.push(idx);
        }
    }
    out.push(Node { key, indices: kept });

    let mut buckets: [Vec<u32>; 8] = Default::default();
    for idx in rest {
        let p = &points[idx as usize];
        let octant = (p.x >= center.0) as u8
            | ((p.y >= center.1) as u8) << 1
            | ((p.z >= center.2) as u8) << 2;
        buckets[octant as usize].push(idx);
    }

    let child_half = halfsize / 2.0;
    for (octant, bucket) in buckets.into_iter().enumerate() {
        if bucket.is_empty() {
            continue;
        }
        let child_key = key
            .child(octant as u8)
            .expect("octantは0..8、levelはi32の範囲内に収まる");
        let child_center = (
            center.0
                + if octant & 1 != 0 {
                    child_half
                } else {
                    -child_half
                },
            center.1
                + if octant & 2 != 0 {
                    child_half
                } else {
                    -child_half
                },
            center.2
                + if octant & 4 != 0 {
                    child_half
                } else {
                    -child_half
                },
        );
        split(
            points,
            bucket,
            child_key,
            child_center,
            child_half,
            max_points_per_node,
            out,
        );
    }
}
