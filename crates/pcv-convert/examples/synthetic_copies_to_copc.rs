use std::path::{Path, PathBuf};
use std::time::Instant;

use copc_core::{LasPointRecord, NeverCancel};
use copc_writer::{
    write_streaming_with_cancel_and_timings, CopcWriterParams, IngestStageTimings,
    PostProcessStageTimings,
};
use pcv_convert::merge::{collect_input_paths, summarize_headers_with_options, MultiFileLasPoints};

const PITCH: f64 = 5000.0;

struct ShiftedCopies {
    paths: Vec<PathBuf>,
    declared_per_copy: u64,
    copies: u64,
    cols: u64,
    next_copy: u64,
    current: Option<MultiFileLasPoints>,
    dx: f64,
    dy: f64,
}

impl ShiftedCopies {
    fn new(paths: Vec<PathBuf>, declared_per_copy: u64, copies: u64) -> Self {
        let mut cols = 1u64;
        while cols * cols < copies {
            cols += 1;
        }
        Self {
            paths,
            declared_per_copy,
            copies,
            cols,
            next_copy: 0,
            current: None,
            dx: 0.0,
            dy: 0.0,
        }
    }
}

impl Iterator for ShiftedCopies {
    type Item = copc_core::Result<LasPointRecord>;

    fn next(&mut self) -> Option<Self::Item> {
        loop {
            if let Some(current) = self.current.as_mut() {
                match current.next() {
                    Some(Ok(mut record)) => {
                        record.x += self.dx;
                        record.y += self.dy;
                        return Some(Ok(record));
                    }
                    Some(Err(e)) => return Some(Err(e)),
                    None => self.current = None,
                }
            }
            if self.next_copy >= self.copies {
                return None;
            }
            let k = self.next_copy;
            self.next_copy += 1;
            self.dx = (k % self.cols) as f64 * PITCH;
            self.dy = (k / self.cols) as f64 * PITCH;
            println!(
                "copy {}/{} (shift {:.0}, {:.0})",
                k + 1,
                self.copies,
                self.dx,
                self.dy
            );
            self.current = Some(MultiFileLasPoints::new(
                self.paths.clone(),
                self.declared_per_copy,
            ));
        }
    }
}

fn main() {
    let raw_args: Vec<String> = std::env::args().skip(1).collect();
    let show_timings = raw_args.iter().any(|a| a == "--timings");
    let positional: Vec<&String> = raw_args.iter().filter(|a| !a.starts_with("--")).collect();
    let (Some(input), Some(output), Some(copies)) = (
        positional.first(),
        positional.get(1),
        positional.get(2).and_then(|s| s.parse::<u64>().ok()),
    ) else {
        eprintln!(
            "usage: synthetic_copies_to_copc <input dir or glob> <output.copc.laz> <copies> [spill_dir] [--timings]"
        );
        std::process::exit(2);
    };
    let spill_dir: PathBuf = positional
        .get(3)
        .map(|s| PathBuf::from(s.as_str()))
        .unwrap_or_else(std::env::temp_dir);

    if let Err(err) = run(
        input,
        Path::new(output.as_str()),
        copies,
        &spill_dir,
        show_timings,
    ) {
        eprintln!("failed: {err}");
        std::process::exit(1);
    }
}

fn run(
    input: &str,
    output: &Path,
    copies: u64,
    spill_dir: &Path,
    show_timings: bool,
) -> Result<(), String> {
    if copies == 0 {
        return Err("copies must be at least 1".to_string());
    }
    let paths = collect_input_paths(input).map_err(|e| e.to_string())?;
    let summary = summarize_headers_with_options(&paths, true).map_err(|e| e.to_string())?;
    let total = summary
        .declared_points_total
        .checked_mul(copies)
        .ok_or_else(|| "total point count overflows u64".to_string())?;
    println!("input files     : {}", paths.len());
    println!("points per copy : {}", summary.declared_points_total);
    println!("copies          : {copies}");
    println!("total points    : {total}");
    println!("output          : {}", output.display());
    println!("spill_dir       : {}", spill_dir.display());

    let params = CopcWriterParams::new(100_000);
    let points = ShiftedCopies::new(paths, summary.declared_points_total, copies);

    let mut ingest = IngestStageTimings::default();
    let mut post = PostProcessStageTimings::default();
    let t0 = Instant::now();
    let result = write_streaming_with_cancel_and_timings(
        output,
        summary.layout,
        points,
        &params,
        &summary.metadata,
        spill_dir,
        &NeverCancel,
        show_timings.then_some(&mut ingest),
        show_timings.then_some(&mut post),
    );
    let elapsed_s = t0.elapsed().as_secs_f64();

    match result {
        Ok(()) => {
            let output_bytes = std::fs::metadata(output).map(|m| m.len()).unwrap_or(0);
            println!("done            : {elapsed_s:.2} s");
            println!("output size     : {:.2} MB", output_bytes as f64 / 1e6);
            if show_timings {
                println!(
                    "TIMINGS read+decode={:.2}s spill_write={:.2}s lod_index={:.2}s node_compress={:.2}s header_etc={:.2}s",
                    ingest.source_read_and_decode.as_secs_f64(),
                    ingest.spill_write.as_secs_f64(),
                    post.lod_index_build.as_secs_f64(),
                    post.node_compression.as_secs_f64(),
                    post.header_and_hierarchy_write.as_secs_f64(),
                );
            }
            Ok(())
        }
        Err(err) => Err(format!("{err} (after {elapsed_s:.2} s)")),
    }
}
