//! PF-0 benchmark: run the production LAS/LAZ conversion path (`convert_and_timings`, the same call
//! `src-tauri` makes) and print the stage timings plus a timeline of the ingest progress.
//!
//! ```text
//! cargo run -p pcv-convert --release --example convert_timings -- \
//!     <input.las/.laz> <output.copc.laz> <spill_dir>
//! ```
//!
//! The timeline shows when 1% / 10% / 50% / 100% of the points had been read. That is the time
//! before which a "preview from the points read so far" (ADR-0024 option a) cannot show them.
//! Peak memory and disk use are measured from outside (PowerShell), as in the other benches.

use std::fs::File;
use std::io::BufReader;
use std::path::Path;
use std::time::Instant;

use copc_core::NeverCancel;
use copc_writer::CopcWriterParams;
use pcv_convert::stage_timings::ConversionStageTimings;
use pcv_convert::streaming::{convert_and_timings, ReadProgress};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (Some(input), Some(output), Some(spill)) = (args.first(), args.get(1), args.get(2)) else {
        eprintln!("usage: convert_timings <input.las/.laz> <output.copc.laz> <spill_dir>");
        std::process::exit(2);
    };
    let file = match File::open(input) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("cannot open {input}: {e}");
            std::process::exit(1);
        }
    };
    let started = Instant::now();
    let marks = [0.01_f64, 0.10, 0.50, 1.0];
    let mut next_mark = 0usize;
    let mut last_total = 0u64;
    let on_progress = |p: ReadProgress| {
        last_total = p.total_points;
        while next_mark < marks.len()
            && (p.points_read as f64) >= marks[next_mark] * (p.total_points as f64)
        {
            println!(
                "READ {:>5.0}% ({} points) at {:.2} s",
                marks[next_mark] * 100.0,
                p.points_read,
                started.elapsed().as_secs_f64()
            );
            next_mark += 1;
        }
    };
    let mut timings = ConversionStageTimings::default();
    let result = convert_and_timings(
        BufReader::new(file),
        Path::new(output),
        Path::new(spill),
        &CopcWriterParams::default(),
        &NeverCancel,
        on_progress,
        &mut timings,
    );
    let wall = started.elapsed().as_secs_f64();
    if let Err(e) = result {
        eprintln!("conversion failed: {e}");
        std::process::exit(1);
    }
    println!("points            : {last_total}");
    println!("read+decode (s)   : {:.2}", timings.source_read_and_decode.as_secs_f64());
    println!("spill write (s)   : {:.2}", timings.spill_write.as_secs_f64());
    println!("LOD index (s)     : {:.2}", timings.lod_index_build.as_secs_f64());
    println!("node compress (s) : {:.2}", timings.node_compression.as_secs_f64());
    println!("header+hier (s)   : {:.2}", timings.header_and_hierarchy_write.as_secs_f64());
    println!("stage total (s)   : {:.2}", timings.total().as_secs_f64());
    println!("wall (s)          : {wall:.2}");
    println!(
        "output (MB)       : {:.1}",
        std::fs::metadata(output).map(|m| m.len()).unwrap_or(0) as f64 / 1e6
    );
}
