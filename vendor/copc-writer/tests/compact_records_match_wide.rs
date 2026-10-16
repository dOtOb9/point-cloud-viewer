//! L3-C: spill records with i32 coordinates give the same COPC file, byte
//! for byte, as spill records with f64 coordinates (the layout used before
//! L3-C, quantized only when a node is encoded).
//!
//! The points sit on the output grid, as the points of a LAS file do. Then the
//! octant of every point is the same whether it is decided from the f64
//! coordinate or from the stored integer. (A point that is off the grid and
//! lies within half a step of a boundary between two octants can land in the
//! other octant; the module comment of `record.rs` says so.)

#![cfg(feature = "native-fs")]

use std::path::Path;

use copc_core::{LasPointRecord, NeverCancel, StreamingLayout};
use copc_writer::{
    write_copc_from_spill_with_fs, CopcWriteMetadata, CopcWriterParams, LasTransform,
    NativeScratchFs, SpillWriter,
};

const TRANSFORM: LasTransform = LasTransform {
    scale: (0.01, 0.01, 0.001),
    offset: (1000.0, -2000.0, 5.0),
};

fn snap(value: f64, scale: f64, offset: f64) -> f64 {
    ((value - offset) / scale).round() * scale + offset
}

fn record(seed: u32) -> LasPointRecord {
    let f = f64::from(seed);
    LasPointRecord {
        x: snap(1000.0 + (f * 1.37) % 300.0, 0.01, 1000.0),
        y: snap(-2000.0 + (f * 2.11) % 200.0, 0.01, -2000.0),
        z: snap(5.0 + (f * 0.37) % 40.0, 0.001, 5.0),
        intensity: (seed * 31) as u16,
        return_number: (seed % 5) as u8 + 1,
        number_of_returns: 5,
        classification: (seed % 19) as u8,
        scan_direction_flag: seed % 2 == 0,
        edge_of_flight_line: seed % 7 == 0,
        scan_angle: ((seed % 3000) as f32 - 1500.0) * 0.0123,
        user_data: (seed % 251) as u8,
        point_source_id: (seed % 60_000) as u16,
        synthetic: seed % 11 == 0,
        key_point: seed % 13 == 0,
        withheld: seed % 17 == 0,
        overlap: seed % 19 == 0,
        scan_channel: (seed % 4) as u8,
        gps_time: 3.0e8 + f * 0.01,
        red: (seed * 7) as u16,
        green: (seed * 11) as u16,
        blue: (seed * 13) as u16,
        extra_bytes: vec![(seed % 256) as u8, (seed % 97) as u8, 0xAB],
        ..LasPointRecord::default()
    }
}

fn convert(
    out: &Path,
    dir: &Path,
    layout: &StreamingLayout,
    compact: bool,
    memory_budget: u64,
    point_count: u32,
) {
    let fs = NativeScratchFs::new(dir);
    let mut spill = SpillWriter::create(&fs, layout.clone(), compact.then_some(TRANSFORM))
        .expect("SpillWriter::create");
    for seed in 0..point_count {
        spill.push(&record(seed)).expect("spill.push");
    }
    let spill = spill.finalize().expect("spill.finalize");
    let mut metadata = CopcWriteMetadata::default();
    metadata.scale = Some(TRANSFORM.scale);
    metadata.offset = Some(TRANSFORM.offset);
    metadata.creation_date = Some((1, 2020));
    write_copc_from_spill_with_fs(
        &fs,
        out,
        spill,
        &CopcWriterParams::new(400)
            .with_memory_budget_bytes(memory_budget)
            .with_max_concurrent_subtrees(1),
        &NeverCancel,
        &metadata,
    )
    .expect("write_copc_from_spill_with_fs");
}

#[test]
fn compact_and_wide_spills_give_identical_files() {
    let dir = tempfile::tempdir().expect("tempdir");
    for (has_color, has_gps) in [(true, true), (false, true), (true, false)] {
        let layout = StreamingLayout {
            point_format: 3,
            has_gps,
            has_color,
            has_nir: false,
            has_waveform: false,
            extra_bytes: 3,
            extra_bytes_descriptors: Vec::new(),
        };
        // A tiny budget splits several levels on disk; a large one finishes
        // the whole tree in memory.
        for memory_budget in [64 * 1024, 1 << 30] {
            let wide = dir.path().join("wide.copc.laz");
            let compact = dir.path().join("compact.copc.laz");
            convert(&wide, dir.path(), &layout, false, memory_budget, 30_000);
            convert(&compact, dir.path(), &layout, true, memory_budget, 30_000);
            let wide = std::fs::read(wide).expect("read wide output");
            let compact = std::fs::read(compact).expect("read compact output");
            assert_eq!(
                wide.len(),
                compact.len(),
                "color {has_color}, gps {has_gps}, budget {memory_budget}: size"
            );
            assert!(
                wide == compact,
                "color {has_color}, gps {has_gps}, budget {memory_budget}: bytes differ"
            );
        }
    }
}

#[test]
fn a_spill_written_with_another_transform_is_refused() {
    let dir = tempfile::tempdir().expect("tempdir");
    let layout = StreamingLayout {
        point_format: 3,
        has_gps: true,
        has_color: false,
        has_nir: false,
        has_waveform: false,
        extra_bytes: 3,
        extra_bytes_descriptors: Vec::new(),
    };
    let fs = NativeScratchFs::new(dir.path());
    let mut spill = SpillWriter::create(&fs, layout, Some(TRANSFORM)).expect("create");
    spill.push(&record(1)).expect("push");
    let spill = spill.finalize().expect("finalize");
    let mut metadata = CopcWriteMetadata::default();
    metadata.scale = Some((0.001, 0.001, 0.001));
    metadata.offset = Some(TRANSFORM.offset);
    let error = write_copc_from_spill_with_fs(
        &fs,
        &dir.path().join("out.copc.laz"),
        spill,
        &CopcWriterParams::new(400),
        &NeverCancel,
        &metadata,
    )
    .expect_err("a different scale must be refused");
    assert!(error.to_string().contains("LAS transform"), "{error}");
}
