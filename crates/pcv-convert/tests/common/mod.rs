//! `tests/import_*.rs`が共通で使う、COPC出力を読んで検証する補助関数。
//!
//! `tests/<name>.rs`はそれぞれ独立したクレートとしてコンパイルされる
//! (Rustの慣習)ため、共通コードはこの`tests/common/mod.rs`に置き、各テスト
//! ファイルの先頭で`mod common;`して取り込む。
//!
//! M4-9で中間LASを廃止したため、受け入れテストは`pcv_convert::import`の出力
//! (COPC)を直接`pcv_core::CopcFile`で読み、点数・座標・色・強度を確認する形に
//! 書き換えた(以前はLASを`las::Reader`で読んでいた)。
#![allow(dead_code)] // 各テストファイルがこの中の関数をすべて使うわけではない。

use pcv_core::{CopcFile, HEADER_BYTES, POINT_STRIDE};

/// デコードした1点(世界座標・8bit RGBA・16bit intensity)。
#[derive(Debug, Clone, Copy)]
pub struct DecodedPoint {
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub color: [u8; 3],
    pub intensity: u16,
}

/// `pcv_core::NodeBuffer::bytes`(`crates/pcv-core/src/node_format.rs`の形式。
/// ヘッダ32B+点20B)を読み、世界座標へ戻した点のリストを返す。
fn decode_node_points(bytes: &[u8], point_count: u32) -> Vec<DecodedPoint> {
    // ヘッダ(32B): magic(4)+version(4)+point_count(4)+stride(4)+origin_x(4)+
    // origin_y(4)+origin_z(4)+flags(4)(`crates/pcv-core/src/node_format.rs`
    // 冒頭のバイナリレイアウト参照)。originはオフセット16から始まる。
    assert_eq!(&bytes[0..4], b"PCVN", "ノードバッファのmagicが一致しない");
    let origin_x = f32::from_le_bytes(bytes[16..20].try_into().unwrap()) as f64;
    let origin_y = f32::from_le_bytes(bytes[20..24].try_into().unwrap()) as f64;
    let origin_z = f32::from_le_bytes(bytes[24..28].try_into().unwrap()) as f64;

    let mut out = Vec::with_capacity(point_count as usize);
    for i in 0..point_count as usize {
        let base = HEADER_BYTES + i * POINT_STRIDE;
        let rel_x = f32::from_le_bytes(bytes[base..base + 4].try_into().unwrap()) as f64;
        let rel_y = f32::from_le_bytes(bytes[base + 4..base + 8].try_into().unwrap()) as f64;
        let rel_z = f32::from_le_bytes(bytes[base + 8..base + 12].try_into().unwrap()) as f64;
        let color = [bytes[base + 12], bytes[base + 13], bytes[base + 14]];
        let intensity = u16::from_le_bytes(bytes[base + 16..base + 18].try_into().unwrap());
        out.push(DecodedPoint {
            x: origin_x + rel_x,
            y: origin_y + rel_y,
            z: origin_z + rel_z,
            color,
            intensity,
        });
    }
    out
}

/// COPCを`pcv_core`で開き、ヘッダーの申告点数と、全ノードを読んで集めた
/// 世界座標の点リストを返す。ノード間・ノード内の点の順序は元ファイルの
/// 順序と一致する保証が無いため、呼び出し側は「集合として一致するか」で
/// 比較すること(個々の点が期待値のどれかと十分近いかを、使い切り
/// (重複利用しない)で突き合わせる。[`match_points_by_xyz`]参照)。
pub fn read_all_points(copc_path: &std::path::Path) -> (u64, Vec<DecodedPoint>) {
    let mut copc = CopcFile::open(copc_path).expect("open copc with pcv-core");
    let declared = copc.info().point_count;
    let keys: Vec<_> = copc.hierarchy().nodes().map(|n| n.key).collect();
    let mut points = Vec::new();
    for key in keys {
        let buffer = copc.read_node(key).expect("read_node");
        points.extend(decode_node_points(&buffer.bytes, buffer.point_count));
    }
    (declared, points)
}

/// `pcv_core::color_depth`(非公開)と同じ判定をテスト側で再現する
/// (`crates/pcv-core/src/color_depth.rs`参照: ルートノードの色のどれか1つの
/// チャンネルでも255を超えていれば16bitとして`>>8`、そうでなければ8bitの
/// 値をそのまま使う)。期待値(変換前の形式ごとの正規化式で手計算した
/// 16bit色)から、COPCを経由した後にNodeBufferへ現れるはずの8bit色を導く。
pub fn expected_u8_colors(expected_16bit: &[[u16; 3]]) -> Vec<[u8; 3]> {
    let is_sixteen = expected_16bit
        .iter()
        .any(|c| c.iter().any(|&channel| channel > 255));
    expected_16bit
        .iter()
        .map(|&[r, g, b]| {
            if is_sixteen {
                [(r >> 8) as u8, (g >> 8) as u8, (b >> 8) as u8]
            } else {
                [r as u8, g as u8, b as u8]
            }
        })
        .collect()
}

/// 期待される点(世界座標・8bit色・16bit強度)の集合と、COPCから読み戻した
/// 点の集合を、順序に依存せず突き合わせる。各期待点について、まだ使って
/// いない実点のうち座標が許容誤差内で最も近いものを1つ消費する
/// (多対1のすり替わりを防ぐため、一致した実点は次の探索から除く)。
pub fn assert_points_match_unordered(
    expected: &[(f64, f64, f64, [u8; 3], u16)],
    actual: &[DecodedPoint],
    xyz_tolerance: f64,
) {
    assert_eq!(
        expected.len(),
        actual.len(),
        "点数が一致しない(期待{}, 実際{})",
        expected.len(),
        actual.len()
    );
    let mut remaining: Vec<&DecodedPoint> = actual.iter().collect();
    for &(ex, ey, ez, ecolor, eintensity) in expected {
        let found_index = remaining.iter().position(|p| {
            (p.x - ex).abs() <= xyz_tolerance
                && (p.y - ey).abs() <= xyz_tolerance
                && (p.z - ez).abs() <= xyz_tolerance
                && p.color == ecolor
                && p.intensity == eintensity
        });
        let index = found_index.unwrap_or_else(|| {
            panic!(
                "期待した点(x={ex}, y={ey}, z={ez}, color={ecolor:?}, intensity={eintensity})に\
                 一致する実点が見つからない。残りの実点: {remaining:?}"
            )
        });
        remaining.remove(index);
    }
}
