//! M4-1(`TaskSheets/M4-import-and-conversion.md`)のスパイク: 生LAS/LAZをCOPCへ
//! 素朴な実装で変換し、かかる時間を測る。最適化はしていない。
//!
//! ```text
//! cargo run -p pcv-convert --release -- <入力.las/.laz> <出力.copc.laz> [ノードあたり最大点数]
//! ```
//!
//! ピークメモリはこのプロセスの外(PowerShellで`Process.PeakWorkingSet64`を
//! ポーリング)から測る。実行結果の記録方法は`TaskSheets/M4-import-and-conversion.md`
//! のM4-1「結果」を参照。

use std::path::Path;
use std::time::Instant;

use pcv_convert::{octree, point, writer};

const DEFAULT_MAX_POINTS_PER_NODE: usize = 100_000;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (Some(input), Some(output)) = (args.first(), args.get(1)) else {
        eprintln!(
            "usage: pcv-convert <入力.las/.laz> <出力.copc.laz> [ノードあたり最大点数={DEFAULT_MAX_POINTS_PER_NODE}]"
        );
        std::process::exit(2);
    };
    let max_points_per_node = args
        .get(2)
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_MAX_POINTS_PER_NODE);

    if let Err(err) = run(Path::new(input), Path::new(output), max_points_per_node) {
        eprintln!("変換に失敗した: {err}");
        std::process::exit(1);
    }
}

fn run(input: &Path, output: &Path, max_points_per_node: usize) -> Result<(), String> {
    println!("入力            : {}", input.display());
    println!("出力            : {}", output.display());
    println!("ノードあたり最大点数: {max_points_per_node}");
    let input_bytes = std::fs::metadata(input).map(|m| m.len()).unwrap_or(0);
    println!("入力サイズ      : {:.2} MB", input_bytes as f64 / 1e6);

    let t0 = Instant::now();
    let source = point::read_all(input).map_err(|e| e.to_string())?;
    let read_s = t0.elapsed().as_secs_f64();
    println!(
        "読み込み        : {read_s:.2} 秒 ({} 点, 色あり={})",
        source.points.len(),
        source.has_color
    );

    let t1 = Instant::now();
    let (center, halfsize) = octree::cube_from_bounds(source.bounds_min, source.bounds_max);
    let nodes = octree::build(&source.points, center, halfsize, max_points_per_node);
    let octree_s = t1.elapsed().as_secs_f64();
    println!(
        "octree構築      : {octree_s:.2} 秒 ({} ノード)",
        nodes.len()
    );

    let t2 = Instant::now();
    let stats =
        writer::write(output, &source, &nodes, center, halfsize).map_err(|e| e.to_string())?;
    let write_s = t2.elapsed().as_secs_f64();
    println!(
        "書き出し        : {write_s:.2} 秒 ({:.2} MB)",
        stats.output_bytes as f64 / 1e6
    );

    let total_s = t0.elapsed().as_secs_f64();
    println!("合計            : {total_s:.2} 秒");
    println!(
        "検算            : 入力{}点 → 出力{}点 (一致={})",
        source.points.len(),
        stats.total_points,
        source.points.len() as u64 == stats.total_points
    );
    println!("ノード数        : {}", stats.node_count);

    Ok(())
}
