//! G3 measurement: thin a COPC file or remove outliers from it and print the number of
//! tiles, the points read (against the header count), the kept count and the wall time.
//! Peak memory is measured from outside (see `TaskSheets/G3-T7-thin-filter-core.md`).
//!
//! ```text
//! cargo run --release -p pcv-convert --example thin_filter_bench -- <in.copc.laz> <out.copc.laz> <mode> [args]
//!   grid   <size> [nearest|lowest|highest]
//!   voxel  <size>
//!   ror    <radius> <min_neighbors>
//!   sor    <k> <n_sigma> <search_radius>
//! env PCV_TILE_CAP (default 2000000) is the points-per-tile target.
//! ```

use std::path::PathBuf;
use std::time::Instant;

use copc_core::NeverCancel;
use copc_writer::CopcWriterParams;
use pcv_convert::stage_timings::ConversionStageTimings;
use pcv_convert::thin_filter::{
    filter_path, thin_path, OutlierFilter, ThinFilterSummary, TilingParams,
};
use pcv_core::outlier::{RorSettings, SorSettings};
use pcv_core::thin::{GridKeep, ThinKind, ThinSettings};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() < 4 {
        eprintln!("usage: thin_filter_bench <in> <out> grid|voxel|ror|sor <args...> (see the file header)");
        std::process::exit(2);
    }
    let source = PathBuf::from(&args[0]);
    let output = PathBuf::from(&args[1]);
    let number = |i: usize| -> f64 {
        match args.get(i).and_then(|s| s.parse::<f64>().ok()) {
            Some(v) => v,
            None => {
                eprintln!("argument {i} is missing or not a number");
                std::process::exit(2);
            }
        }
    };
    let cap = std::env::var("PCV_TILE_CAP")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(2_000_000);
    let tiling = TilingParams {
        cap_points: cap,
        min_tile_size: 0.0,
    };
    let header_count = match copc_reader::CopcReader::from_path(&source) {
        Ok(r) => r.header().number_of_points(),
        Err(e) => {
            eprintln!("could not open: {e}");
            std::process::exit(1);
        }
    };
    let spill_dir = std::env::temp_dir();
    let params = CopcWriterParams::new(100_000);
    let mut timings = ConversionStageTimings::default();
    let started = Instant::now();

    let result: Result<ThinFilterSummary, String> = match args[2].as_str() {
        "grid" | "voxel" => {
            let kind = if args[2] == "voxel" {
                ThinKind::Voxel
            } else {
                match args.get(4).map(String::as_str) {
                    Some("lowest") => ThinKind::Grid(GridKeep::Lowest),
                    Some("highest") => ThinKind::Grid(GridKeep::Highest),
                    _ => ThinKind::Grid(GridKeep::NearestCentre),
                }
            };
            let settings = ThinSettings {
                size: number(3),
                kind,
            };
            thin_path(
                &source,
                &settings,
                &tiling,
                &output,
                &spill_dir,
                &params,
                &NeverCancel,
                |_| {},
                &mut timings,
            )
            .map_err(|e| e.to_string())
        }
        mode @ ("ror" | "sor") => {
            let filter = if mode == "ror" {
                OutlierFilter::Ror(RorSettings {
                    radius: number(3),
                    min_neighbors: number(4) as u32,
                })
            } else {
                OutlierFilter::Sor(SorSettings {
                    k: number(3) as usize,
                    n_sigma: number(4),
                    search_radius: number(5),
                })
            };
            filter_path(
                &source,
                &filter,
                &tiling,
                &output,
                &spill_dir,
                &params,
                &NeverCancel,
                |_| {},
                &mut timings,
            )
            .map_err(|e| e.to_string())
        }
        other => Err(format!("unknown mode {other}")),
    };

    let wall = started.elapsed();
    match result {
        Ok(s) => {
            let passes = if args[2] == "sor" { 2.0 } else { 1.0 };
            println!("mode: {} (tile cap {cap})", args[2]);
            println!("header points: {header_count}");
            println!("tiles per pass: {}", s.tile_count as f64 / passes);
            println!("core points handled: {}", s.core_points_read);
            println!(
                "points decompressed: {} = {:.2}x header per pass",
                s.points_scanned,
                s.points_scanned as f64 / (header_count as f64 * passes)
            );
            println!(
                "kept: {} ({:.2} % of header)",
                s.kept_points,
                100.0 * s.kept_points as f64 / header_count as f64
            );
            println!("largest tile (core + margin): {}", s.largest_tile_points);
            if let Some(sor) = s.sor {
                println!(
                    "sor mean {:.4} std {:.4} threshold {:.4}",
                    sor.mean, sor.std, sor.threshold
                );
            }
            println!("wall time: {wall:.2?}");
        }
        Err(e) => {
            eprintln!("failed after {wall:.2?}: {e}");
            std::process::exit(1);
        }
    }
}
