//! Diagnosis of the section line (G2-4): dumps, for a stretch of the line, the line samples, the section points near the
//! line, the ground points the TIN used, the cloth height, and the TIN triangle at the highest sample. Writes a JSON
//! file and a text table; a script draws the picture.
//!
//! ```text
//! cargo run --release -p pcv-convert --example section_line_diag -- <file> ax ay az bx by bz <preset> <half_width> <resolution> <s_min> <s_max> <out_prefix>
//! ```
//! Lengths are in the file's unit. `up` is +Z. Nothing in the algorithm is changed by this example.

use std::fmt::Write as _;
use std::path::Path;

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
    let path = args.get(1).ok_or("usage: see the file header")?;
    let mut file = CopcFile::open(Path::new(path)).map_err(|e| e.to_string())?;
    let a = [number(&args, 2)?, number(&args, 3)?, number(&args, 4)?];
    let b = [number(&args, 5)?, number(&args, 6)?, number(&args, 7)?];
    let preset = args.get(8).map_or("standard", String::as_str);
    let half_width = number(&args, 9)?;
    let resolution = number(&args, 10)?;
    let (s_min, s_max) = (number(&args, 11)?, number(&args, 12)?);
    let prefix = args.get(13).ok_or("out_prefix is missing")?;
    // Metres per file unit (default 1). The CSF heights are given in metres (as the app does), so they are divided by it.
    let k = if args.len() > 14 {
        number(&args, 14)?
    } else {
        1.0
    };
    // Optional 16th argument: metres per file unit used for the thresholds only (1 reproduces the app before the
    // units fix, where the metre values were sent as they were).
    let threshold_k = if args.len() > 15 {
        number(&args, 15)?
    } else {
        k
    };

    let csf = match preset {
        "steep" => CsfParams::steep(),
        _ => CsfParams::standard(),
    };
    let params = SectionLineParams {
        corridor_half_width: half_width,
        csf: CsfParams {
            cloth_resolution: resolution,
            class_threshold_upper: (f64::from(csf.class_threshold_upper) / threshold_k) as f32,
            class_threshold_lower: (f64::from(csf.class_threshold_lower) / threshold_k) as f32,
            hdiff: (f64::from(csf.hdiff) / threshold_k) as f32,
            convergence_threshold: (f64::from(csf.convergence_threshold) / threshold_k) as f32,
            ..csf
        },
        max_cells: 4_000_000,
    };
    let line = SectionLine {
        a,
        b,
        up: [0.0, 0.0, 1.0],
    };
    let mut job = SectionLineJob::new(&file, &line, &params).map_err(|e| e.to_string())?;
    while !job.advance(&mut file).map_err(|e| e.to_string())?.done {}
    let vertices = job.debug_vertices();

    // Line samples (decode the result buffer).
    let mut samples: Vec<(f64, f64)> = Vec::new();
    // The triangle needs the job, so ask for it after the line is known: `finish` consumes the job, so find the
    // spike from a second job-free pass: sample the TIN through `debug_triangle_at` is not enough, so run `finish`
    // on a clone-free path by computing the line first from a fresh job.
    let mut job2 = SectionLineJob::new(&file, &line, &params).map_err(|e| e.to_string())?;
    while !job2.advance(&mut file).map_err(|e| e.to_string())?.done {}
    let bytes = job2.finish().map_err(|e| e.to_string())?;
    let count = u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize;
    for i in 0..count {
        let o = 16 + i * 8;
        let s = f32::from_le_bytes([bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]]);
        let z = f32::from_le_bytes([bytes[o + 4], bytes[o + 5], bytes[o + 6], bytes[o + 7]]);
        samples.push((f64::from(s), f64::from(z)));
    }
    let in_range: Vec<(f64, f64)> = samples
        .iter()
        .copied()
        .filter(|(s, _)| *s >= s_min && *s <= s_max)
        .collect();
    let spike = in_range
        .iter()
        .copied()
        .max_by(|x, y| x.1.total_cmp(&y.1))
        .ok_or("no samples in the range")?;

    // Table.
    let mut table = String::new();
    let _ = writeln!(
        table,
        "# s z cloth_z (file units, absolute z); preset {preset}"
    );
    for (s, z) in &in_range {
        let _ = writeln!(
            table,
            "{:.2} {:.3} {:.3}",
            s * k,
            z * k,
            job.debug_cloth_height(*s, 0.0) * k
        );
    }
    std::fs::write(format!("{prefix}-line.txt"), table).map_err(|e| e.to_string())?;

    // Triangle at the spike (and the three samples before it if the spike is on an edge).
    let triangle = job.debug_triangle_at(spike.0, 0.0);

    // Section points within 1 unit of the line, in the s range.
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let len = dx.hypot(dy);
    let along = [dx / len, dy / len];
    let lateral = [-along[1], along[0]]; // up x along = (-ay, ax) for up = +Z
    let corridor = pcv_core::extract::ExtractFilter::OrientedBox(pcv_core::extract::OrientedBox {
        center: [
            a[0] + along[0] * (s_min + s_max) / 2.0,
            a[1] + along[1] * (s_min + s_max) / 2.0,
            0.0,
        ],
        axes: [
            [along[0], along[1], 0.0],
            [lateral[0], lateral[1], 0.0],
            [0.0, 0.0, 1.0],
        ],
        half_extents: [(s_max - s_min) / 2.0 + 1.0, 1.0, 1.0e6],
    });
    let keys: Vec<_> = file
        .hierarchy()
        .nodes()
        .filter(|n| corridor.may_intersect(n.bounds_min, n.bounds_max))
        .map(|n| n.key)
        .collect();
    let mut near: Vec<[f64; 4]> = Vec::new();
    for key in keys {
        for p in file.read_node_points(key).map_err(|e| e.to_string())? {
            // The box is centred at z = 0 with a huge z extent, so this tests s and t only.
            if corridor.contains([p.x, p.y, 0.0]) {
                let (px, py) = (p.x - a[0], p.y - a[1]);
                let s = px * along[0] + py * along[1];
                let t = px * lateral[0] + py * lateral[1];
                near.push([s, t, p.z, f64::from(p.classification)]);
            }
        }
    }
    near.retain(|p| p[0] >= s_min && p[0] <= s_max && p[1].abs() <= 1.0);

    let ground: Vec<&pcv_core::section_line::DebugVertex> = vertices
        .iter()
        .filter(|v| v.s >= s_min - 5.0 && v.s <= s_max + 5.0)
        .collect();

    let mut json = String::new();
    let v3 = |v: &pcv_core::section_line::DebugVertex| {
        format!(
            "[{:.3},{:.3},{:.3},{:.3},{}]",
            v.s, v.t, v.z, v.cloth_z, v.is_ground
        )
    };
    let _ = write!(
        json,
        "{{\"preset\":\"{preset}\",\"unit\":{k},\"sMin\":{s_min},\"sMax\":{s_max},"
    );
    let _ = write!(json, "\"spike\":[{:.3},{:.3}],", spike.0, spike.1);
    let _ = write!(
        json,
        "\"line\":[{}],",
        in_range
            .iter()
            .map(|(s, z)| format!("[{s:.3},{z:.3},{:.3}]", job.debug_cloth_height(*s, 0.0)))
            .collect::<Vec<_>>()
            .join(",")
    );
    let _ = write!(
        json,
        "\"near\":[{}],",
        near.iter()
            .map(|p| format!("[{:.3},{:.3},{:.3},{}]", p[0], p[1], p[2], p[3]))
            .collect::<Vec<_>>()
            .join(",")
    );
    let _ = write!(
        json,
        "\"ground\":[{}],",
        ground.iter().map(|v| v3(v)).collect::<Vec<_>>().join(",")
    );
    let _ = write!(
        json,
        "\"triangle\":{}",
        triangle.map_or("null".to_string(), |t| format!(
            "[{}]",
            t.iter().map(v3).collect::<Vec<_>>().join(",")
        ))
    );
    json.push('}');
    std::fs::write(format!("{prefix}.json"), json).map_err(|e| e.to_string())?;

    println!("spike s={:.2} z={:.3}", spike.0, spike.1);
    println!(
        "ground points in view {}, section points near {}",
        ground.len(),
        near.len()
    );
    match triangle {
        Some(t) => {
            for v in t {
                println!(
                    "vertex s={:.3} t={:.3} z={:.3} cloth_z={:.3} is_ground={}",
                    v.s, v.t, v.z, v.cloth_z, v.is_ground
                );
            }
        }
        None => println!("no triangle (spike sample on an edge or vertex)"),
    }
    Ok(())
}
