use std::path::Path;
use std::time::Instant;

use las::{LazParallelism, Reader, ReaderOptions};

fn measure(path: &Path, batch_size: u64, parallel: bool) -> (f64, u64) {
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

    let mut points_read: u64 = 0;
    let start = Instant::now();
    loop {
        let count = reader
            .fill_points(batch_size, &mut point_data)
            .expect("fill_pointsに失敗した");
        if count == 0 {
            break;
        }
        for result in point_data.points() {
            result.expect("点のデコードに失敗した");
            points_read += 1;
        }
    }
    (start.elapsed().as_secs_f64(), points_read)
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(path) = args.first() else {
        eprintln!("usage: parallel_read_bench <file.laz> [batch_size...]");
        std::process::exit(2);
    };
    let path = Path::new(path);
    let name = path.file_name().unwrap_or_default().to_string_lossy();

    let batch_sizes: Vec<u64> = if args.len() > 1 {
        args[1..]
            .iter()
            .map(|s| s.parse().expect("batch_sizeは整数で指定すること"))
            .collect()
    } else {
        vec![64 * 1024, 256 * 1024, 1024 * 1024, 4 * 1024 * 1024]
    };

    println!(
        "{name}  論理コア数: {}",
        std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(0)
    );
    println!();
    println!("  バッチサイズ    直列        並列        倍率");
    println!("  ------------------------------------------------");

    for batch_size in batch_sizes {
        let (serial_secs, serial_points) = measure(path, batch_size, false);
        let (parallel_secs, parallel_points) = measure(path, batch_size, true);
        assert_eq!(
            serial_points, parallel_points,
            "直列と並列で読んだ点数が違う(batch_size={batch_size})"
        );
        println!(
            "  {batch_size:>10}   {serial_secs:>7.3}秒   {parallel_secs:>7.3}秒   {:>5.2}倍",
            serial_secs / parallel_secs
        );
    }
}
