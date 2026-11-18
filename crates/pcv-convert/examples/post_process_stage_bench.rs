use std::path::Path;
use std::time::Instant;

use copc_core::{LasPointRecord, StreamingLayout};
use copc_writer::{
    write_copc_from_spill_with_fs_and_timings, CopcWriterParams, NativeScratchFs, SpillWriter,
};
use pcv_convert::write_metadata::copc_write_metadata_from_source_header;

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
    let mut spill = SpillWriter::create(&fs, layout, None).expect("SpillWriterを作れなかった");
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

    let _ = std::fs::remove_dir_all(&bench_dir);
}
