//! M4-7の受け入れ条件: LAZの並列展開(`las`クレートの`laz-parallel`フィーチャ、
//! `crates/pcv-convert/src/streaming.rs`のモジュールドキュメント参照)が、
//! 逐次展開と「同じ点の集合」(点数・全点の座標の集合)を返すことを確認する。
//!
//! `ParLasZipDecompressor`はチャンクの展開結果を出力バッファの自分の位置へ
//! そのまま書くため、コードを読んだ限り点の順序は変わらないはずだが
//! (`TaskSheets/M4-import-and-conversion.md`のM4-7参照)、受け入れ条件が
//! 求めるのは「順序が変わってもよい」前提での集合の一致なので、このテストも
//! 順序を見ない(`BTreeSet`で比較する)形にしてある。

use std::collections::BTreeSet;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use copc_writer::CopcWriterParams;
use las::{LazParallelism, Reader, ReaderOptions};
use pcv_convert::streaming::{convert_path, AtomicCancel};

/// チャンクテーブルを持つ(複数チャンクにまたがる)合成LAZを書く。
/// LAZの既定チャンクサイズはおよそ5万点なので、`point_count`はそれより
/// 十分大きい値を渡すこと(このテストでは300,000点=約6チャンク)。
/// CRSはGeoTIFFキー(`write_synthetic_las_with_geotiff_crs`と同じ形、
/// `streaming_conversion.rs`参照)を付け、`convert_path`(本番経路)が
/// CRS未対応で失敗しないようにする。
fn write_synthetic_multi_chunk_laz(path: &std::path::Path, point_count: u32) {
    let mut builder = las::Builder::from((1, 4));
    builder.point_format = las::point::Format::new(6).expect("format 6");

    let mut geo_key_data = Vec::new();
    geo_key_data.extend_from_slice(&1u16.to_le_bytes()); // KeyDirectoryVersion
    geo_key_data.extend_from_slice(&1u16.to_le_bytes()); // KeyRevision
    geo_key_data.extend_from_slice(&1u16.to_le_bytes()); // MinorRevision
    geo_key_data.extend_from_slice(&1u16.to_le_bytes()); // NumberOfKeys
    geo_key_data.extend_from_slice(&3072u16.to_le_bytes()); // ProjectedCRSGeoKey
    geo_key_data.extend_from_slice(&0u16.to_le_bytes()); // location=0(値そのもの)
    geo_key_data.extend_from_slice(&1u16.to_le_bytes()); // count=1
    geo_key_data.extend_from_slice(&32654u16.to_le_bytes()); // UTM 54N
    builder.vlrs.push(las::Vlr {
        user_id: "LASF_Projection".to_string(),
        record_id: 34735,
        description: String::new(),
        data: geo_key_data,
    });

    let header = builder.into_header().expect("valid header");
    let mut writer = las::Writer::from_path(path, header).expect("LAS writerの作成に失敗");
    for i in 0..point_count {
        // 整数演算で決まる値にして、浮動小数点の誤差で集合比較が揺れないようにする。
        let point = las::Point {
            x: f64::from(i),
            y: f64::from(i) * 2.0,
            z: f64::from(i) * 3.0,
            gps_time: Some(0.0), // point format 6はGPS時刻が必須
            ..Default::default()
        };
        writer.write_point(point).expect("点の書き込みに失敗");
    }
    writer.close().expect("LAS writerのクローズに失敗");
}

/// `path`を指定の並列設定で読み、(点数, 座標の集合)を返す。
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
            // 座標はLASのスケール/オフセットを経て浮動小数点になるが、
            // 合成データは整数座標×固定スケールなので、ビット表現を
            // そのままキーにしても揺れない(直列・並列で同じ変換式を通る)。
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
    // `convert_path`(本番経路)は`las::Reader::new`を使い、`laz-parallel`
    // フィーチャが有効なので既定で並列展開になる(モジュールドキュメント参照)。
    // ここでは複数チャンクのLAZを本番経路に通し、出力が`pcv-core`で開けて
    // 入力と同じ点数を持つことを確認する。
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
