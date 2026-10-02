//! M4-7: LAZ展開の並列化(`las`クレートの`laz-parallel`フィーチャ)が実際に
//! 効くか、バッチサイズ(`fill_points`に一度に渡す点数)にどう依存するかを測る。
//!
//! ```text
//! cargo run -p pcv-convert --release --example parallel_read_bench -- <file.laz> [batch_size...]
//! ```
//! `batch_size`を複数個渡すと、それぞれについて逐次(直列)と並列を測って比較する。
//! 省略時は`64Ki, 256Ki, 1Mi, 4Mi`点で測る。
//!
//! # なぜバッチサイズを振るか
//!
//! `las::Reader::fill_points(n, ..)`は`laz::ParLasZipDecompressor::decompress_many`を
//! 呼ぶ。この関数は「要求された`n`点を埋めるのに必要なチャンクをまとめて読み、
//! チャンクを跨いでrayonで並列に展開する」実装なので、**1回の`fill_points`が
//! またぐチャンク数が少ないと並列度が出ない**。COPCの1チャンクはおよそ5万点
//! (`TaskSheets/M4-import-and-conversion.md`のM4-7参照)なので、デスクトップ版の
//! 既存`READ_BATCH_SIZE`(64Ki=65,536点)では1回あたり高々1〜2チャンクしか
//! またがず、ほぼ並列化されない。バッチを大きくするほどチャンックをまたぐ数が
//! 増え、論理コア数まで並列度が伸びるはずだが、バッチを大きくしすぎると
//! 「キャンセルが1回の`fill_points`呼び出しの間は割り込めない」という制約
//! (`streaming.rs`のモジュールドキュメント参照)により、キャンセルの反応が
//! 遅くなる代償を払う。両方を実測して釣り合う値を選ぶ。

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
        // 点は捨てる(ここで測りたいのは読み込み+展開だけ)。
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
