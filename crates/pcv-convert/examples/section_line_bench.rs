//! Times the section line (G2-4) on a real COPC file and prints the result.
//!
//! ```text
//! cargo run --release -p pcv-convert --example section_line_bench -- <file.copc.laz>
//!     prints the bounding box and the CRS (to choose A and B)
//! cargo run --release -p pcv-convert --example section_line_bench -- <file> ax ay az bx by bz [standard|steep] [half_width] [resolution]
//!     computes the line; lengths are in the file's unit (defaults: standard, 20, 0.5)
//! ```
//!
//! Prints the time of each phase (pass 1, simulation, pass 2, TIN), the cell and ground point counts, and
//! the line as `s z` rows when `PCV_PRINT_LINE=1`.

use std::path::Path;
use std::time::Instant;

use pcv_core::csf::CsfParams;
use pcv_core::profile::SectionLine;
use pcv_core::section_line::{SectionLineJob, SectionLineParams};
use pcv_core::CopcFile;

fn number(args: &[String], i: usize) -> Result<f64, String> {
    args.get(i)
        .ok_or_else(|| format!("argument {i} is missing"))?
        .parse::<f64>()
        .map_err(|e| format!("argument {i}: {e}"))
}

fn main() -> Result<(), String> {
    let args: Vec<String> = std::env::args().collect();
    let path = args.get(1).ok_or("usage: <file> [ax ay az bx by bz ...]")?;
    let mut file = CopcFile::open(Path::new(path)).map_err(|e| e.to_string())?;
    let info = file.info();
    println!(
        "{} points, min {:?}, max {:?}, crs {:?}",
        info.point_count, info.min, info.max, info.crs
    );
    if args.len() < 8 {
        return Ok(());
    }
    let line = SectionLine {
        a: [number(&args, 2)?, number(&args, 3)?, number(&args, 4)?],
        b: [number(&args, 5)?, number(&args, 6)?, number(&args, 7)?],
        up: [0.0, 0.0, 1.0],
    };
    let preset = args.get(8).map_or("standard", String::as_str);
    let csf = match preset {
        "steep" => CsfParams::steep(),
        _ => CsfParams::standard(),
    };
    let half_width = if args.len() > 9 {
        number(&args, 9)?
    } else {
        20.0
    };
    let resolution = if args.len() > 10 {
        number(&args, 10)?
    } else {
        0.5
    };
    let params = SectionLineParams {
        corridor_half_width: half_width,
        csf: CsfParams {
            cloth_resolution: resolution,
            ..csf
        },
        max_cells: 4_000_000,
    };

    let total = Instant::now();
    let mut job = SectionLineJob::new(&file, &line, &params).map_err(|e| e.to_string())?;
    println!(
        "preset {preset}, half width {half_width}, resolution {resolution}, cells {}",
        job.cell_count()
    );
    // The phases are told apart by the fraction: 0..0.30 pass 1, 0.30..0.60 simulation, 0.60..0.95 pass 2.
    let mut marks = [None::<f64>; 3];
    let mut advances = 0u32;
    loop {
        let p = job.advance(&mut file).map_err(|e| e.to_string())?;
        advances += 1;
        let elapsed = total.elapsed().as_secs_f64();
        if p.fraction >= 0.30 && marks[0].is_none() {
            marks[0] = Some(elapsed);
        }
        if p.fraction >= 0.60 && marks[1].is_none() {
            marks[1] = Some(elapsed);
        }
        if p.done {
            marks[2] = Some(elapsed);
            break;
        }
    }
    let ground_points = job.ground_point_count();
    let tin_start = Instant::now();
    let bytes = job.finish().map_err(|e| e.to_string())?;
    let tin_secs = tin_start.elapsed().as_secs_f64();
    let count = u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
    println!("pass 1 (read + IHV): {:.2} s", marks[0].unwrap_or(f64::NAN));
    println!(
        "simulation:          {:.2} s",
        marks[1].unwrap_or(f64::NAN) - marks[0].unwrap_or(f64::NAN)
    );
    println!(
        "pass 2 (classify):   {:.2} s",
        marks[2].unwrap_or(f64::NAN) - marks[1].unwrap_or(f64::NAN)
    );
    println!("TIN + sampling:      {tin_secs:.3} s");
    println!(
        "total:               {:.2} s ({advances} advance calls)",
        total.elapsed().as_secs_f64()
    );
    println!("ground points {ground_points}, line samples {count}");
    if std::env::var("PCV_PRINT_LINE").is_ok_and(|v| v == "1") {
        for i in 0..count as usize {
            let o = 16 + i * 8;
            let s = f32::from_le_bytes([bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]]);
            let z = f32::from_le_bytes([bytes[o + 4], bytes[o + 5], bytes[o + 6], bytes[o + 7]]);
            println!("{s} {z}");
        }
    }
    Ok(())
}
