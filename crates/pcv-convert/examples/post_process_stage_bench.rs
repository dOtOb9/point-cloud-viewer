//! 変換の「後処理」段階(octree構築・ノードごとのLAZ圧縮・書き出し)の内訳を測る。
//!
//! ```text
//! cargo run -p pcv-convert --release --example post_process_stage_bench -- <file.las|.laz> [--sequential-compress]
//! ```
//!
//! M4-10(`TaskSheets/M4-import-and-conversion.md`)追記: `--sequential-compress`を
//! 付けると、ノードごとのLAZ圧縮を`CopcWriterParams::
//! with_parallel_node_compression(false)`で強制的に逐次にする(`pcv-convert`の
//! 既定は`parallel-compress`フィーチャが有効なため並列)。同じビルドのまま
//! 逐次・並列を切り替えて測れるようにするための追加で、本番の変換経路の挙動は
//! 変えない。
//!
//! # 背景
//!
//! `TaskSheets/M4-import-and-conversion.md`のM4-7で、「読み込み」段階
//! (LAZの展開)を並列化した。その結果、並列化していない「後処理」段階
//! (beer.lazで約64〜73秒)が変換時間の大半を占めるようになった。
//! `TaskSheets/ADR-0007-pcv-protocol-concurrency.md`の教訓(並列度だけを
//! 上げて1回あたりのコストを疑わなかった失敗)に倣い、並列化に進む前に
//! まず後処理の内訳を測る(M4-8)。
//!
//! # 測る4つ
//!
//! 1. **octreeの分割**(LODの索引作り、点のノードへの振り分け):
//!    `vendor/copc-writer`に計測専用で追加した
//!    [`copc_writer::PostProcessStageTimings`]の`lod_index_build`。
//! 2. **ノードごとのLAZ圧縮**(圧縮したバイト列を出力ストリームへ書く部分を
//!    含む): 同構造体の`node_compression`。
//! 3. **書き出し**(ヘッダー・VLR・hierarchyの書き出し。圧縮以外の全て):
//!    同構造体の`header_and_hierarchy_write`。
//! 4. **一時ファイルの読み戻し(`read_at`)の重さ**: 1.〜3.の内側に含まれる
//!    (独立した段階ではない)ため、別枠で直接測る。`SpillReader::xyz_at`
//!    (octree分割が点ごとに呼ぶ)と`SpillReader::record_into`
//!    (ノード圧縮が点ごとに呼ぶ)を、本番と同じ経路(`read_at`経由の
//!    範囲読み)でそれぞれ全点ぶん呼び、かかった時間を直接計測する。
//!    **ただしoctree分割の実際の呼び出し回数は、木の深さの分だけ点1つに
//!    つき複数回になる**(分割のたびに子へ振り分けるため)。この計測は
//!    「全点を1回ずつ」なので下限の目安であり、実際の`lod_index_build`に
//!    占める割合はこれ以上になりうる(正直に明記する)。
//!    計測専用の`ScratchFs`ラッパーで個々の`read_at`呼び出しを`Instant`で
//!    包む方式は、数億回の呼び出しに計測自体のオーバーヘッド(関数呼び出し+
//!    `Instant::now()`2回)が無視できない大きさで乗ってしまう(観測者効果)
//!    ため採用しなかった。代わりに「全点ぶんまとめて1回だけ区間計測する」
//!    方式にした(本番の呼び出し経路そのものを、まとまった区間として測る)。
//!
//! 出力(spill・変換結果)は`std::env::temp_dir()`配下に書き、プログラム終了時に
//! 消す(リポジトリには何もコミットしない)。

use std::path::Path;
use std::time::Instant;

use copc_core::{LasPointRecord, StreamingLayout};
use copc_writer::{
    write_copc_from_spill_with_fs_and_timings, CopcWriterParams, NativeScratchFs, SpillWriter,
};
use pcv_convert::write_metadata::copc_write_metadata_from_source_header;

/// 本番(`crates/pcv-convert/src/streaming.rs`のM4-7後の値)と同じバッチサイズ。
const READ_BATCH_SIZE: u64 = 1024 * 1024;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(path) = args.iter().find(|a| !a.starts_with("--")) else {
        eprintln!("usage: post_process_stage_bench <file.las|.laz> [--sequential-compress]");
        std::process::exit(2);
    };
    let force_sequential_compress = args.iter().any(|a| a == "--sequential-compress");
    let path = Path::new(path);
    let name = path.file_name().unwrap_or_default().to_string_lossy();

    let bench_dir = std::env::temp_dir().join(format!(
        "pcv-post-process-stage-bench-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&bench_dir).expect("ベンチ用一時ディレクトリを作れなかった");
    let fs = NativeScratchFs::new(&bench_dir);

    // --- spillを作る(本番の「読み込み」段階と同じ経路。計測対象には含めない) ---
    let mut reader = las::Reader::new(std::io::BufReader::new(
        std::fs::File::open(path).expect("入力を開けなかった"),
    ))
    .expect("las::Readerを開けなかった");
    let layout = StreamingLayout::from_las_header(reader.header());
    let metadata = copc_write_metadata_from_source_header(reader.header());
    let mut point_data = las::PointDataBuilder::new()
        .for_header(reader.header())
        .build();

    let spill_build_start = Instant::now();
    let mut spill = SpillWriter::create(&fs, layout).expect("SpillWriterを作れなかった");
    loop {
        let count = reader
            .fill_points(READ_BATCH_SIZE, &mut point_data)
            .expect("fill_pointsに失敗した");
        if count == 0 {
            break;
        }
        for result in point_data.points() {
            let point = result.expect("点のデコードに失敗した");
            spill
                .push(&LasPointRecord::from_las_point(&point))
                .expect("spillへの書き込みに失敗した");
        }
    }
    let point_count = spill.count();
    let spill_reader = spill.finalize().expect("spillの確定に失敗した");
    let spill_build_elapsed = spill_build_start.elapsed();

    println!("{name}  点数: {point_count}");
    println!(
        "(spill構築: {:.3} 秒。計測対象外)",
        spill_build_elapsed.as_secs_f64()
    );
    println!();

    // --- 4. 一時ファイルの読み戻し(read_at)の重さを直接測る ---
    // `SpillReader::xyz_at`/`record_into`は本番(`lod.rs`の`partition_index_run`/
    // `writer.rs`の`encode_node_points`)と全く同じ経路(`read_at`経由の範囲読み)
    // を通る。ここでは後処理本体とは別に、全点ぶんまとめて1回だけ時間を測る。
    let xyz_start = Instant::now();
    let mut xyz_sink = 0.0f64;
    for index in 0..spill_reader.len() {
        let (x, y, z) = spill_reader.xyz_at(index).expect("xyz_at");
        xyz_sink += x + y + z;
    }
    let xyz_elapsed = xyz_start.elapsed();
    std::hint::black_box(xyz_sink);

    let mut record = LasPointRecord::default();
    let record_start = Instant::now();
    for index in 0..spill_reader.len() {
        spill_reader
            .record_into(index, &mut record)
            .expect("record_into");
    }
    let record_elapsed = record_start.elapsed();

    println!("[4] 一時ファイルの読み戻し(read_at)を全点ぶん直接測る(参考値):");
    println!(
        "    xyz_at全点(24バイト/点、octree分割が点ごとに呼ぶものの下限の目安):    {:>8.3} 秒  ({:.0} 点/秒)",
        xyz_elapsed.as_secs_f64(),
        point_count as f64 / xyz_elapsed.as_secs_f64()
    );
    println!(
        "    record_into全点(レコード全体、ノード圧縮が点ごとに呼ぶものと同数): {:>8.3} 秒  ({:.0} 点/秒)",
        record_elapsed.as_secs_f64(),
        point_count as f64 / record_elapsed.as_secs_f64()
    );
    println!();

    // --- 1〜3. 後処理の内訳(vendor/copc-writerの計測専用API) ---
    let params =
        CopcWriterParams::new(100_000).with_parallel_node_compression(!force_sequential_compress);
    println!(
        "ノードごとのLAZ圧縮: {}",
        if force_sequential_compress {
            "逐次(--sequential-compress指定)"
        } else {
            "並列(parallel-compress、既定)"
        }
    );
    let output_path = bench_dir.join("bench-output.copc.laz");

    let total_start = Instant::now();
    let timings = write_copc_from_spill_with_fs_and_timings(
        &fs,
        &output_path,
        spill_reader,
        &params,
        &copc_core::NeverCancel,
        &metadata,
    )
    .expect("write_copc_from_spill_with_fs_and_timingsに失敗した");
    let total_elapsed = total_start.elapsed();

    let total_secs = total_elapsed.as_secs_f64();
    println!("[1〜3] 後処理の内訳(合計 {total_secs:.3} 秒):");
    println!(
        "    [1] octreeの分割(LOD索引作り・点のノードへの振り分け): {:>8.3} 秒  ({:>5.1}%)",
        timings.lod_index_build.as_secs_f64(),
        timings.lod_index_build.as_secs_f64() / total_secs * 100.0
    );
    println!(
        "    [2] ノードごとのLAZ圧縮(出力への書き込みを含む):      {:>8.3} 秒  ({:>5.1}%)",
        timings.node_compression.as_secs_f64(),
        timings.node_compression.as_secs_f64() / total_secs * 100.0
    );
    println!(
        "    [3] 書き出し(ヘッダー・VLR・hierarchy。圧縮以外):     {:>8.3} 秒  ({:>5.1}%)",
        timings.header_and_hierarchy_write.as_secs_f64(),
        timings.header_and_hierarchy_write.as_secs_f64() / total_secs * 100.0
    );
    let accounted = timings.lod_index_build.as_secs_f64()
        + timings.node_compression.as_secs_f64()
        + timings.header_and_hierarchy_write.as_secs_f64();
    println!(
        "    (内訳の合計 {accounted:.3} 秒 vs 区間計測 {total_secs:.3} 秒。差は計測の前後に残る軽い処理)"
    );

    // 後始末: ベンチ用の一時ファイル・出力は残さない。
    let _ = std::fs::remove_dir_all(&bench_dir);
}
