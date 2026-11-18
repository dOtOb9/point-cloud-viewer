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
    const SIDE_GIVING_1600_POINTS: u32 = 40;
    const NODE_SIZE_GIVING_MANY_NODES: u32 = 300;
    let path = make_copc(
        dir.path(),
        SIDE_GIVING_1600_POINTS,
        NODE_SIZE_GIVING_MANY_NODES,
    );
    let reader = CopcReader::from_path(&path).expect("open");
    let header_count = reader.file().header().number_of_points();
    assert_eq!(header_count, 1600);
    let mut iter = ExtractPoints::all(reader);
    let mut seen = std::collections::HashSet::new();
    for record in iter.by_ref() {
        let p = record.expect("point");
        assert!(seen.insert((p.x as i64, p.y as i64)), "duplicate point");
    }
    assert_eq!(seen.len() as u64, header_count);
    let stats = iter.stats();
    assert_eq!(stats.points_matched, header_count);
    assert_eq!(stats.points_scanned, header_count);
    assert_eq!(stats.candidate_points, header_count);
    assert_eq!(stats.nodes_read, stats.nodes_total);
}

#[test]
fn all_buffer_is_bounded_by_largest_node() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = make_copc(dir.path(), 60, 200);
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

#[test]
fn all_points_feed_the_accumulator() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = make_copc(dir.path(), 10, 30);
    let reader = CopcReader::from_path(&path).expect("open");
    let spec = GridSpec::from_bounds(0.0, 0.0, 9.0, 9.0, 3.0, 100).expect("spec");
    let mut count = CellAccumulator::new(spec, RasterValue::Count, ClassFilter::all());
    for record in ExtractPoints::all(reader) {
        count.add_record(&record.expect("point"));
    }
    assert_eq!(count.accepted_points(), 100);
    let total: f32 = count.f32_samples(0.0).sum();
    assert_eq!(total, 100.0);
    assert_eq!(count.value_at(6), Some(9.0));
    assert_eq!(count.value_at(2), Some(16.0));
}
