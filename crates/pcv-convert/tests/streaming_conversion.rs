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

/// M4-6b: `vendor/copc-writer`をScratchFsトレイト越しに改修したことで
/// (`vendor/copc-writer/PATCH.md`参照)、ネイティブ(`NativeScratchFs`)の
/// 出力バイト列が改修前と変わっていないことを、自動テストとして固定する。
///
/// M4-6aのスパイクでは200,000点の合成LASで改修前後のSHA-256ハッシュが
/// 一致することを手動で確認した(タスクシートM4-6a「4. 改修前後で変換結果が
/// 同じであることの確認」)。この関数はその確認を自動テスト化したもので、
/// CIで毎回実行できるようにするため、点数を減らし(1,000点)、`sha2`等の
/// 追加クレートに依存しない自前のFNV-1a(64bit)でハッシュを取る
/// (バイト完全一致さえ検出できればよく、暗号学的な強度は不要なため)。
///
/// x/y/z全軸に散らし、`max_points_per_node`を小さくして複数ノード・複数階層に
/// 分割させている(1ノードしかできないと、ノード分割ロジック
/// (`lod.rs`のpartition_index_run。`create_temp("partition")`を再帰的に
/// 呼ぶ経路)を通らず、改修の主眼であるScratchFs経由の一時ファイル生成が
/// ほとんど検証できないため)。
///
/// **ハッシュ値が変わったら**: `NativeScratchFs`か、それが使う
/// `copc-writer`本体のアルゴリズムの出力が変わったことを意味する。意図した
/// 変更(例えば`copc-writer`のバージョンを上げた)であれば、このテストを
/// 実際に実行して新しいハッシュ値に更新すればよい。意図していなければ退行。
fn write_synthetic_las_scattered_in_3d(path: &std::path::Path, point_count: u32) {
    let mut builder = las::Builder::from((1, 2));
    builder.point_format = las::point::Format::new(2).expect("format 2(RGBあり)");
    // 作成日時を固定する: 未設定(None)のままだと、`copc-writer`の
    // `CopcWriteMetadata::to_output()`が実行時の今日の日付で埋める
    // (`vendor/copc-writer/src/metadata.rs`の`current_utc_date()`)ため、
    // このテストの期待ハッシュが実行する日によって変わってしまう
    // (実際に2026-09-30に記録した値が2026-10-01の実行で食い違った)。
    builder.date = chrono::NaiveDate::from_ymd_opt(2026, 1, 1);

    let header = builder.into_header().expect("valid header");
    let mut writer = las::Writer::from_path(path, header).expect("LAS writerの作成に失敗");
    for i in 0..point_count {
        // 整数演算だけで決定的にx/y/z全軸へ散らす(浮動小数点の丸め差が
        // プラットフォーム間で出ないよう、小さい整数のf64への変換のみを使う。
        // これはIEEE754で常に厳密変換なので、どの環境で実行しても同じ入力になる)。
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

/// FNV-1a(64bit)。暗号学的な強度は要らない(バイト列が完全一致するかどうかを
/// 検出できれば十分な回帰テスト用途)ので、新しい依存クレートを増やさずに
/// 自前で書いた(出典: FNV-1aの定数はIANAが公開する既知の値)。
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

/// M4-10(`TaskSheets/M4-import-and-conversion.md`)追記: `pcv-convert`の既定が
/// `parallel-compress`を有効にしたため(`Cargo.toml`参照)、このテストは
/// `CopcWriterParams::with_parallel_node_compression(false)`で**逐次の圧縮経路を
/// 明示的に強制して**実行する。これにより、`cargo test --workspace --release`を
/// 1回実行するだけで、逐次経路のバイト一致(このテスト)と並列経路の点集合一致
/// (`parallel_compress_point_set_matches_sequential`)の両方を検証できる
/// (`vendor/copc-writer`を異なるフィーチャで複数回ビルドし直す必要が無い)。
/// 期待ハッシュ自体は、`parallel_node_compression`を導入する前(M4-8時点)と
/// 同じ値のまま変わっていない(逐次のアルゴリズムは変更していないため)。
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

    // 2026-10-01、合成LASの作成日時を固定した後にこのworktreeで
    // `cargo test -p pcv-convert --test streaming_conversion
    // native_output_hash_matches_recorded_value`を実行して得た値。
    // (2026-09-30に記録した前の値0xE17F_4891_ACC2_2B10は、合成LASの作成日時を
    // 固定していなかったために翌日の実行で食い違った。`chrono::NaiveDate`で
    // 固定した今は、実行する日に関わらずこの値になるはず)。
    const EXPECTED_HASH: u64 = 0x1835_0A7E_294F_68C3;
    assert_eq!(
        hash,
        EXPECTED_HASH,
        "出力のFNV-1aハッシュが記録値と食い違う(バイト長={}) \
         (NativeScratchFsかcopc-writer本体の出力が変わった可能性がある)",
        bytes.len()
    );
}

/// `pcv-core`の`NodeBuffer`(ヘッダ32B+点20B、`pcv_core::node_format`の形式)を
/// デコードした1点。座標はノード原点(ヘッダのf32。`encode_node`のドキュメント
/// 参照)からの相対座標を世界座標へ復元し、丸め誤差ではなく値そのものを
/// 比較できるようビット列として持つ(f64はEq/Ordを実装しないため)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct DecodedPoint {
    x_bits: u64,
    y_bits: u64,
    z_bits: u64,
    color: [u8; 4],
    intensity: u16,
    classification: u8,
}

/// `pcv_core::node_format`のバイナリ形式(`crates/pcv-core/src/node_format.rs`の
/// モジュールドキュメント参照)をそのまま読み、1ノード分の点を全てデコードする。
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

/// 変換済みのCOPCファイルを`pcv-core`で開き、hierarchyの全ノードをキーごとに
/// デコードして返す。
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

/// M4-10(`TaskSheets/M4-import-and-conversion.md`): ノードごとのLAZ圧縮の
/// 並列実装(`parallel-compress`)を有効にすると、出力はバイト単位では
/// `native_output_hash_matches_recorded_value`と一致しなくなる(チャンクの
/// 並び・圧縮の区切り・hierarchyのオフセットが変わるため。
/// `vendor/copc-writer/PATCH.md`のM4-10追記参照)。
///
/// 所有者が「バイト単位の一致」という受け入れ条件を「点の集合が一致すること」へ
/// 緩めることを承認した(2026-10-03)。このテストはその条件を確かめる:
/// 同じ合成入力を逐次(`parallel_node_compression(false)`)・並列
/// (`parallel_node_compression(true)`。`pcv-convert`の既定と同じ)それぞれで
/// 変換し、`pcv-core`で両方を開いて、(1)ノード構成(キーごとの点数)が一致する
/// こと、(2)全ノードを合わせた点の多重集合(座標・強度・分類・色)が一致する
/// ことを確認する。
#[test]
fn parallel_compress_point_set_matches_sequential() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("synthetic_3d.las");
    // 並列圧縮のバッチ(既定で`2 * rayon::current_num_threads()`ノードずつ)が
    // 複数回まわる規模にするため、ハッシュ一致テスト(1,000点)より多くする。
    write_synthetic_las_scattered_in_3d(&source, 50_000);

    let sequential_output = dir.path().join("sequential.copc.laz");
    let parallel_output = dir.path().join("parallel.copc.laz");
    let spill_dir = dir.path().join("spill");
    std::fs::create_dir_all(&spill_dir).unwrap();

    convert_path(
        &source,
        &sequential_output,
        &spill_dir,
        &CopcWriterParams::new(50).with_parallel_node_compression(false),
        &not_cancelled(),
        no_progress_reporting,
    )
    .expect("逐次経路の変換に失敗した");

    // spill_dirの一時ファイルは変換のたびに後片付けされるので使い回せる。
    convert_path(
        &source,
        &parallel_output,
        &spill_dir,
        &CopcWriterParams::new(50).with_parallel_node_compression(true),
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
