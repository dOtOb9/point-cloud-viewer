//! E57/PLY/PCD → COPC(本番の変換経路、M4-9の`convert_path_to_copc`)を呼ぶだけの
//! 計測用入口。`examples/convert_streaming.rs`(LAS/LAZ版)と同じ考え方で、
//! ここでは入出力の口だけを用意し、計測(所要時間・ピークメモリ)はプロセスの
//! 外(PowerShell)から行う。
//!
//! 用途: `examples/copc_to_pcd.rs`で作ったPCD(例: `data/sofi.pcd`)を、
//! 本番の変換経路で実際にCOPCへ戻し、元のCOPCと点数を突き合わせる
//! (`TaskSheets/M4-import-and-conversion.md`のM4-9参照)。
//!
//! ```text
//! cargo run -p pcv-convert --release --example import_bench -- \
//!     <入力.e57/.ply/.pcd> <出力.copc.laz> [spill_dir=OS既定の一時ディレクトリ]
//! ```

use std::path::{Path, PathBuf};
use std::time::Instant;

use copc_core::NeverCancel;
use copc_writer::CopcWriterParams;
use pcv_convert::import::convert_path_to_copc;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (Some(input), Some(output)) = (args.first(), args.get(1)) else {
        eprintln!(
            "usage: import_bench <入力.e57/.ply/.pcd> <出力.copc.laz> \
             [spill_dir=OS既定の一時ディレクトリ]"
        );
        std::process::exit(2);
    };
    let spill_dir: PathBuf = args
        .get(2)
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);

    let input_path = Path::new(input);
    let output_path = Path::new(output);

    println!("入力      : {}", input_path.display());
    println!("出力      : {}", output_path.display());
    println!("spill_dir : {}", spill_dir.display());
    let input_bytes = std::fs::metadata(input_path).map(|m| m.len()).unwrap_or(0);
    println!("入力サイズ: {:.2} MB", input_bytes as f64 / 1e6);

    let t0 = Instant::now();
    let result = convert_path_to_copc(
        input_path,
        output_path,
        &spill_dir,
        &CopcWriterParams::default(),
        &NeverCancel,
        None,
        |progress| {
            // 読み込み段階の進捗だけ分かる(streaming.rsのコメント参照)。
            // 大きい入力で経過が分かるよう、ある程度まとまった間隔で出す。
            if progress.points_read % 10_000_000 == 0 {
                println!(
                    "  読み込み中: {}/{}",
                    progress.points_read, progress.total_points
                );
            }
        },
    );
    let elapsed_s = t0.elapsed().as_secs_f64();

    match result {
        Ok(summary) => {
            let output_bytes = std::fs::metadata(output_path).map(|m| m.len()).unwrap_or(0);
            println!("変換完了  : {elapsed_s:.2} 秒");
            println!("点数      : {}", summary.point_count);
            println!("出力サイズ: {:.2} MB", output_bytes as f64 / 1e6);
        }
        Err(err) => {
            eprintln!("変換に失敗した({elapsed_s:.2} 秒経過): {err}");
            std::process::exit(1);
        }
    }
}
