//! Developer tool: rasterise a COPC file (G1-3) and print the time. The app does not
//! use it; it exists to measure time and memory (peak seen from another process).
//!
//! ```text
//! cargo run -p pcv-convert --release --example rasterize_copc -- \
//!     <input.copc.laz> <out.tif> <out.copc.laz> <cell_size> <kind> [ground] [spill_dir]
//! ```
//!
//! `kind` is one of `zMin zMax zMean count intensityMean rgbMean`. Put the word
//! `ground` as the sixth argument to count only class 2.

use std::path::PathBuf;
use std::time::Instant;

use copc_core::NeverCancel;
use copc_writer::CopcWriterParams;
use pcv_convert::raster::rasterize_path_and_timings;
use pcv_convert::stage_timings::ConversionStageTimings;
use pcv_core::raster::{RasterOptions, RasterValue};

fn parse_kind(text: &str) -> Option<RasterValue> {
    Some(match text {
        "zMin" => RasterValue::ZMin,
        "zMax" => RasterValue::ZMax,
        "zMean" => RasterValue::ZMean,
        "count" => RasterValue::Count,
        "intensityMean" => RasterValue::IntensityMean,
        "rgbMean" => RasterValue::RgbMean,
        _ => return None,
    })
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() < 5 {
        eprintln!(
            "usage: rasterize_copc <input> <out.tif> <out.copc.laz> <cell_size> <kind> [ground] [spill_dir]"
        );
        std::process::exit(2);
    }
    let (Ok(cell_size), Some(value)) = (args[3].parse::<f64>(), parse_kind(&args[4])) else {
        eprintln!("cell_size or kind is not valid");
        std::process::exit(2);
    };
    let ground_only = args.get(5).is_some_and(|a| a == "ground");
    let spill_dir: PathBuf = args
        .get(6)
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);

    let started = Instant::now();
    let mut timings = ConversionStageTimings::default();
    let result = rasterize_path_and_timings(
        &PathBuf::from(&args[0]),
        RasterOptions {
            cell_size,
            value,
            ground_only,
        },
        64_000_000,
        &PathBuf::from(&args[1]),
        &PathBuf::from(&args[2]),
        &spill_dir,
        &CopcWriterParams::default(),
        &NeverCancel,
        |_| {},
        &mut timings,
    );
    match result {
        Ok(summary) => {
            println!(
                "grid: {} x {} cells, points counted: {}, display points: {}",
                summary.width, summary.height, summary.points_counted, summary.display_points
            );
            println!(
                "nodes read: {} / {}, max buffered points: {}",
                summary.stats.nodes_read,
                summary.stats.nodes_total,
                summary.stats.max_buffered_points
            );
            for warning in &summary.warnings {
                println!("warning: {warning}");
            }
            println!("elapsed: {:.2?}", started.elapsed());
        }
        Err(e) => {
            eprintln!("failed: {e}");
            std::process::exit(1);
        }
    }
}
