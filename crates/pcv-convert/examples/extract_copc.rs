//! 開発者向け: COPCから軸に平行な箱の中の点だけを新しいCOPCに切り出す(L2-C)。
//! アプリは使わない。時間とメモリ(別プロセスから見たピーク)を測るためのもの。
//!
//! ```text
//! cargo run -p pcv-convert --release --example extract_copc -- \
//!     <入力.copc.laz> <出力.copc.laz> minx miny minz maxx maxy maxz [spill_dir]
//! ```

use std::path::PathBuf;
use std::time::Instant;

use copc_core::NeverCancel;
use copc_writer::CopcWriterParams;
use pcv_convert::extract::extract_path_and_timings;
use pcv_convert::stage_timings::ConversionStageTimings;
use pcv_core::extract::{ExtractFilter, OrientedBox};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    // 引数が入力1つだけのときは、範囲と点数を表示して終わる(箱を決める手がかり)。
    if args.len() == 1 {
        match pcv_core::CopcFile::open(std::path::Path::new(&args[0])) {
            Ok(file) => {
                let info = file.info();
                println!("点数: {}", info.point_count);
                println!("min: {:?}", info.min);
                println!("max: {:?}", info.max);
            }
            Err(e) => eprintln!("開けませんでした: {e}"),
        }
        return;
    }
    if args.len() < 8 {
        eprintln!("usage: extract_copc <入力> <出力> minx miny minz maxx maxy maxz [spill_dir]");
        std::process::exit(2);
    }
    let numbers: Result<Vec<f64>, _> = args[2..8].iter().map(|s| s.parse::<f64>()).collect();
    let Ok(n) = numbers else {
        eprintln!("箱の座標が数値ではありません");
        std::process::exit(2);
    };
    let spill_dir: PathBuf = args
        .get(8)
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);

    let filter = ExtractFilter::OrientedBox(OrientedBox {
        center: [
            (n[0] + n[3]) / 2.0,
            (n[1] + n[4]) / 2.0,
            (n[2] + n[5]) / 2.0,
        ],
        axes: [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]],
        half_extents: [
            (n[3] - n[0]) / 2.0,
            (n[4] - n[1]) / 2.0,
            (n[5] - n[2]) / 2.0,
        ],
    });

    let started = Instant::now();
    let mut timings = ConversionStageTimings::default();
    let result = extract_path_and_timings(
        &PathBuf::from(&args[0]),
        filter,
        &PathBuf::from(&args[1]),
        &spill_dir,
        &CopcWriterParams::default(),
        &NeverCancel,
        |_| {},
        &mut timings,
    );
    match result {
        Ok(summary) => {
            println!("出力点数: {}", summary.point_count);
            println!("ノード: 全{} / 選択{} / 読んだ{}", summary.stats.nodes_total, summary.stats.nodes_selected, summary.stats.nodes_read);
            println!("読んだ点数: {} (最大同時保持 {} 点)", summary.stats.points_scanned, summary.stats.max_buffered_points);
            println!("所要時間: {:.2} 秒", started.elapsed().as_secs_f64());
            println!("内訳: {timings:?}");
        }
        Err(e) => {
            eprintln!("失敗: {e}");
            std::process::exit(1);
        }
    }
}
