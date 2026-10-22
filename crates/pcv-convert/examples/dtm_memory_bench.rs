//! Developer tool: run `pcv_core::dtm::DtmJob` phase by phase WITHOUT the COPC writer, and print a time mark (Unix
//! milliseconds) at every phase boundary, so that a memory sampler running in another process can split the peak into
//! the cloth, the best-point grid, the TIN and the file writers. See `TaskSheets/BENCH-dtm-memory.md`.
//!
//! ```text
//! cargo run -p pcv-convert --release --example dtm_memory_bench -- \
//!     <input.copc.laz> <out_dir> <cloth_resolution> <cell_size>
//! ```
//!
//! Lengths are in the file's unit. Standard CSF preset; both the GeoTIFF (values) and the LandXML are written, one
//! after the other, so each shows as its own step in the samples. The classified points are dropped (no writer).

use std::fs::File;
use std::io::BufWriter;
use std::path::PathBuf;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use copc_reader::CopcReader;
use pcv_core::dtm::{DtmJob, DtmOutputOptions, DtmRequest, LandXmlOptions, LandXmlUnit};
use pcv_core::raster::TiffKind;
use pcv_core::section_line::CsfParamsInput;

fn unix_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis())
}

/// One line per phase boundary: `MARK <unix ms> <seconds since start> <name>`.
fn mark(start: Instant, name: &str) {
    println!(
        "MARK {} {:.1} {name}",
        unix_ms(),
        start.elapsed().as_secs_f64()
    );
}

fn main() -> Result<(), String> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 5 {
        return Err("usage: <input> <out_dir> <cloth_resolution> <cell_size>".to_string());
    }
    let source = PathBuf::from(&args[1]);
    let out_dir = PathBuf::from(&args[2]);
    let cloth: f64 = args[3].parse().map_err(|e| format!("cloth: {e}"))?;
    let cell: f64 = args[4].parse().map_err(|e| format!("cell: {e}"))?;
    std::fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;

    let request = DtmRequest {
        csf: CsfParamsInput {
            cloth_resolution: cloth,
            rigidness: 3,
            time_step: 0.65,
            class_threshold_upper: 0.1,
            class_threshold_lower: 1.0,
            iterations: 500,
            slope_smooth: true,
            hdiff: 0.3,
            convergence_threshold: 0.005,
        },
        cell_size: cell,
        display_unit: None,
        output: DtmOutputOptions {
            geotiff: true,
            landxml: true,
            tiff: TiffKind::Values,
            unit: LandXmlUnit::Meter,
        },
    };
    // Measuring: no practical cap here.
    let params = request.to_params(u64::MAX / 2, u64::MAX / 2);

    let start = Instant::now();
    mark(start, "start");
    let mut reader = CopcReader::from_path(&source).map_err(|e| e.to_string())?;
    let mut job = DtmJob::new(&reader, None, &params).map_err(|e| e.to_string())?;
    let grid = *job.grid();
    println!(
        "grid {} x {} = {} cells; cloth + best-point grid = {} bytes; {} nodes",
        grid.width,
        grid.height,
        grid.cell_count(),
        job.memory_bytes(),
        job.node_count()
    );
    mark(start, "job_created");

    let mut last = 0.0f32;
    let mut dropped = 0u64;
    loop {
        let p = job.advance(&mut reader).map_err(|e| e.to_string())?;
        dropped += job.take_records().len() as u64;
        if last < 0.25 && p.fraction >= 0.25 {
            mark(start, "pass1_done");
        }
        if last < 0.55 && p.fraction >= 0.55 {
            mark(start, "simulation_done");
        }
        last = p.fraction;
        if p.done {
            break;
        }
    }
    mark(start, "pass2_done");
    println!(
        "classified {dropped} points ({} ground), most points held at once {}",
        job.points_ground(),
        job.max_buffered_points()
    );

    // `finish` frees the cloth and the best-point grid, then builds the TIN.
    let surface = job.finish().map_err(|e| e.to_string())?;
    mark(start, "tin_built");
    println!(
        "TIN {} vertices / {} triangles",
        surface.ground_cells(),
        surface.triangle_count()
    );

    let tif = out_dir.join("dtm.tif");
    {
        let mut out = BufWriter::new(File::create(&tif).map_err(|e| e.to_string())?);
        surface
            .write_geotiff(&mut out, TiffKind::Values)
            .map_err(|e| e.to_string())?;
        std::io::Write::flush(&mut out).map_err(|e| e.to_string())?;
    }
    mark(start, "geotiff_written");

    let xml = out_dir.join("dtm.xml");
    {
        let mut out = BufWriter::new(File::create(&xml).map_err(|e| e.to_string())?);
        surface
            .write_landxml(
                &mut out,
                &LandXmlOptions {
                    name: "bench",
                    unit: LandXmlUnit::Meter,
                    unix_seconds: 0,
                },
            )
            .map_err(|e| e.to_string())?;
        std::io::Write::flush(&mut out).map_err(|e| e.to_string())?;
    }
    mark(start, "landxml_written");

    drop(surface);
    mark(start, "tin_dropped");
    for path in [&tif, &xml] {
        if let Ok(meta) = std::fs::metadata(path) {
            println!("{}: {} bytes", path.display(), meta.len());
        }
    }
    Ok(())
}
