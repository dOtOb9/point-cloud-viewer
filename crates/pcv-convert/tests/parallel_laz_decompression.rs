use std::collections::BTreeSet;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use copc_writer::CopcWriterParams;
use las::{LazParallelism, Reader, ReaderOptions};
use pcv_convert::streaming::{convert_path, AtomicCancel};

fn write_synthetic_multi_chunk_laz(path: &std::path::Path, point_count: u32) {
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
    geo_key_data.extend_from_slice(&32654u16.to_le_bytes());
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
            x: f64::from(i),
            y: f64::from(i) * 2.0,
            z: f64::from(i) * 3.0,
            gps_time: Some(0.0),
            ..Default::default()
        };
        writer.write_point(point).expect("点の書き込みに失敗");
    }
    writer.close().expect("LAS writerのクローズに失敗");
}

fn read_all_xyz(path: &std::path::Path, parallel: bool) -> (u64, BTreeSet<(u64, u64, u64)>) {
    let file = std::fs::File::open(path).expect("入力を開けなかった");
    let options = ReaderOptions::default().with_laz_parallelism(if parallel {
        LazParallelism::Yes
    } else {
        LazParallelism::No
    });
    let mut reader = Reader::with_options(std::io::BufReader::new(file), options)
        .expect("las::Readerを開けなかった");
    let mut point_data = las::PointDataBuilder::new()
        .for_header(reader.header())
        .build();

    let mut count = 0u64;
    let mut xyz = BTreeSet::new();
    loop {
        let n = reader
            .fill_points(65_536, &mut point_data)
            .expect("fill_pointsに失敗した");
        if n == 0 {
            break;
        }
        for result in point_data.points() {
            let point = result.expect("点のデコードに失敗した");
            xyz.insert((point.x.to_bits(), point.y.to_bits(), point.z.to_bits()));
            count += 1;
        }
    }
    (count, xyz)
}

#[test]
fn parallel_and_serial_laz_decompression_yield_the_same_point_set() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("multi_chunk.laz");
    const POINT_COUNT: u32 = 300_000;
    write_synthetic_multi_chunk_laz(&source, POINT_COUNT);

    let (serial_count, serial_xyz) = read_all_xyz(&source, false);
    let (parallel_count, parallel_xyz) = read_all_xyz(&source, true);

    assert_eq!(serial_count, u64::from(POINT_COUNT));
    assert_eq!(serial_count, parallel_count, "直列と並列で読んだ点数が違う");
    assert_eq!(
        serial_xyz, parallel_xyz,
        "直列と並列で読んだ座標の集合が違う"
    );
}

fn not_cancelled() -> AtomicCancel {
    AtomicCancel(Arc::new(AtomicBool::new(false)))
}

#[test]
fn production_conversion_path_with_parallel_decompression_opens_in_pcv_core() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("multi_chunk.laz");
    const POINT_COUNT: u32 = 300_000;
    write_synthetic_multi_chunk_laz(&source, POINT_COUNT);

    let output = dir.path().join("multi_chunk.copc.laz");
    let spill_dir = dir.path().join("spill");
    std::fs::create_dir_all(&spill_dir).unwrap();

    convert_path(
        &source,
        &output,
        &spill_dir,
        &CopcWriterParams::new(20_000),
        &not_cancelled(),
        |_progress| {},
    )
    .expect("変換に失敗した");

    let mut file = pcv_core::CopcFile::open(&output).expect("pcv-coreで開けなかった");
    assert_eq!(file.info().point_count, u64::from(POINT_COUNT));

    let nodes: Vec<_> = file.hierarchy().nodes().cloned().collect();
    assert!(!nodes.is_empty(), "hierarchyにノードが無い");
    let mut total_read = 0u32;
    for node in nodes {
        let result = file.read_node(node.key).expect("ノード読み出しに失敗した");
        total_read += result.point_count;
    }
    assert_eq!(
        u64::from(total_read),
        u64::from(POINT_COUNT),
        "全ノードの点数の合計が入力点数と一致するはず"
    );
}
