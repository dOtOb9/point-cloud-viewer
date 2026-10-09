//! 開発者向けCLI: 隣接する多数のLAS/LAZタイルを1つのCOPCにまとめる。
//!
//! 本体の設計・前提は`crates/pcv-convert/src/merge.rs`冒頭のコメント、
//! 使い方の詳細・実測値は`TaskSheets/TOOL-merge-las-to-copc.md`を参照。
//! アプリ(デスクトップ/Android/Web)はこの経路を使わない。1ファイルずつしか
//! 開けないビューアに「隣接タイルをまとめた1ファイル」を食わせるための、
//! 開発者が手で実行するツール。
//!
//! ```text
//! cargo run -p pcv-convert --release --example merge_las_to_copc -- \
//!     <入力ディレクトリ or globパターン> <出力.copc.laz> \
//!     [ノードあたり最大点数=100000] [spill_dir=OS既定の一時ディレクトリ] \
//!     [--sequential-compress]
//! ```
//!
//! - 入力: ディレクトリを渡すと配下の`*.las`/`*.laz`(大小文字区別なし)を
//!   ファイル名の昇順に集める。ディレクトリとして存在しない文字列は
//!   globパターンとして扱う(例: `data/tokyo-shibuya/*.las`)。
//! - `--sequential-compress`: `copc-writer`の既存の並列オプション
//!   (`CopcWriterParams::parallel_node_compression`。`parallel-compress`
//!   フィーチャの既定はtrue)を明示的に無効化する。
//!   `examples/post_process_stage_bench.rs`の`force_sequential_compress`と
//!   同じ使い方。計測・デバッグ用で、通常は付けない。

use std::path::{Path, PathBuf};
use std::time::Instant;

use copc_core::NeverCancel;
use copc_writer::{write_streaming_with_cancel_and_timings, CopcWriterParams};
use pcv_convert::merge::{collect_input_paths, summarize_headers, MultiFileLasPoints};

fn main() {
    let raw_args: Vec<String> = std::env::args().skip(1).collect();
    let sequential_compress = raw_args.iter().any(|a| a == "--sequential-compress");
    let positional: Vec<&String> = raw_args.iter().filter(|a| !a.starts_with("--")).collect();

    let (Some(input), Some(output)) = (positional.first(), positional.get(1)) else {
        eprintln!(
            "usage: merge_las_to_copc <入力ディレクトリ or glob> <出力.copc.laz> \
             [ノードあたり最大点数=100000] [spill_dir=OS既定の一時ディレクトリ] \
             [--sequential-compress]"
        );
        std::process::exit(2);
    };
    let max_points_per_node: u32 = positional
        .get(2)
        .and_then(|s| s.parse().ok())
        .unwrap_or(100_000);
    let spill_dir: PathBuf = positional
        .get(3)
        .map(|s| PathBuf::from(s.as_str()))
        .unwrap_or_else(std::env::temp_dir);

    let output_path = Path::new(output.as_str());

    if let Err(err) = run(
        input,
        output_path,
        max_points_per_node,
        &spill_dir,
        sequential_compress,
    ) {
        eprintln!("マージに失敗した: {err}");
        std::process::exit(1);
    }
}

fn run(
    input: &str,
    output: &Path,
    max_points_per_node: u32,
    spill_dir: &Path,
    sequential_compress: bool,
) -> Result<(), String> {
    println!("入力            : {input}");
    println!("出力            : {}", output.display());
    println!("ノードあたり最大点数: {max_points_per_node}");
    println!("spill_dir       : {}", spill_dir.display());
    println!(
        "ノード圧縮      : {}",
        if sequential_compress {
            "逐次(--sequential-compress指定)"
        } else {
            "並列(既定、parallel-compressフィーチャ)"
        }
    );

    let paths = collect_input_paths(input).map_err(|e| e.to_string())?;
    println!("入力ファイル数  : {}", paths.len());

    let t_header = Instant::now();
    let summary = summarize_headers(&paths).map_err(|e| e.to_string())?;
    println!(
        "ヘッダー確認    : {:.2} 秒 (申告点数の合計={}, レイアウト: point_format={} 色あり={})",
        t_header.elapsed().as_secs_f64(),
        summary.declared_points_total,
        summary.layout.point_format,
        summary.layout.has_color,
    );
    println!(
        "CRS(WKT)        : {}",
        summary
            .metadata
            .wkt_crs
            .as_deref()
            .unwrap_or("(なし。CRSが失われる)")
    );

    let params = CopcWriterParams::new(max_points_per_node)
        .with_parallel_node_compression(!sequential_compress);
    let points = MultiFileLasPoints::new(paths, summary.declared_points_total);

    let t0 = Instant::now();
    let result = write_streaming_with_cancel_and_timings(
        output,
        summary.layout,
        points,
        &params,
        &summary.metadata,
        spill_dir,
        &NeverCancel,
        None,
        None,
    );
    let elapsed_s = t0.elapsed().as_secs_f64();

    match result {
        Ok(()) => {
            let output_bytes = std::fs::metadata(output).map(|m| m.len()).unwrap_or(0);
            println!("マージ完了      : {elapsed_s:.2} 秒");
            println!("出力サイズ      : {:.2} MB", output_bytes as f64 / 1e6);
            Ok(())
        }
        Err(err) => Err(format!("{err}({elapsed_s:.2} 秒経過)")),
    }
}
