//! PCD → COPC の受け入れテスト(M4-4→M4-9で中間LASを経ない形に書き換え)。
//!
//! ASCII・binary・binary_compressed(LZF圧縮)の3形式すべてを確かめる。
//! binary_compressedのテストファイルは自分でLZFを実装する代わりに、
//! `pcd-rs`自身の`DynWriter`(`DataKind::BinaryCompressed`)で作る
//! (`crates/pcv-convert/src/import/pcd.rs`のモジュールコメント参照)。

mod common;

use copc_core::NeverCancel;
use copc_writer::CopcWriterParams;
use pcd_rs::{DataKind, DynRecord, DynWriter, Field, Schema, ValueKind, WriterInit};
use pcv_convert::import::convert_path_to_copc;

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

fn convert(
    input_path: &std::path::Path,
    output_path: &std::path::Path,
) -> pcv_convert::import::ImportSummary {
    let dir = output_path.parent().unwrap();
    convert_path_to_copc(
        input_path,
        output_path,
        dir,
        &CopcWriterParams::default(),
        &NeverCancel,
        None,
        |_| {},
    )
    .expect("convert_path_to_copc")
}

/// `out.copc.laz`を開き、`sample_points()`と座標・色・強度が一致することを
/// 確認する(スケールの丸め誤差の範囲内。M4-9受け入れ条件)。
fn assert_copc_matches_sample(copc_path: &std::path::Path) {
    let points = sample_points();
    let (declared, actual) = common::read_all_points(copc_path);
    assert_eq!(declared, points.len() as u64);

    let expected_16bit_colors: Vec<[u16; 3]> = points
        .iter()
        .map(|&(_, _, _, (r, g, b), _)| {
            [u16::from(r) * 257, u16::from(g) * 257, u16::from(b) * 257]
        })
        .collect();
    let expected_u8_colors = common::expected_u8_colors(&expected_16bit_colors);

    let expected: Vec<(f64, f64, f64, [u8; 3], u16)> = points
        .iter()
        .zip(expected_u8_colors.iter())
        .map(|(&(x, y, z, _, intensity), &color)| {
            let expected_intensity = intensity.round().clamp(0.0, u16::MAX as f32) as u16;
            (
                f64::from(x),
                f64::from(y),
                f64::from(z),
                color,
                expected_intensity,
            )
        })
        .collect();

    common::assert_points_match_unordered(&expected, &actual, 0.001);
}

#[test]
fn ascii_pcd_without_color_round_trips_xyz_and_intensity() {
    let dir = tempfile::tempdir().expect("tempdir");
    let input_path = dir.path().join("in.pcd");
    let output_path = dir.path().join("out.copc.laz");

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

    let summary = convert(&input_path, &output_path);
    assert_eq!(summary.point_count, 3);
    assert!(!summary.crs_known);

    let (declared, points) = common::read_all_points(&output_path);
    assert_eq!(declared, 3);
    // 色フィールドが無いPCDなので、全点が色無し。`pcv_core::NodeBuffer`は
    // 色無しの点を白(255,255,255)として符号化する
    // (`crates/pcv-core/src/node_format.rs`の`encode_node`の既定値。
    // 「不明な色は黒ではなく白」という表示上の割り切り)。
    for p in &points {
        assert_eq!(p.color, [255, 255, 255]);
    }
    let expected_xyz = [(0.0, 0.0, 0.0), (1.5, -2.25, 3.75), (-10.0, 20.0, -30.0)];
    let expected_intensity = [0u16, 500, 65535]; // 70000は65535へクランプされる。
    let expected: Vec<(f64, f64, f64, [u8; 3], u16)> = expected_xyz
        .iter()
        .zip(expected_intensity.iter())
        .map(|(&(x, y, z), &i)| (x, y, z, [255, 255, 255], i))
        .collect();
    common::assert_points_match_unordered(&expected, &points, 0.001);
}

#[test]
fn binary_pcd_round_trips_xyz_color_and_intensity() {
    let dir = tempfile::tempdir().expect("tempdir");
    let input_path = dir.path().join("in.pcd");
    let output_path = dir.path().join("out.copc.laz");

    write_binary_pcd(&input_path, false);
    let summary = convert(&input_path, &output_path);
    assert_eq!(summary.point_count, sample_points().len() as u64);
    assert_copc_matches_sample(&output_path);
}

#[test]
fn binary_compressed_pcd_round_trips_xyz_color_and_intensity() {
    let dir = tempfile::tempdir().expect("tempdir");
    let input_path = dir.path().join("in_compressed.pcd");
    let output_path = dir.path().join("out.copc.laz");

    write_binary_pcd(&input_path, true);

    // 実際にDATA行がbinary_compressedになっていることを確かめる
    // (LZF展開の経路を本当に通っていることの裏付け)。
    let bytes = std::fs::read(&input_path).expect("read pcd");
    let text_head = String::from_utf8_lossy(&bytes[..bytes.len().min(300)]);
    assert!(text_head.contains("DATA binary_compressed"));

    let summary = convert(&input_path, &output_path);
    assert_eq!(summary.point_count, sample_points().len() as u64);
    assert_copc_matches_sample(&output_path);
}

/// `binary_compressed`の展開後サイズが上限を超える入力は、重い展開を
/// 始める前にエラーになることを確認する(`pcd.rs`の
/// `MAX_BINARY_COMPRESSED_UNCOMPRESSED_BYTES`参照)。実際に上限を超える
/// ファイルを作るのは重いので、ヘッダー直後の`uncompressed_size`
/// フィールドだけを直接書き換えた、最小限の偽データで確かめる。
#[test]
fn binary_compressed_pcd_over_size_limit_is_rejected_before_decompressing() {
    let dir = tempfile::tempdir().expect("tempdir");
    let input_path = dir.path().join("huge_compressed.pcd");
    let output_path = dir.path().join("out.copc.laz");

    write_binary_pcd(&input_path, true);
    let mut bytes = std::fs::read(&input_path).expect("read pcd");

    // ヘッダー直後の8バイトは(compressed_size, uncompressed_size)の
    // リトルエンディアンu32(PCD binary_compressedの仕様、`pcd.rs`参照)。
    // ヘッダーの終わり("DATA binary_compressed\n"の直後)を探し、
    // uncompressed_size(先頭から数えて2つ目のu32)だけを上限超えの値に書き換える。
    let marker = b"DATA binary_compressed\n";
    let data_start = bytes
        .windows(marker.len())
        .position(|w| w == marker)
        .expect("DATA行が見つからない")
        + marker.len();
    let uncompressed_size_offset = data_start + 4;
    let huge = (1024u32 * 1024 * 1024).to_le_bytes(); // 1GiB > 512MiBの上限。
    bytes[uncompressed_size_offset..uncompressed_size_offset + 4].copy_from_slice(&huge);
    std::fs::write(&input_path, &bytes).expect("rewrite pcd with huge uncompressed_size");

    let dir_path = output_path.parent().unwrap();
    let err = convert_path_to_copc(
        &input_path,
        &output_path,
        dir_path,
        &CopcWriterParams::default(),
        &NeverCancel,
        None,
        |_| {},
    )
    .expect_err("上限超えはエラーになるはず");
    let message = err.to_string();
    assert!(
        message.contains("binary_compressed"),
        "エラーメッセージに形式名が含まれるはず: {message}"
    );
    assert!(
        !output_path.exists(),
        "展開を始める前にエラーになるはず(出力が作られていない)"
    );
}

/// CRSを指定した場合は「分かっている」扱いになり、COPC(LAS 1.4ヘッダー)に
/// WKTとして書き込まれる(呼び出し側が引数で渡す口の確認。PCD自体はCRSを
/// 持たない)。COPCも通常のLAS/LAZとしての構造を持つため、`las::Reader`で
/// そのままヘッダーを読める。
#[test]
fn crs_wkt_is_written_when_provided_and_unknown_when_not() {
    let dir = tempfile::tempdir().expect("tempdir");
    let input_path = dir.path().join("in.pcd");

    write_binary_pcd(&input_path, false);

    let output_with_crs = dir.path().join("with_crs.copc.laz");
    let wkt = "PROJCS[\"JGD2011 / Japan Plane Rectangular CS IX\"]".to_string();
    let summary = convert_path_to_copc(
        &input_path,
        &output_with_crs,
        dir.path(),
        &CopcWriterParams::default(),
        &NeverCancel,
        Some(wkt.clone()),
        |_| {},
    )
    .expect("convert_path_to_copc");
    assert!(summary.crs_known);
    let reader = las::Reader::from_path(&output_with_crs).expect("open copc as las");
    let wkt_bytes = reader.header().get_wkt_crs_bytes().expect("WKTのCRSが無い");
    assert!(String::from_utf8_lossy(wkt_bytes).contains("JGD2011"));

    let output_without_crs = dir.path().join("without_crs.copc.laz");
    let summary = convert_path_to_copc(
        &input_path,
        &output_without_crs,
        dir.path(),
        &CopcWriterParams::default(),
        &NeverCancel,
        None,
        |_| {},
    )
    .expect("convert_path_to_copc");
    assert!(!summary.crs_known);
    // CRSが無くても`pcv-core`で開けること(M4-9受け入れ条件)。
    let copc = pcv_core::CopcFile::open(&output_without_crs).expect("open copc with pcv-core");
    assert_eq!(copc.info().point_count, sample_points().len() as u64);
}
