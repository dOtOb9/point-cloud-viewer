//! M4-3の受け入れ条件: 小さな合成LASを実際に本番の変換経路
//! (`pcv_convert::streaming::convert_path`)へ通し、`pcv-core`で開けることを
//! 確認する統合テスト。
//!
//! `examples/convert_streaming.rs`(M4-1bのスパイク、`copc-writer`の生の関数を
//! 直接呼ぶだけ)とは違い、こちらは本番経路(CRSの解決・キャンセル対応・
//! 読み込み進捗を含む`pcv_convert::streaming`)を通す。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use copc_writer::CopcWriterParams;
use pcv_convert::streaming::{convert_path, AtomicCancel, ReadProgress};

/// GeoTIFFキー(ProjectedCRSGeoKey)だけを持つ、点数`point_count`個のLAS 1.4
/// (point format 6)を書く。WKTのVLRは意図的に付けない
/// (`crs_override`モジュールが手当てすべきケースを再現するため)。
fn write_synthetic_las_with_geotiff_crs(path: &std::path::Path, point_count: u32, epsg: u16) {
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
            // point format 6はGPS時刻が必須(has_gps_time)。
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
    write_synthetic_las_with_geotiff_crs(&source, 5_000, 32654); // UTM 54N

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
    // 受け入れ条件: 読み込み段階の進捗が出る。実際に呼ばれる回数・最終値を確認する。
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
    // 単調増加であること(後退しない)。
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
    // `crs_override`モジュールの存在意義そのものの確認:
    // GeoTIFFキーだけの入力は、CRSの手当てをしないと`copc-writer`が
    // 変換自体を拒否する(`validate.rs`の`validate_las_conversion_supported`)。
    // `pcv_convert::streaming::convert_path`はこれを自動で手当てするので、
    // 変換が成功し、かつ出力にWKTのCRSが乗ることを確認する。
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("geotiff_only.las");
    write_synthetic_las_with_geotiff_crs(&source, 200, 6677); // JGD2011 IX系

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

    // 出力を`las`クレートで開き直し、WKTのCRSが書かれていることを確認する
    // (`pcv-core`の読み込み側はCOPC/LASzip関連VLR以外を読み捨てるため、
    // CRSを見るには`las`で開き直す必要がある。`crs::mod.rs`のコメント参照)。
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

    // 開始前からキャンセル済みにしておく。
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
    // 途中(点の処理中)でキャンセルしても、`copc-writer`のRAII
    // (`tempfile::NamedTempFile`)で一時ファイルが片付くことを確認する。
    // 実際に「途中で」止めるため、別スレッドでキャンセルフラグを立てる。
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("synthetic.las");
    // キャンセルが確実に「変換の途中」で効くよう、進捗の報告間隔(4096点)を
    // 何度も超える点数にする。
    write_synthetic_las_with_geotiff_crs(&source, 200_000, 32654);
    let output = dir.path().join("synthetic.copc.laz");
    let spill_dir = dir.path().join("spill");
    std::fs::create_dir_all(&spill_dir).unwrap();

    let cancel_flag = Arc::new(AtomicBool::new(false));
    let cancel = AtomicCancel(cancel_flag.clone());
    let cancel_flag_for_progress = cancel_flag.clone();

    // 進捗コールバックの中でキャンセルフラグを立てる。別スレッドを使うより
    // 確実に「読み込みの途中」で止められる(コールバックは読み込みループの
    // 中で呼ばれるため)。
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
