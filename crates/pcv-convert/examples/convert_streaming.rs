use std::path::{Path, PathBuf};
use std::time::Instant;

use copc_core::NeverCancel;
use copc_writer::{convert_las_to_copc_streaming, CopcWriterParams};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (Some(input), Some(output)) = (args.first(), args.get(1)) else {
        eprintln!(
            "usage: convert_streaming <入力.las/.laz> <出力.copc.laz> \
             [ノードあたり最大点数=100000] [spill_dir=OS既定の一時ディレクトリ]"
        );
        std::process::exit(2);
    };
    let max_points_per_node: u32 = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(100_000);
    let spill_dir: PathBuf = args
        .get(3)
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);

    let input_path = Path::new(input);
    let output_path = Path::new(output);

    println!("入力            : {}", input_path.display());
    println!("出力            : {}", output_path.display());
    println!("ノードあたり最大点数: {max_points_per_node}");
    println!("spill_dir       : {}", spill_dir.display());
    let input_bytes = std::fs::metadata(input_path).map(|m| m.len()).unwrap_or(0);
    println!("入力サイズ      : {:.2} MB", input_bytes as f64 / 1e6);

    let params = CopcWriterParams::new(max_points_per_node);

    let t0 = Instant::now();
    let result =
        convert_las_to_copc_streaming(input_path, output_path, &params, &spill_dir, &NeverCancel);
    let elapsed_s = t0.elapsed().as_secs_f64();

    match result {
        Ok(()) => {
            let output_bytes = std::fs::metadata(output_path).map(|m| m.len()).unwrap_or(0);
            println!("変換完了        : {elapsed_s:.2} 秒");
            println!("出力サイズ      : {:.2} MB", output_bytes as f64 / 1e6);
        }
        Err(err) => {
            eprintln!("変換に失敗した({elapsed_s:.2} 秒経過): {err}");
            std::process::exit(1);
        }
    }
}
