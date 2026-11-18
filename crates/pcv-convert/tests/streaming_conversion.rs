use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use copc_writer::CopcWriterParams;
use pcv_convert::streaming::{convert_path, AtomicCancel, ReadProgress};

fn write_synthetic_las_with_geotiff_crs(path: &std::path::Path, point_count: u32, epsg: u16) {
    let mut builder = las::Builder::from((1, 4));
    builder.point_format = las::point::Format::new(6).expect("format 6");

    let mut geo_key_data = Vec::new();
    geo_key_data.extend_from_slice(&1u16.to_le_bytes());
    geo_key_data.extend_from_slice(&1u16.to_le_bytes());
    geo_key_data.extend_from_slice(&1u16.to_le_bytes());
    geo_key_data.extend_from_slice(&1u16.to_le_bytes());
    geo_key_data.extend_from_slice(&3072u16.to_le_bytes());
    geo_key_data.extend_from_slice(&0u16.to_le_bytes());
    geo_key_data.extend_from_slice(&1u16.to_le_bytes());
    geo_key_data.extend_from_slice(&epsg.to_le_bytes());
    builder.vlrs.push(las::Vlr {
        user_id: "LASF_Projection".to_string(),
        record_id: 34735,
        description: String::new(),
        data: geo_key_data,
    });

    let header = builder.into_header().expect("valid header");
    let mut writer = las::Writer::from_path(path, header).expect("LAS writerの作成に失敗");
    for i in 0..point_count {
        let point = las::Point {
            x: f64::from(i) * 0.5,
            y: 100.0,
            z: 10.0 + f64::from(i) * 0.01,
            gps_time: Some(0.0),
            ..Default::default()
        };
        writer.write_point(point).expect("点の書き込みに失敗");
    }
    writer.close().expect("LAS writerのクローズに失敗");
}

fn not_cancelled() -> AtomicCancel {
    AtomicCancel(Arc::new(AtomicBool::new(false)))
}

fn no_progress_reporting(_progress: ReadProgress) {}

#[test]
fn converts_small_synthetic_las_and_pcv_core_can_open_it() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("synthetic.las");
    write_synthetic_las_with_geotiff_crs(&source, 5_000, 32654);

    let output = dir.path().join("synthetic.copc.laz");
    let spill_dir = dir.path().join("spill");
    std::fs::create_dir_all(&spill_dir).unwrap();

    convert_path(
        &source,
        &output,
        &spill_dir,
        &CopcWriterParams::new(1_000),
        &not_cancelled(),
        no_progress_reporting,
    )
    .expect("変換に失敗した");

    let mut file = pcv_core::CopcFile::open(&output).expect("pcv-coreで開けなかった");
    assert_eq!(file.info().point_count, 5_000);

    let nodes: Vec<_> = file.hierarchy().nodes().cloned().collect();
    assert!(!nodes.is_empty(), "hierarchyにノードが無い");
    let mut total_read = 0u32;
    for node in nodes {
        let result = file.read_node(node.key).expect("ノード読み出しに失敗した");
        total_read += result.point_count;
    }
    assert_eq!(
        total_read, 5_000,
        "hierarchyの申告点数と実際に読めた点数が一致するはず"
    );
}

#[test]
fn reports_read_progress_reaching_total_points() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("synthetic.las");
    write_synthetic_las_with_geotiff_crs(&source, 10_000, 32654);
    let output = dir.path().join("synthetic.copc.laz");
    let spill_dir = dir.path().join("spill");
    std::fs::create_dir_all(&spill_dir).unwrap();

    let mut reports: Vec<ReadProgress> = Vec::new();
    convert_path(
        &source,
        &output,
        &spill_dir,
        &CopcWriterParams::new(1_000),
        &not_cancelled(),
        |progress| reports.push(progress),
    )
    .expect("変換に失敗した");

    assert!(
        !reports.is_empty(),
        "進捗コールバックが一度も呼ばれていない"
    );
    assert!(
        reports.iter().all(|r| r.total_points == 10_000),
        "total_pointsは常にヘッダーの申告点数のはず: {reports:?}"
    );
    for pair in reports.windows(2) {
        assert!(
            pair[1].points_read > pair[0].points_read,
            "points_readは単調増加のはず: {reports:?}"
        );
    }
    let last = reports.last().unwrap();
    assert_eq!(
        last.points_read, 10_000,
        "最後の通知は全点読み終えた時点のはず"
    );
}

#[test]
fn geotiff_only_crs_is_carried_through_via_override() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("geotiff_only.las");
    write_synthetic_las_with_geotiff_crs(&source, 200, 6677);

    let output = dir.path().join("geotiff_only.copc.laz");
    let spill_dir = dir.path().join("spill");
    std::fs::create_dir_all(&spill_dir).unwrap();

    convert_path(
        &source,
        &output,
        &spill_dir,
        &CopcWriterParams::new(1_000),
        &not_cancelled(),
        no_progress_reporting,
    )
    .expect("GeoTIFFのみの入力の変換に失敗した");

    let reader = las::Reader::from_path(&output).expect("出力を開けなかった");
    let wkt = reader.header().get_wkt_crs_bytes().expect("WKTのCRSが無い");
    let wkt = String::from_utf8_lossy(wkt);
    assert!(wkt.contains("6677"), "WKTにEPSG:6677が含まれるはず: {wkt}");
}

#[test]
fn cancelling_before_start_leaves_no_leftover_files() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("synthetic.las");
    write_synthetic_las_with_geotiff_crs(&source, 100, 32654);
    let output = dir.path().join("synthetic.copc.laz");
    let spill_dir = dir.path().join("spill");
    std::fs::create_dir_all(&spill_dir).unwrap();

    let cancel = AtomicCancel(Arc::new(AtomicBool::new(true)));

    let err = convert_path(
        &source,
        &output,
        &spill_dir,
        &CopcWriterParams::new(1_000),
        &cancel,
        no_progress_reporting,
    )
    .expect_err("キャンセル済みなのに成功した");
    assert!(
        matches!(err, copc_core::Error::Cancelled),
        "Cancelledであるはず: {err:?}"
    );

    assert!(!output.exists(), "キャンセルしたのに出力が残っている");
    let leftovers: Vec<_> = std::fs::read_dir(&spill_dir).unwrap().collect();
    assert!(
        leftovers.is_empty(),
        "spill_dirに一時ファイルが残っている: {leftovers:?}"
    );
}

#[test]
fn cancelling_mid_conversion_leaves_no_leftover_files() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("synthetic.las");
    write_synthetic_las_with_geotiff_crs(&source, 200_000, 32654);
    let output = dir.path().join("synthetic.copc.laz");
    let spill_dir = dir.path().join("spill");
    std::fs::create_dir_all(&spill_dir).unwrap();

    let cancel_flag = Arc::new(AtomicBool::new(false));
    let cancel = AtomicCancel(cancel_flag.clone());
    let cancel_flag_for_progress = cancel_flag.clone();

    let result = convert_path(
        &source,
        &output,
        &spill_dir,
        &CopcWriterParams::new(1_000),
        &cancel,
        move |progress| {
            if progress.points_read >= 4_096 {
                cancel_flag_for_progress.store(true, Ordering::Relaxed);
            }
        },
    );

    match result {
        Ok(()) => panic!("キャンセルされずに完了してしまった(進捗コールバックが呼ばれなかった?)"),
        Err(copc_core::Error::Cancelled) => assert!(!output.exists()),
        Err(other) => panic!("予期しないエラー: {other:?}"),
    }
    let leftovers: Vec<_> = std::fs::read_dir(&spill_dir).unwrap().collect();
    assert!(
        leftovers.is_empty(),
        "spill_dirに一時ファイルが残っている: {leftovers:?}"
    );
}

fn write_synthetic_las_scattered_in_3d(path: &std::path::Path, point_count: u32) {
    let mut builder = las::Builder::from((1, 2));
    builder.point_format = las::point::Format::new(2).expect("format 2(RGBあり)");
    builder.date = chrono::NaiveDate::from_ymd_opt(2026, 1, 1);

    let header = builder.into_header().expect("valid header");
    let mut writer = las::Writer::from_path(path, header).expect("LAS writerの作成に失敗");
    for i in 0..point_count {
        let x = f64::from((i * 37) % 500) * 0.1;
        let y = f64::from((i * 53) % 500) * 0.1;
        let z = f64::from((i * 13) % 200) * 0.1;
        let point = las::Point {
            x,
            y,
            z,
            intensity: (i % 1000) as u16,
            color: Some(las::Color {
                red: (i % 256) as u16,
                green: ((i * 3) % 256) as u16,
                blue: ((i * 7) % 256) as u16,
            }),
            ..Default::default()
        };
        writer.write_point(point).expect("点の書き込みに失敗");
    }
    writer.close().expect("LAS writerのクローズに失敗");
}

fn fnv1a_64(bytes: &[u8]) -> u64 {
    const OFFSET_BASIS: u64 = 0xcbf29ce484222325;
    const PRIME: u64 = 0x100000001b3;
    let mut hash = OFFSET_BASIS;
    for &b in bytes {
        hash ^= u64::from(b);
        hash = hash.wrapping_mul(PRIME);
    }
    hash
}

#[test]
fn native_output_hash_matches_recorded_value() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("synthetic_3d.las");
    write_synthetic_las_scattered_in_3d(&source, 1_000);

    let output = dir.path().join("synthetic_3d.copc.laz");
    let spill_dir = dir.path().join("spill");
    std::fs::create_dir_all(&spill_dir).unwrap();

    convert_path(
        &source,
        &output,
        &spill_dir,
        &CopcWriterParams::new(50).with_parallel_node_compression(false),
        &not_cancelled(),
        no_progress_reporting,
    )
    .expect("変換に失敗した");

    let bytes = std::fs::read(&output).expect("出力を読めなかった");
    let hash = fnv1a_64(&bytes);

    const EXPECTED_HASH: u64 = 0xFF62_5CC3_B65A_C122;
    assert_eq!(
        hash,
        EXPECTED_HASH,
        "出力のFNV-1aハッシュが記録値と食い違う(バイト長={}) \
         (NativeScratchFsかcopc-writer本体の出力が変わった可能性がある)",
        bytes.len()
    );
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct DecodedPoint {
    x_bits: u64,
    y_bits: u64,
    z_bits: u64,
    color: [u8; 4],
    intensity: u16,
    classification: u8,
}

fn decode_node_points(buf: &pcv_core::NodeBuffer) -> Vec<DecodedPoint> {
    let bytes = &buf.bytes;
    let origin_x = f32::from_le_bytes(bytes[16..20].try_into().unwrap());
    let origin_y = f32::from_le_bytes(bytes[20..24].try_into().unwrap());
    let origin_z = f32::from_le_bytes(bytes[24..28].try_into().unwrap());

    let mut points = Vec::with_capacity(buf.point_count as usize);
    for i in 0..buf.point_count as usize {
        let base = pcv_core::HEADER_BYTES + i * pcv_core::POINT_STRIDE;
        let rel_x = f32::from_le_bytes(bytes[base..base + 4].try_into().unwrap());
        let rel_y = f32::from_le_bytes(bytes[base + 4..base + 8].try_into().unwrap());
        let rel_z = f32::from_le_bytes(bytes[base + 8..base + 12].try_into().unwrap());
        let color = [
            bytes[base + 12],
            bytes[base + 13],
            bytes[base + 14],
            bytes[base + 15],
        ];
        let intensity = u16::from_le_bytes(bytes[base + 16..base + 18].try_into().unwrap());
        let classification = bytes[base + 18];

        let x = f64::from(origin_x) + f64::from(rel_x);
        let y = f64::from(origin_y) + f64::from(rel_y);
        let z = f64::from(origin_z) + f64::from(rel_z);
        points.push(DecodedPoint {
            x_bits: x.to_bits(),
            y_bits: y.to_bits(),
            z_bits: z.to_bits(),
            color,
            intensity,
            classification,
        });
    }
    points
}

fn read_all_points_by_key(
    path: &std::path::Path,
) -> std::collections::BTreeMap<pcv_core::NodeKey, Vec<DecodedPoint>> {
    let mut file = pcv_core::CopcFile::open(path).expect("pcv-coreで開けなかった");
    let keys: Vec<pcv_core::NodeKey> = file.hierarchy().nodes().map(|node| node.key).collect();
    let mut by_key = std::collections::BTreeMap::new();
    for key in keys {
        let buf = file.read_node(key).expect("ノード読み出しに失敗した");
        by_key.insert(key, decode_node_points(&buf));
    }
    by_key
}

#[test]
fn parallel_compress_point_set_matches_sequential() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("synthetic_3d.las");
    write_synthetic_las_scattered_in_3d(&source, 50_000);

    let sequential_output = dir.path().join("sequential.copc.laz");
    let parallel_output = dir.path().join("parallel.copc.laz");
    let spill_dir = dir.path().join("spill");
    std::fs::create_dir_all(&spill_dir).unwrap();

    convert_path(
        &source,
        &sequential_output,
        &spill_dir,
        &CopcWriterParams::new(50)
            .with_memory_budget_bytes(256 * 1024)
            .with_parallel_node_compression(false),
        &not_cancelled(),
        no_progress_reporting,
    )
    .expect("逐次経路の変換に失敗した");

    convert_path(
        &source,
        &parallel_output,
        &spill_dir,
        &CopcWriterParams::new(50)
            .with_memory_budget_bytes(256 * 1024)
            .with_parallel_node_compression(true),
        &not_cancelled(),
        no_progress_reporting,
    )
    .expect("並列経路の変換に失敗した");

    let sequential_by_key = read_all_points_by_key(&sequential_output);
    let parallel_by_key = read_all_points_by_key(&parallel_output);

    let sequential_counts: std::collections::BTreeMap<pcv_core::NodeKey, usize> = sequential_by_key
        .iter()
        .map(|(key, points)| (*key, points.len()))
        .collect();
    let parallel_counts: std::collections::BTreeMap<pcv_core::NodeKey, usize> = parallel_by_key
        .iter()
        .map(|(key, points)| (*key, points.len()))
        .collect();
    assert_eq!(
        sequential_counts, parallel_counts,
        "ノード構成(キーごとの点数)が逐次・並列で食い違う"
    );
    assert!(
        sequential_counts.len() > 1,
        "テスト不備: 1ノードしかできていない(複数ノードに分かれる規模にしたはず)"
    );

    let mut sequential_all: Vec<DecodedPoint> = sequential_by_key.into_values().flatten().collect();
    let mut parallel_all: Vec<DecodedPoint> = parallel_by_key.into_values().flatten().collect();
    assert_eq!(
        sequential_all.len(),
        parallel_all.len(),
        "総点数が逐次・並列で食い違う"
    );
    sequential_all.sort();
    parallel_all.sort();
    assert_eq!(
        sequential_all, parallel_all,
        "点の多重集合(座標・強度・分類・色)が逐次・並列で食い違う"
    );
}
