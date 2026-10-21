//! Developer tool: rasterise a COPC file (G1-3 / G1-R2) and print the time. The app does
//! not use it; it exists to measure time and memory (peak seen from another process).
//!
//! Export (every point, one GeoTIFF):
//!
//! ```text
//! cargo run -p pcv-convert --release --example rasterize_copc -- \
//!     export <input.copc.laz> <out.tif> <cell_size> <kind> [ground] [values]
//! ```
//!
//! Preview (what the window does: read the upper levels once, then switch):
//!
//! ```text
//! cargo run -p pcv-convert --release --example rasterize_copc -- \
//!     preview <input.copc.laz> <cell_size> [cap]
//! ```
//!
//! `kind` is one of `zMin zMax zMean count intensityMean rgbMean`. The word `ground`
//! counts only class 2; the word `values` writes the raw-value GeoTIFF (the default
//! is the colored one).

use std::path::PathBuf;
use std::time::Instant;

use copc_core::NeverCancel;
use pcv_convert::raster::{rasterize_path, read_coarse_path};
use pcv_core::raster::preview::{PreviewOptions, PREVIEW_POINT_BUDGET};
use pcv_core::raster::{RasterOptions, RasterValue, TiffKind};

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

fn usage() -> ! {
    eprintln!(
        "usage:\n  rasterize_copc export <input> <out.tif> <cell_size> <kind> [ground] [values]\n  rasterize_copc preview <input> <cell_size> [cap]"
    );
    std::process::exit(2);
}

fn export(args: &[String]) {
    if args.len() < 4 {
        usage();
    }
    let (Ok(cell_size), Some(value)) = (args[2].parse::<f64>(), parse_kind(&args[3])) else {
        eprintln!("cell_size or kind is not valid");
        std::process::exit(2);
    };
    let ground_only = args.iter().skip(4).any(|a| a == "ground");
    let tiff = if args.iter().skip(4).any(|a| a == "values") {
        TiffKind::Values
    } else {
        TiffKind::Colored
    };
    let started = Instant::now();
    let result = rasterize_path(
        &PathBuf::from(&args[0]),
        RasterOptions {
            cell_size,
            value,
            ground_only,
            tiff,
            range: None,
        },
        64_000_000,
        &PathBuf::from(&args[1]),
        &NeverCancel,
        |_| {},
    );
    match result {
        Ok(summary) => {
            println!(
                "grid: {} x {} cells, points counted: {}",
                summary.width, summary.height, summary.points_counted
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

fn preview(args: &[String]) {
    if args.len() < 2 {
        usage();
    }
    let Ok(cell_size) = args[1].parse::<f64>() else {
        eprintln!("cell_size is not valid");
        std::process::exit(2);
    };
    let cap = args
        .get(2)
        .and_then(|a| a.parse::<usize>().ok())
        .unwrap_or(PREVIEW_POINT_BUDGET as usize);

    let started = Instant::now();
    let store = match read_coarse_path(&PathBuf::from(&args[0]), cap, &NeverCancel, |_| {}) {
        Ok(store) => store,
        Err(e) => {
            eprintln!("failed: {e}");
            std::process::exit(1);
        }
    };
    println!("read upper levels: {:.2?}", started.elapsed());
    println!("{:?}", store.open_info());
    println!("held bytes: {}", store.bytes_held());

    for (label, value, ground_only) in [
        ("rgbMean", RasterValue::RgbMean, false),
        ("zMean", RasterValue::ZMean, false),
        ("count", RasterValue::Count, false),
        ("intensityMean", RasterValue::IntensityMean, false),
        ("zMean ground", RasterValue::ZMean, true),
    ] {
        let t = Instant::now();
        let options = PreviewOptions {
            cell_size,
            value,
            ground_only,
        };
        match store.render(&options) {
            Ok(image) => println!(
                "render {label}: {:.2?} ({} x {} cells, preview cell {:.3}, {} points, {} filled, range {:?})",
                t.elapsed(),
                image.width,
                image.height,
                image.cell_size,
                image.points,
                image.filled_cells,
                image.range
            ),
            Err(e) => println!("render {label}: {e}"),
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("export") => export(&args[1..]),
        Some("preview") => preview(&args[1..]),
        _ => usage(),
    }
}
