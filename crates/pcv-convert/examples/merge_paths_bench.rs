//! M4-14: デスクトップ/Androidのアプリが使う入口
//! (`pcv_convert::merge::merge_paths_and_timings`。`src-tauri`の
//! `start_multi_las_conversion`が呼ぶのと同じ関数)を、Tauriを起動せずに
//! 直接呼んで所要時間を測る例。ピークメモリは外部(PowerShell等)から
//! このプロセスの`PrivateMemorySize64`を測る(`TaskSheets/ADR-0006`と同じ方法)。
//!
//! ```text
//! merge_paths_bench <出力.copc.laz> <入力1.las> <入力2.las> ...
//! ```

use std::path::{Path, PathBuf};
use std::time::Instant;

use copc_core::NeverCancel;
use copc_writer::CopcWriterParams;
use pcv_convert::merge::merge_paths_and_timings;
use pcv_convert::stage_timings::ConversionStageTimings;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some((output, inputs)) = args.split_first() else {
        eprintln!("usage: merge_paths_bench <出力.copc.laz> <入力.las>...");
        std::process::exit(2);
    };
    let paths: Vec<PathBuf> = inputs.iter().map(PathBuf::from).collect();
    let mut timings = ConversionStageTimings::default();
    let started = Instant::now();
    let mut last_report = 0u64;
    let result = merge_paths_and_timings(
        paths,
        Path::new(output),
        &std::env::temp_dir(),
        &CopcWriterParams::default(),
        &NeverCancel,
        |p| last_report = p.points_read,
        &mut timings,
    );
    match result {
        Ok(summary) => println!(
            "OK: {:.2}秒 申告点数={} 最後の進捗={} 内訳合計={:.2}秒",
            started.elapsed().as_secs_f64(),
            summary.declared_points_total,
            last_report,
            timings.total().as_secs_f64()
        ),
        Err(e) => {
            eprintln!("失敗: {e}");
            std::process::exit(1);
        }
    }
}
