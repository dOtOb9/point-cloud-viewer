//! PCD → LAS の受け入れテスト(M4-4)。
//!
//! ASCII・binary・binary_compressed(LZF圧縮)の3形式すべてを確かめる。
//! binary_compressedのテストファイルは自分でLZFを実装する代わりに、
//! `pcd-rs`自身の`DynWriter`(`DataKind::BinaryCompressed`)で作る
//! (`crates/pcv-convert/src/import/pcd.rs`のモジュールコメント参照)。

use pcd_rs::{DataKind, DynRecord, DynWriter, Field, Schema, ValueKind, WriterInit};
use pcv_convert::import::to_las;

/// (x, y, z, (r, g, b), intensity)。
type SamplePoint = (f32, f32, f32, (u8, u8, u8), f32);

/// x, y, z, rgb(packed f32), intensity(f32)のスキーマ。
fn xyz_rgb_intensity_schema() -> Schema {
    Schema::from_iter([
        ("x", ValueKind::F32, 1),
        ("y", ValueKind::F32, 1),
        ("z", ValueKind::F32, 1),
        ("rgb", ValueKind::F32, 1),
        ("intensity", ValueKind::F32, 1),
    ])
}

/// (x, y, z, (r,g,b), intensity)の4点。色はLASの16bit幅へ`*257`で写る前提の
/// 8bit値、強度はPCDに正規化の規約が無いため生の値をそのまま丸める前提の値。
fn sample_points() -> Vec<SamplePoint> {
    vec![
        (0.0, 0.0, 0.0, (0, 0, 0), 0.0),
        (1.5, -2.25, 3.75, (255, 128, 0), 500.0),
        (-10.0, 20.0, -30.0, (10, 200, 40), 12345.0),
        (100.0, 200.0, 300.0, (255, 255, 255), 65535.0),
    ]
}

fn write_binary_pcd(path: &std::path::Path, compressed: bool) {
    let points = sample_points();
    let mut writer: DynWriter<_> = WriterInit {
        width: points.len() as u64,
        height: 1,
        viewpoint: Default::default(),
        data_kind: if compressed {
            DataKind::BinaryCompressed
        } else {
            DataKind::Binary
        },
        schema: Some(xyz_rgb_intensity_schema()),
        version: None,
    }
    .create(path)
    .expect("create pcd writer");

    for (x, y, z, (r, g, b), intensity) in &points {
        let rgb = pcd_rs::rgb_to_float(*r, *g, *b);
        let record = DynRecord(vec![
            Field::F32(vec![*x]),
            Field::F32(vec![*y]),
            Field::F32(vec![*z]),
            Field::F32(vec![rgb]),
            Field::F32(vec![*intensity]),
        ]);
        writer.push(&record).expect("push point");
    }
    writer.finish().expect("finish pcd writer");
}

fn assert_las_matches_sample(las_path: &std::path::Path) {
    let points = sample_points();
    let mut reader = las::Reader::from_path(las_path).expect("open las");
    assert_eq!(reader.header().number_of_points(), points.len() as u64);

    let point_data = reader.read_all().expect("read all points");
    let mut read_points = Vec::new();
    for p in point_data.points() {
        read_points.push(p.expect("read point"));
    }
    assert_eq!(read_points.len(), points.len());

    for ((expected_x, expected_y, expected_z, (r, g, b), expected_intensity), actual) in
        points.iter().zip(read_points.iter())
    {
        // scaleの丸め誤差の範囲内(choose_scale_offsetのテストどおり、
        // 誤差はscale/2以内。ここではLAS側のtransformsから実際のscaleを取る)。
        let transforms = reader.header().transforms();
        assert!((actual.x - *expected_x as f64).abs() <= transforms.x.scale / 2.0 + 1e-9);
        assert!((actual.y - *expected_y as f64).abs() <= transforms.y.scale / 2.0 + 1e-9);
        assert!((actual.z - *expected_z as f64).abs() <= transforms.z.scale / 2.0 + 1e-9);

        let color = actual.color.expect("color present");
        assert_eq!(color.red, u16::from(*r) * 257);
        assert_eq!(color.green, u16::from(*g) * 257);
        assert_eq!(color.blue, u16::from(*b) * 257);

        assert_eq!(
            actual.intensity,
            expected_intensity.round().clamp(0.0, u16::MAX as f32) as u16
        );
    }
}

#[test]
fn ascii_pcd_without_color_round_trips_xyz_and_intensity() {
    let dir = tempfile::tempdir().expect("tempdir");
    let input_path = dir.path().join("in.pcd");
    let output_path = dir.path().join("out.las");

    // x/y/z/intensityのみ(色なし)。PCDのASCIIヘッダは単純なテキストなので
    // ここでは手で組み立てる。
    let pcd_text = "\
# .PCD v0.7 - Point Cloud Data file format
VERSION 0.7
FIELDS x y z intensity
SIZE 4 4 4 4
TYPE F F F F
COUNT 1 1 1 1
WIDTH 3
HEIGHT 1
VIEWPOINT 0 0 0 1 0 0 0
POINTS 3
DATA ascii
0 0 0 0
1.5 -2.25 3.75 500
-10 20 -30 70000
";
    std::fs::write(&input_path, pcd_text).expect("write pcd");

    let summary = to_las(&input_path, &output_path, None).expect("to_las");
    assert_eq!(summary.point_count, 3);
    assert!(!summary.crs_known);

    let mut reader = las::Reader::from_path(&output_path).expect("open las");
    assert_eq!(reader.header().number_of_points(), 3);
    let points: Vec<_> = reader
        .read_all()
        .expect("read all points")
        .points()
        .map(|p| p.expect("point"))
        .collect();
    assert_eq!(points[0].color, None);
    // scaleの丸め誤差の範囲内での比較(choose_scale_offsetのテスト参照)。
    assert!((points[1].x - 1.5).abs() < 1e-6);
    assert!((points[1].y - (-2.25)).abs() < 1e-6);
    assert!((points[1].z - 3.75).abs() < 1e-6);
    assert_eq!(points[1].intensity, 500);
    // 70000は intensity(u16) の範囲を超えるので65535へクランプされる。
    assert_eq!(points[2].intensity, 65535);
}

#[test]
fn binary_pcd_round_trips_xyz_color_and_intensity() {
    let dir = tempfile::tempdir().expect("tempdir");
    let input_path = dir.path().join("in.pcd");
    let output_path = dir.path().join("out.las");

    write_binary_pcd(&input_path, false);
    let summary = to_las(&input_path, &output_path, None).expect("to_las");
    assert_eq!(summary.point_count, sample_points().len() as u64);
    assert_las_matches_sample(&output_path);
}

#[test]
fn binary_compressed_pcd_round_trips_xyz_color_and_intensity() {
    let dir = tempfile::tempdir().expect("tempdir");
    let input_path = dir.path().join("in_compressed.pcd");
    let output_path = dir.path().join("out.las");

    write_binary_pcd(&input_path, true);

    // 実際にDATA行がbinary_compressedになっていることを確かめる
    // (LZF展開の経路を本当に通っていることの裏付け)。
    let bytes = std::fs::read(&input_path).expect("read pcd");
    let text_head = String::from_utf8_lossy(&bytes[..bytes.len().min(300)]);
    assert!(text_head.contains("DATA binary_compressed"));

    let summary = to_las(&input_path, &output_path, None).expect("to_las");
    assert_eq!(summary.point_count, sample_points().len() as u64);
    assert_las_matches_sample(&output_path);
}

/// CRSを指定した場合は「分かっている」扱いになり、LASヘッダーにWKTとして
/// 書き込まれる(呼び出し側が引数で渡す口の確認。PCD自体はCRSを持たない)。
#[test]
fn crs_wkt_is_written_when_provided_and_unknown_when_not() {
    let dir = tempfile::tempdir().expect("tempdir");
    let input_path = dir.path().join("in.pcd");

    write_binary_pcd(&input_path, false);

    let output_with_crs = dir.path().join("with_crs.las");
    let wkt = b"PROJCS[\"JGD2011 / Japan Plane Rectangular CS IX\"]".to_vec();
    let summary = to_las(&input_path, &output_with_crs, Some(wkt.clone())).expect("to_las");
    assert!(summary.crs_known);
    let reader = las::Reader::from_path(&output_with_crs).expect("open las");
    assert_eq!(reader.header().get_wkt_crs_bytes(), Some(wkt.as_slice()));

    let output_without_crs = dir.path().join("without_crs.las");
    let summary = to_las(&input_path, &output_without_crs, None).expect("to_las");
    assert!(!summary.crs_known);
    let reader = las::Reader::from_path(&output_without_crs).expect("open las");
    assert_eq!(reader.header().get_wkt_crs_bytes(), None);
}
