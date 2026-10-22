//! Developer tool: run the DTM tool (G1-T15) on a COPC file and print the times, the counts and the agreement of CSF
//! with the source classification. The app does not use it; it exists to measure time and memory (the peak is read
//! from another process, see `TaskSheets/G1-T15-dtm.md`).
//!
//! ```text
//! cargo run -p pcv-convert --release --example dtm_bench -- \
//!     <input.copc.laz> <out_dir> <cloth_resolution> <cell_size> [standard|steep] [both|geotiff|landxml]
//! ```
//!
//! Lengths are in the file's unit. The time of each phase is read from the progress fraction (per mille):
//! 0..250 pass 1, 250..550 simulation, 550..900 pass 2 and the writer, 950 the TIN and the files.

use std::path::PathBuf;
use std::time::Instant;

use copc_core::NeverCancel;
use pcv_convert::dtm::{dtm_path, DtmOutputs};
use pcv_core::dtm::{DtmOutputOptions, DtmRequest, LandXmlUnit};
use pcv_core::raster::TiffKind;
use pcv_core::section_line::CsfParamsInput;

fn main() -> Result<(), String> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 5 {
        return Err("usage: <input> <out_dir> <cloth_resolution> <cell_size> [standard|steep] [both|geotiff|landxml]".to_string());
    }
    let source = PathBuf::from(&args[1]);
    let out_dir = PathBuf::from(&args[2]);
    let cloth: f64 = args[3].parse().map_err(|e| format!("cloth: {e}"))?;
    let cell: f64 = args[4].parse().map_err(|e| format!("cell: {e}"))?;
    let steep = args.get(5).is_some_and(|p| p == "steep");
    let which = args.get(6).map_or("both", String::as_str);
    std::fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;

    let csf = CsfParamsInput {
        cloth_resolution: cloth,
        rigidness: if steep { 1 } else { 3 },
        time_step: 0.65,
        class_threshold_upper: 0.1,
        class_threshold_lower: 1.0,
        iterations: if steep { 1500 } else { 500 },
        slope_smooth: true,
        hdiff: 0.3,
        convergence_threshold: 0.005,
    };
    let request = DtmRequest {
        csf,
        cell_size: cell,
        output: DtmOutputOptions {
            geotiff: which != "landxml",
            landxml: which != "geotiff",
            tiff: TiffKind::Values,
            unit: LandXmlUnit::Meter,
        },
        display_unit: None,
    };
    let outputs = DtmOutputs {
        copc: out_dir.join("dtm.copc.laz"),
        geotiff: out_dir.join("dtm.tif"),
        landxml: out_dir.join("dtm.xml"),
    };
    let spill = out_dir.join("spill");
    std::fs::create_dir_all(&spill).map_err(|e| e.to_string())?;

    let start = Instant::now();
    let mut marks: Vec<(u64, f64)> = Vec::new();
    let mut next_mark = [250u64, 550, 900, 950].into_iter();
    let mut want = next_mark.next();
    let summary = dtm_path(
        &source,
        request,
        // Measuring: no practical cap here, the point is to see how far a run goes.
        u64::MAX / 2,
        u64::MAX / 2,
        &outputs,
        &spill,
        0,
        &NeverCancel,
        |p| {
            if let Some(m) = want {
                if p.points_read >= m {
                    marks.push((m, start.elapsed().as_secs_f64()));
                    want = next_mark.next();
                }
            }
        },
    )
    .map_err(|e| e.to_string())?;
    let total = start.elapsed().as_secs_f64();
    for (m, t) in &marks {
        println!("reached {m} per mille at {t:.1} s");
    }
    println!("total {total:.1} s");
    println!(
        "{} points, {} ground, grid {} x {} cells of {}, TIN {} points / {} triangles",
        summary.point_count,
        summary.ground_points,
        summary.width,
        summary.height,
        summary.cell_size,
        summary.tin_points,
        summary.tin_triangles
    );
    let a = summary.agreement;
    println!(
        "agreement with the source: both {} csf-only {} source-only {} neither {}; precision {:?} recall {:?}",
        a.both,
        a.csf_only,
        a.source_only,
        a.neither,
        a.precision(),
        a.recall()
    );
    for w in &summary.warnings {
        println!("warning: {w}");
    }
    for path in [&outputs.copc, &outputs.geotiff, &outputs.landxml] {
        if let Ok(meta) = std::fs::metadata(path) {
            println!("{}: {} bytes", path.display(), meta.len());
        }
    }
    Ok(())
}
