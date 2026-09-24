//! M4-1b(`TaskSheets/M4-import-and-conversion.md`)の計測用入口。
//!
//! M4-1の素朴な実装(`src/main.rs`)は全点をメモリへ読み込むため、点数に比例して
//! ピークメモリが増える。`copc-writer`クレートが公開している
//! `convert_las_to_copc_streaming`はout-of-core(一時ファイルへ逃がしながら
//! 組み立てる)実装なので、それを素直に呼ぶだけのラッパーを用意し、
//! ピークメモリが点数に比例せず頭打ちになるかを実測する。
//!
//! 変換アルゴリズム自体はこのクレートの外(`copc-writer`本体)にあるため、
//! ここでは呼び出しと計測だけを行う。最適化やパラメータ調整はしていない。
//!
//! ```text
//! cargo run -p pcv-convert --release --example convert_streaming -- \
//!     <入力.las/.laz> <出力.copc.laz> [ノードあたり最大点数=100000] [spill_dir]
//! ```
//!
//! 引数の既定値:
//! - ノードあたり最大点数: `CopcWriterParams::default()`と同じ100,000点
//! - spill_dir: 未指定なら`std::env::temp_dir()`(OS既定の一時ディレクトリ)
//!
//! **spill_dirについて分かったこと**: `convert_las_to_copc_streaming`に渡す
//! `spill_dir`引数は、点レコードそのものを吐き出す一時ファイル
//! (`.copc-writer-spill.*.part`)の置き場所しか制御しない。octree構築が使う
//! LOD indexの一時ファイル(`.copc-writer-root.*.idx`・
//! `.copc-writer-partition.*.idx`・`.copc-writer-order.*.idx`。
//! `copc-writer`の`lod.rs`の`new_index_tempfile`)は、`tempfile::Builder::tempfile()`
//! (ディレクトリ指定なし)で常にOS既定の一時ディレクトリに作られる実装になっており、
//! spill_dirをどこに変えても影響しない。したがって一時ファイルの総使用量を
//! 測るにはOS既定の一時ディレクトリ側を見る必要がある(このexampleでは
//! spill_dirの既定値もOS既定の一時ディレクトリにしているため、変換に関わる
//! 一時ファイルはすべて同じディレクトリに集まる)。
//!
//! ピークメモリ・一時ディレクトリの使用量はこのプロセスの外(PowerShell)から測る。
//! 実行結果の記録方法は`TaskSheets/M4-import-and-conversion.md`のM4-1bを参照。

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
