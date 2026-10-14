//! Developer tool: cut the points inside an axis-aligned box out of a COPC file into
//! a new COPC file (L2-C). The app does not use it; it exists to measure time and
//! memory (peak seen from another process).
//!
//! ```text
//! cargo run -p pcv-convert --release --example extract_copc -- \
//!     <input.copc.laz> <output.copc.laz> minx miny minz maxx maxy maxz [spill_dir]
//! ```
//!
//! With only the input path it prints the point count and bounds (a hint for
//! choosing the box).

use std::path::PathBuf;
use std::time::Instant;

use copc_core::NeverCancel;
use copc_writer::CopcWriterParams;
use pcv_convert::extract::extract_path_and_timings;
use pcv_convert::stage_timings::ConversionStageTimings;
use pcv_core::extract::{ExtractFilter, OrientedBox};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() == 1 {
        match pcv_core::CopcFile::open(std::path::Path::new(&args[0])) {
            Ok(file) => {
                let info = file.info();
                println!("points: {}", info.point_count);
                println!("min: {:?}", info.min);
                println!("max: {:?}", info.max);
            }
            Err(e) => eprintln!("could not open: {e}"),
        }
        return;
    }
    if args.len() < 8 {
        eprintln!("usage: extract_copc <input> <output> minx miny minz maxx maxy maxz [spill_dir]");
        std::process::exit(2);
    }
    let numbers: Result<Vec<f64>, _> = args[2..8].iter().map(|s| s.parse::<f64>()).collect();
    let Ok(n) = numbers else {
        eprintln!("box coordinates are not numbers");
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
            println!("output points: {}", summary.point_count);
            println!(
                "nodes: total {} / selected {} / read {}",
                summary.stats.nodes_total, summary.stats.nodes_selected, summary.stats.nodes_read
            );
            println!(
                "points read: {} (max held at once: {})",
                summary.stats.points_scanned, summary.stats.max_buffered_points
            );
            println!("elapsed: {:.2} s", started.elapsed().as_secs_f64());
            println!("breakdown: {timings:?}");
        }
        Err(e) => {
            eprintln!("failed: {e}");
            std::process::exit(1);
        }
    }
}
