//! Tests of `ExtractPoints::all` on small COPC files written on the spot (the
//! same approach as `copc_file_tests` in `copc.rs`; `copc-writer` is already a
//! dev-dependency of this crate, so these tests live here and not in `pcv-convert`).

use super::*;
use crate::raster::{CellAccumulator, ClassFilter, GridSpec, RasterValue};
use copc_writer::{
    write_source, CopcPointFields, CopcPointSource, CopcWriteMetadata, CopcWriterParams,
};

struct Source(Vec<CopcPointFields>);

impl CopcPointSource for Source {
    fn len(&self) -> usize {
        self.0.len()
    }
    fn xyz(&self, index: usize) -> copc_core::Result<(f64, f64, f64)> {
        let p = &self.0[index];
        Ok((p.x, p.y, p.z))
    }
    fn fields_into(&self, index: usize, out: &mut CopcPointFields) -> copc_core::Result<()> {
        out.clone_from(&self.0[index]);
        Ok(())
    }
}

/// `side * side` points on a 1 m lattice (x = i, y = j, z = i + j).
fn make_copc(dir: &std::path::Path, side: u32, max_points_per_node: u32) -> std::path::PathBuf {
    let mut points = Vec::new();
    for i in 0..side {
        for j in 0..side {
            points.push(CopcPointFields {
                x: f64::from(i),
                y: f64::from(j),
                z: f64::from(i + j),
                intensity: 100,
                classification: 2,
                ..Default::default()
            });
        }
    }
    let bounds = points.iter().fold(
        copc_core::Bounds::point(points[0].x, points[0].y, points[0].z),
        |mut b, p| {
            b.extend(p.x, p.y, p.z);
            b
        },
    );
    let path = dir.join("grid.copc.laz");
    write_source(
        &path,
        &Source(points),
        false,
        bounds,
        &CopcWriterParams::new(max_points_per_node),
        &CopcWriteMetadata::default(),
    )
    .expect("write test copc");
    path
}

#[test]
fn all_yields_exactly_the_header_point_count() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = make_copc(dir.path(), 40, 300); // 1600 points, many nodes
    let reader = CopcReader::from_path(&path).expect("open");
    let header_count = reader.file().header().number_of_points();
    assert_eq!(header_count, 1600);
    let mut iter = ExtractPoints::all(reader);
    let mut seen = std::collections::HashSet::new();
    for record in iter.by_ref() {
        let p = record.expect("point");
        // Each lattice point exactly once: levels hold disjoint points.
        assert!(seen.insert((p.x as i64, p.y as i64)), "duplicate point");
    }
    assert_eq!(seen.len() as u64, header_count);
    let stats = iter.stats();
    assert_eq!(stats.points_matched, header_count);
    assert_eq!(stats.points_scanned, header_count);
    assert_eq!(stats.candidate_points, header_count);
    assert_eq!(stats.nodes_read, stats.nodes_total);
}

/// The reader holds one node of points at a time, not all of them (same style as
/// `buffer_is_bounded_by_largest_node` in `crates/pcv-convert/src/extract.rs`).
#[test]
fn all_buffer_is_bounded_by_largest_node() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = make_copc(dir.path(), 60, 200); // 3600 points
    let reader = CopcReader::from_path(&path).expect("open");
    let largest_node = reader
        .file()
        .hierarchy_entries()
        .filter(|e| e.has_point_data())
        .map(|e| e.point_count)
        .max()
        .expect("nodes") as usize;
    let mut iter = ExtractPoints::all(reader);
    let mut n = 0u64;
    for record in iter.by_ref() {
        record.expect("point");
        n += 1;
    }
    let s = iter.stats();
    assert_eq!(n, 3600);
    assert!(s.nodes_read > 10, "enough nodes: {s:?}");
    assert_eq!(s.max_buffered_points, largest_node);
    assert!(s.max_buffered_points <= 200, "{s:?}");
    assert!(s.max_buffered_points * 10 < 3600);
}

/// The reader feeds the accumulator: the whole path from file to raster.
#[test]
fn all_points_feed_the_accumulator() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = make_copc(dir.path(), 10, 30); // x, y in 0..=9
    let reader = CopcReader::from_path(&path).expect("open");
    let spec = GridSpec::from_bounds(0.0, 0.0, 9.0, 9.0, 3.0, 100).expect("spec");
    let mut count = CellAccumulator::new(spec, RasterValue::Count, ClassFilter::all());
    for record in ExtractPoints::all(reader) {
        count.add_record(&record.expect("point"));
    }
    assert_eq!(count.accepted_points(), 100);
    let total: f32 = count.f32_samples(0.0).sum();
    assert_eq!(total, 100.0);
    // 3 x 3 cells of 3 m. South-west cell (x, y in 0..3) is the bottom-left pixel
    // (row 2, col 0 = index 6): 3 x 3 points.
    assert_eq!(count.value_at(6), Some(9.0));
    // North-east cell (row 0, col 2 = index 2) also takes the max edge: x, y in 6..=9.
    assert_eq!(count.value_at(2), Some(16.0));
}
