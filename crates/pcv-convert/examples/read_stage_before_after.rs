use std::path::Path;
use std::time::Instant;

use copc_core::StreamingLayout;
use copc_writer::{CopcWriterParams, NativeScratchFs, SpillWriter};
use las::{LazParallelism, Reader, ReaderOptions};
use pcv_convert::write_metadata::copc_write_metadata_from_source_header;

const BEFORE_BATCH_SIZE: u64 = 64 * 1024;
const AFTER_BATCH_SIZE: u64 = 1024 * 1024;

fn measure_read_stage(path: &Path, batch_size: u64, parallel: bool, label: &str) -> f64 {
    let bench_dir = std::env::temp_dir().join(format!(
        "pcv-before-after-bench-{}-{label}",
        std::process::id()
    ));
    std::fs::create_dir_all(&bench_dir).expect("ベンチ用一時ディレクトリを作れなかった");
    let fs = NativeScratchFs::new(&bench_dir);

    let options = ReaderOptions::default().with_laz_parallelism(if parallel {
        LazParallelism::Yes
    } else {
        LazParallelism::No
    });
    let file = std::fs::File::open(path).expect("入力を開けなかった");
    let mut reader = Reader::with_options(std::io::BufReader::new(file), options)
        .expect("las::Readerを開けなかった");
    let layout = StreamingLayout::from_las_header(reader.header());
    let metadata = copc_write_metadata_from_source_header(reader.header());
    let mut point_data = las::PointDataBuilder::new()
        .for_header(reader.header())
        .build();

    let mut spill = SpillWriter::create(&fs, layout, None).expect("SpillWriterを作れなかった");

    let start = Instant::now();
    loop {
        let count = reader
            .fill_points(batch_size, &mut point_data)
            .expect("fill_pointsに失敗した");
        if count == 0 {
            break;
        }
        for result in point_data.points() {
            let point = result.expect("点のデコードに失敗した");
            let record = copc_core::LasPointRecord::from_las_point(&point);
            spill.push(&record).expect("spillへの書き込みに失敗した");
        }
    }
    let elapsed = start.elapsed().as_secs_f64();

    let _ = &metadata;

    let _ = spill.finalize().expect("spillの確定に失敗した");
    let _ = CopcWriterParams::new(100_000);
    let _ = std::fs::remove_dir_all(&bench_dir);
    elapsed
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(path) = args.first() else {
        eprintln!("usage: read_stage_before_after <file.laz>");
        std::process::exit(2);
    };
    let path = Path::new(path);
    let name = path.file_name().unwrap_or_default().to_string_lossy();

    println!("{name}");
    println!();

    let before = measure_read_stage(path, BEFORE_BATCH_SIZE, false, "before");
    println!("[前] 直列・バッチ{BEFORE_BATCH_SIZE}点(改修前の設定):  {before:>8.3} 秒");

    let after = measure_read_stage(path, AFTER_BATCH_SIZE, true, "after");
    println!("[後] 並列・バッチ{AFTER_BATCH_SIZE}点(改修後の設定):  {after:>8.3} 秒");

    println!();
    println!("倍率: {:.2}倍", before / after);
}
