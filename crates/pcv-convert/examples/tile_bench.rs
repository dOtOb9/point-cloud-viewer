//! G3-1 measurement: plan tiles for a COPC file and read every tile, reporting the number
//! of tiles, the points read (including re-reads of coarse-level nodes) against the header
//! count, the largest tile and the wall time.
//!
//! Usage: `cargo run --release -p pcv-convert --example tile_bench -- <file.copc.laz> [cap] [margin] [min_tile_size]`

use std::path::PathBuf;
use std::time::Instant;

use copc_reader::CopcReader;
use pcv_core::tiles::TileReader;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let Some(path) = args.get(1).map(PathBuf::from) else {
        eprintln!("usage: tile_bench <file.copc.laz> [cap] [margin] [min_tile_size]");
        return;
    };
    let parse = |i: usize, default: f64| -> f64 {
        args.get(i)
            .and_then(|s| s.parse::<f64>().ok())
            .unwrap_or(default)
    };
    let cap = parse(2, 2_000_000.0) as u64;
    let margin = parse(3, 0.0);
    let min_size = parse(4, 1.0);

    let started = Instant::now();
    let open = || CopcReader::from_path(&path);
    let reader = match TileReader::new(open, cap, min_size, margin) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("plan failed: {e}");
            return;
        }
    };
    let header_count = match CopcReader::from_path(&path) {
        Ok(r) => r.header().number_of_points(),
        Err(e) => {
            eprintln!("open failed: {e}");
            return;
        }
    };
    let tile_count = reader.tiles().len();
    println!(
        "tiles: {tile_count} (planned in {:.2?}), cap {cap}, margin {margin}, min size {min_size}",
        started.elapsed()
    );

    let (mut scanned, mut core, mut kept, mut largest) = (0u64, 0u64, 0u64, 0usize);
    let mut worst_estimate_error = 0.0f64;
    for tile in reader {
        let tile = match tile {
            Ok(t) => t,
            Err(e) => {
                eprintln!("read failed: {e}");
                return;
            }
        };
        scanned += tile.scanned_points;
        kept += tile.points.len() as u64;
        let tile_core = tile.points.iter().filter(|p| p.is_core).count();
        core += tile_core as u64;
        largest = largest.max(tile.points.len());
        if tile.estimated_points > 0.0 {
            worst_estimate_error =
                worst_estimate_error.max((tile_core as f64 - tile.estimated_points).abs());
        }
    }
    println!("header point count: {header_count}");
    println!("core points total: {core}");
    println!("points kept (core + margin): {kept}");
    println!(
        "points decompressed (scanned): {scanned} = {:.2}x header",
        scanned as f64 / header_count as f64
    );
    println!("largest tile batch: {largest}");
    println!("largest |core - estimate|: {worst_estimate_error:.0}");
    println!("wall time total: {:.2?}", started.elapsed());
}
