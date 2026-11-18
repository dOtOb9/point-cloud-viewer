#![allow(dead_code)]

use pcv_core::{CopcFile, HEADER_BYTES, POINT_STRIDE};

#[derive(Debug, Clone, Copy)]
pub struct DecodedPoint {
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub color: [u8; 3],
    pub intensity: u16,
}

fn decode_node_points(bytes: &[u8], point_count: u32) -> Vec<DecodedPoint> {
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
