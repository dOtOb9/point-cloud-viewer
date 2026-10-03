//! PLY → COPC の受け入れテスト(M4-4→M4-9で中間LASを経ない形に書き換え)。
//!
//! ASCII・binary_little_endian・binary_big_endianの3形式すべてを確かめる。
//! `ply-rs`を使わず自前実装にした(`crates/pcv-convert/src/import/ply.rs`
//! コメント参照)ため、テストデータも自分でバイト列/テキストを組み立てる。
//! `face`要素(可変長のlistプロパティ)を混ぜたケースで、vertex以外の要素も
//! 正しくスキップできる(バイト位置がずれない)ことも確認する。

mod common;

use copc_core::NeverCancel;
use copc_writer::CopcWriterParams;
use pcv_convert::import::convert_path_to_copc;

type SamplePoint = (f32, f32, f32, u8, u8, u8, f32);

fn sample_points() -> Vec<SamplePoint> {
    vec![
        (0.0, 0.0, 0.0, 0, 0, 0, 0.0),
        (1.5, -2.25, 3.75, 255, 128, 0, 0.5),
        (-10.0, 20.0, -30.0, 10, 200, 40, 1.0),
        (100.0, 200.0, 300.0, 255, 255, 255, 0.25),
    ]
}

fn ply_header(format_line: &str, vertex_count: usize, include_faces: bool) -> String {
    let mut header = String::new();
    header.push_str("ply\n");
    header.push_str(format_line);
    header.push_str(&format!("element vertex {vertex_count}\n"));
    header.push_str("property float x\n");
    header.push_str("property float y\n");
    header.push_str("property float z\n");
    header.push_str("property uchar red\n");
    header.push_str("property uchar green\n");
    header.push_str("property uchar blue\n");
    header.push_str("property float intensity\n");
    if include_faces {
        header.push_str("element face 1\n");
        header.push_str("property list uchar int vertex_indices\n");
    }
    header.push_str("end_header\n");
    header
}

fn build_ascii_ply(points: &[SamplePoint], include_faces: bool) -> Vec<u8> {
    let mut text = ply_header("format ascii 1.0\n", points.len(), include_faces);
    for &(x, y, z, r, g, b, intensity) in points {
        text.push_str(&format!("{x} {y} {z} {r} {g} {b} {intensity}\n"));
    }
    if include_faces {
        // 全頂点を1つのfaceにまとめた、内容に意味の無いダミーのface行
        // (点群としての読み込みには使わないが、正しくスキップできるかを見る)。
        let indices: Vec<String> = (0..points.len()).map(|i| i.to_string()).collect();
        text.push_str(&format!("{} {}\n", points.len(), indices.join(" ")));
    }
    text.into_bytes()
}

fn build_binary_ply(points: &[SamplePoint], little_endian: bool, include_faces: bool) -> Vec<u8> {
    let format_line = if little_endian {
        "format binary_little_endian 1.0\n"
    } else {
        "format binary_big_endian 1.0\n"
    };
    let mut out = ply_header(format_line, points.len(), include_faces).into_bytes();

    for &(x, y, z, r, g, b, intensity) in points {
        push_f32(&mut out, x, little_endian);
        push_f32(&mut out, y, little_endian);
        push_f32(&mut out, z, little_endian);
        out.push(r);
        out.push(g);
        out.push(b);
        push_f32(&mut out, intensity, little_endian);
    }
    if include_faces {
        out.push(points.len() as u8); // list count (uchar)
        for i in 0..points.len() {
            push_i32(&mut out, i as i32, little_endian);
        }
    }
    out
}

fn push_f32(out: &mut Vec<u8>, value: f32, little_endian: bool) {
    if little_endian {
        out.extend_from_slice(&value.to_le_bytes());
    } else {
        out.extend_from_slice(&value.to_be_bytes());
    }
}

fn push_i32(out: &mut Vec<u8>, value: i32, little_endian: bool) {
    if little_endian {
        out.extend_from_slice(&value.to_le_bytes());
    } else {
        out.extend_from_slice(&value.to_be_bytes());
    }
}

/// `in.ply`を変換して開き、`sample_points()`と座標・色・強度が一致することを
/// 確認する(スケールの丸め誤差の範囲内。M4-9受け入れ条件)。
fn assert_copc_matches_sample(copc_path: &std::path::Path) {
    let points = sample_points();
    let (declared, actual) = common::read_all_points(copc_path);
    assert_eq!(declared, points.len() as u64);

    let expected_16bit_colors: Vec<[u16; 3]> = points
        .iter()
        .map(|&(_, _, _, r, g, b, _)| [u16::from(r) * 257, u16::from(g) * 257, u16::from(b) * 257])
        .collect();
    let expected_u8_colors = common::expected_u8_colors(&expected_16bit_colors);

    let expected: Vec<(f64, f64, f64, [u8; 3], u16)> = points
        .iter()
        .zip(expected_u8_colors.iter())
        .map(|(&(x, y, z, _, _, _, intensity), &color)| {
            let expected_intensity = (intensity.clamp(0.0, 1.0) * 65535.0).round() as u16;
            (
                f64::from(x),
                f64::from(y),
                f64::from(z),
                color,
                expected_intensity,
            )
        })
        .collect();

    // スケールはmm以下精度で選ばれる(`scale.rs`)ので、丸め誤差は高々0.5mm。
    // f32(ノードローカル相対座標)の丸めぶんの余裕も持たせる。
    common::assert_points_match_unordered(&expected, &actual, 0.001);
}

fn convert(input_path: &std::path::Path, output_path: &std::path::Path) -> u64 {
    let dir = output_path.parent().unwrap();
    let summary = convert_path_to_copc(
        input_path,
        output_path,
        dir,
        &CopcWriterParams::default(),
        &NeverCancel,
        None,
        |_| {},
    )
    .expect("convert_path_to_copc");
    assert!(!summary.crs_known);
    summary.point_count
}

#[test]
fn ascii_ply_round_trips_xyz_color_and_intensity() {
    let dir = tempfile::tempdir().expect("tempdir");
    let input_path = dir.path().join("in.ply");
    let output_path = dir.path().join("out.copc.laz");

    std::fs::write(&input_path, build_ascii_ply(&sample_points(), false)).expect("write ply");

    let point_count = convert(&input_path, &output_path);
    assert_eq!(point_count, sample_points().len() as u64);
    assert_copc_matches_sample(&output_path);
}

#[test]
fn binary_little_endian_ply_round_trips() {
    let dir = tempfile::tempdir().expect("tempdir");
    let input_path = dir.path().join("in.ply");
    let output_path = dir.path().join("out.copc.laz");

    std::fs::write(&input_path, build_binary_ply(&sample_points(), true, false))
        .expect("write ply");

    let point_count = convert(&input_path, &output_path);
    assert_eq!(point_count, sample_points().len() as u64);
    assert_copc_matches_sample(&output_path);
}

#[test]
fn binary_big_endian_ply_round_trips() {
    let dir = tempfile::tempdir().expect("tempdir");
    let input_path = dir.path().join("in.ply");
    let output_path = dir.path().join("out.copc.laz");

    std::fs::write(
        &input_path,
        build_binary_ply(&sample_points(), false, false),
    )
    .expect("write ply");

    let point_count = convert(&input_path, &output_path);
    assert_eq!(point_count, sample_points().len() as u64);
    assert_copc_matches_sample(&output_path);
}

/// `face`要素(可変長のlistプロパティ)が`vertex`の後ろにあるメッシュ形式のPLYでも、
/// バイト位置がずれずに`vertex`だけを正しく読めることを確認する
/// (ASCII/binary_little_endianの両方で。big_endianの読み出し自体は上のテストで
/// 別途確認済みなので、ここでは組み合わせを増やしすぎない)。
#[test]
fn ascii_ply_with_face_element_skips_it_correctly() {
    let dir = tempfile::tempdir().expect("tempdir");
    let input_path = dir.path().join("in.ply");
    let output_path = dir.path().join("out.copc.laz");

    std::fs::write(&input_path, build_ascii_ply(&sample_points(), true)).expect("write ply");

    let point_count = convert(&input_path, &output_path);
    assert_eq!(point_count, sample_points().len() as u64);
    assert_copc_matches_sample(&output_path);
}

#[test]
fn binary_ply_with_face_element_skips_it_correctly() {
    let dir = tempfile::tempdir().expect("tempdir");
    let input_path = dir.path().join("in.ply");
    let output_path = dir.path().join("out.copc.laz");

    std::fs::write(&input_path, build_binary_ply(&sample_points(), true, true)).expect("write ply");

    let point_count = convert(&input_path, &output_path);
    assert_eq!(point_count, sample_points().len() as u64);
    assert_copc_matches_sample(&output_path);
}
