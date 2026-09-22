//! ノードのバイナリレイアウト（ヘッダ32B + 点20B）。M1-2 で決めた形式。
//!
//! Rust と TypeScript の間で重いデータをやり取りする唯一のインターフェースなので、
//! この形式は `pcv-core` の中に1箇所だけ持つ。フロント側のパーサは
//! `src/datasource/node-format.ts` にあり、ここで書いた並びをそのまま読み返す。
//! 形式を変えるときは両方を同じコミットで直すこと。
//!
//! ```text
//! [ヘッダ 32 bytes]
//!   u32   magic        "PCVN" (バイト列そのまま。エンディアン非依存)
//!   u32   version      1
//!   u32   point_count
//!   u32   stride       20
//!   f32   origin_x     ノードローカル座標の原点（世界座標をf32に丸めた値）
//!   f32   origin_y
//!   f32   origin_z
//!   u32   flags        どの属性が有効か（FLAG_* を参照）
//!
//! [点配列 point_count × 20 bytes]
//!   f32 x3   position       ノード原点からの相対座標
//!   u8  x4   color RGBA
//!   u16      intensity
//!   u8       classification
//!   u8       _padding
//! ```
//!
//! ## なぜノードローカル相対座標にするのか
//!
//! COPCの座標は f64 の世界座標で、実測データはUTM系などで大きな値（例:
//! X=500000.123）を取る。素朴にf32へ落とすと仮数部が足りずmm〜cm単位の精度が
//! 消え、点群がグリッド状にガタつく。そこでノードごとに原点を持たせ、点は
//! **その原点からの相対座標**をf32で持つ。原点はシェーダのuniformとして渡し、
//! ビュー行列側で吸収する（GPUにf64は無いので、absolute座標をf32に戻す計算は
//! 一度もしない）。

/// ヘッダの magic。ASCII "PCVN"。
pub const MAGIC: &[u8; 4] = b"PCVN";
/// ヘッダのバージョン。形式を変えたら上げる。
pub const VERSION: u32 = 1;
/// ヘッダのバイト数。
pub const HEADER_BYTES: usize = 32;
/// 1点あたりのバイト数。
pub const POINT_STRIDE: usize = 20;

/// 色属性が有効かどうかのフラグビット。
pub const FLAG_COLOR: u32 = 1 << 0;
/// 強度属性が有効かどうかのフラグビット（COPCが要求するLASフォーマット6-8では常に有効）。
pub const FLAG_INTENSITY: u32 = 1 << 1;
/// 分類属性が有効かどうかのフラグビット（同上、常に有効）。
pub const FLAG_CLASSIFICATION: u32 = 1 << 2;

/// エンコード前の1点。座標はまだ世界座標（f64）のまま持つ。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct NodePoint {
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub color: Option<[u8; 4]>,
    pub intensity: u16,
    pub classification: u8,
}

/// エンコード済みのノード。`pcv://` のレスポンスボディにそのまま使う。
#[derive(Debug, Clone)]
pub struct NodeBuffer {
    pub bytes: Vec<u8>,
    pub point_count: u32,
}

/// 点群とノード原点から、上記のバイナリ形式を組み立てる。
///
/// `origin` は世界座標（f64）で渡す。ヘッダにはf32に丸めた値を書き込むが、
/// **各点の相対座標もその丸めた値からの差分として計算する**。丸め誤差ではなく
/// 本当の相対距離だけを相対座標に残すためで、ここを素朴に「元のorigin(f64)から
/// 引いてからf32化」すると、丸め誤差ぶんだけ復元後の位置がずれる。
pub fn encode_node(points: &[NodePoint], origin: [f64; 3], has_color: bool) -> NodeBuffer {
    let origin_f32 = [origin[0] as f32, origin[1] as f32, origin[2] as f32];
    // ヘッダに書くのと同じ丸め済みの値をf64に戻してから引く（上記コメント参照）。
    let origin_rounded = [
        f64::from(origin_f32[0]),
        f64::from(origin_f32[1]),
        f64::from(origin_f32[2]),
    ];

    let mut flags = FLAG_INTENSITY | FLAG_CLASSIFICATION;
    if has_color {
        flags |= FLAG_COLOR;
    }

    let point_count = u32::try_from(points.len()).expect("1ノードの点数はu32に収まる想定");
    let mut bytes = Vec::with_capacity(HEADER_BYTES + points.len() * POINT_STRIDE);

    bytes.extend_from_slice(MAGIC);
    bytes.extend_from_slice(&VERSION.to_le_bytes());
    bytes.extend_from_slice(&point_count.to_le_bytes());
    bytes.extend_from_slice(&(POINT_STRIDE as u32).to_le_bytes());
    bytes.extend_from_slice(&origin_f32[0].to_le_bytes());
    bytes.extend_from_slice(&origin_f32[1].to_le_bytes());
    bytes.extend_from_slice(&origin_f32[2].to_le_bytes());
    bytes.extend_from_slice(&flags.to_le_bytes());
    debug_assert_eq!(bytes.len(), HEADER_BYTES);

    for p in points {
        let rel_x = (p.x - origin_rounded[0]) as f32;
        let rel_y = (p.y - origin_rounded[1]) as f32;
        let rel_z = (p.z - origin_rounded[2]) as f32;
        bytes.extend_from_slice(&rel_x.to_le_bytes());
        bytes.extend_from_slice(&rel_y.to_le_bytes());
        bytes.extend_from_slice(&rel_z.to_le_bytes());

        let [r, g, b, a] = p.color.unwrap_or([255, 255, 255, 255]);
        bytes.push(r);
        bytes.push(g);
        bytes.push(b);
        bytes.push(a);

        bytes.extend_from_slice(&p.intensity.to_le_bytes());
        bytes.push(p.classification);
        bytes.push(0); // padding
    }

    debug_assert_eq!(bytes.len(), HEADER_BYTES + points.len() * POINT_STRIDE);
    NodeBuffer { bytes, point_count }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header_and_stride_constants_match_the_documented_layout() {
        assert_eq!(HEADER_BYTES, 32);
        assert_eq!(POINT_STRIDE, 20);
        assert_eq!(MAGIC, b"PCVN");
    }

    #[test]
    fn encode_node_produces_header_plus_stride_times_count_bytes() {
        let points = vec![
            NodePoint {
                x: 1.0,
                y: 2.0,
                z: 3.0,
                color: Some([10, 20, 30, 255]),
                intensity: 100,
                classification: 2,
            },
            NodePoint {
                x: 1.5,
                y: 2.5,
                z: 3.5,
                color: None,
                intensity: 200,
                classification: 5,
            },
        ];
        let buf = encode_node(&points, [1.0, 2.0, 3.0], true);

        assert_eq!(buf.point_count, 2);
        assert_eq!(buf.bytes.len(), HEADER_BYTES + 2 * POINT_STRIDE);
        assert_eq!(&buf.bytes[0..4], MAGIC);
    }

    #[test]
    fn header_fields_round_trip() {
        let points = vec![NodePoint {
            x: 500_000.123,
            y: 4_000_000.456,
            z: 12.75,
            color: None,
            intensity: 42,
            classification: 1,
        }];
        let origin = [500_000.0, 4_000_000.0, 12.0];
        let buf = encode_node(&points, origin, false);

        let version = u32::from_le_bytes(buf.bytes[4..8].try_into().unwrap());
        let point_count = u32::from_le_bytes(buf.bytes[8..12].try_into().unwrap());
        let stride = u32::from_le_bytes(buf.bytes[12..16].try_into().unwrap());
        let origin_x = f32::from_le_bytes(buf.bytes[16..20].try_into().unwrap());
        let flags = u32::from_le_bytes(buf.bytes[28..32].try_into().unwrap());

        assert_eq!(version, VERSION);
        assert_eq!(point_count, 1);
        assert_eq!(stride, POINT_STRIDE as u32);
        assert_eq!(origin_x, 500_000.0_f32);
        assert_eq!(
            flags & FLAG_COLOR,
            0,
            "has_color=falseならFLAG_COLORは立たない"
        );
        assert_ne!(flags & FLAG_INTENSITY, 0);
        assert_ne!(flags & FLAG_CLASSIFICATION, 0);
    }

    #[test]
    fn relative_position_absorbs_the_origin_rounding_error() {
        // originをf32に丸めた時点で誤差が出るような値を意図的に選ぶ。
        let origin = [500_000.123_456_789, 0.0, 0.0];
        let points = vec![NodePoint {
            x: 500_000.123_456_789,
            y: 0.0,
            z: 0.0,
            color: None,
            intensity: 0,
            classification: 0,
        }];
        let buf = encode_node(&points, origin, false);

        let origin_x = f32::from_le_bytes(buf.bytes[16..20].try_into().unwrap());
        let rel_x = f32::from_le_bytes(buf.bytes[32..36].try_into().unwrap());

        // 「丸めたorigin + 相対座標」で元の点にほぼ戻る（f32の丸め誤差程度の差に収まる）はず。
        // 素朴に f64 の origin をそのまま引いてからf32化すると、ここが大きくずれる。
        let reconstructed = f64::from(origin_x) + f64::from(rel_x);
        assert!(
            (reconstructed - points[0].x).abs() < 1e-3,
            "reconstructed={reconstructed} original={}",
            points[0].x
        );
    }
}
