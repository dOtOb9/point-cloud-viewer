use std::io::{Read, Seek};

use copc_core::LasPointRecord;
use copc_reader::CopcReader;

use crate::extract::ExtractPoints;
use crate::raster::color::CellColorizer;
use crate::raster::{CellAccumulator, ClassFilter, GridSpec, RasterError, RasterValue};

pub const PREVIEW_MAX_SIDE: u32 = 1024;

pub const PREVIEW_POINT_BUDGET: u64 = 3_000_000;

pub const PREVIEW_HEADER_BYTES: usize = 32;

#[derive(Debug, Clone, Copy)]
struct CoarsePoint {
    x: f64,
    y: f64,
    z: f32,
    intensity: u16,
    class: u8,
    rgb: [u16; 3],
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct XyBounds {
    pub min_x: f64,
    pub min_y: f64,
    pub max_x: f64,
    pub max_y: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewOptions {
    pub cell_size: f64,
    pub value: RasterValue,
    pub ground_only: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewOpenInfo {
    pub held_points: u64,
    pub depth: i32,
    pub truncated: bool,
}

pub struct CoarsePoints {
    points: Vec<CoarsePoint>,
    cap: usize,
    bounds: XyBounds,
    has_color: bool,
    depth: i32,
    truncated: bool,
}

impl CoarsePoints {
    pub fn new(bounds: XyBounds, has_color: bool, cap: usize, expected: usize) -> Self {
        Self {
            points: Vec::with_capacity(expected.min(cap)),
            cap,
            bounds,
            has_color,
            depth: 0,
            truncated: false,
        }
    }

    pub fn push(&mut self, p: &LasPointRecord) -> bool {
        if self.points.len() >= self.cap {
            self.truncated = true;
            return false;
        }
        self.points.push(CoarsePoint {
            x: p.x,
            y: p.y,
            z: p.z as f32,
            intensity: p.intensity,
            class: p.classification,
            rgb: [p.red, p.green, p.blue],
        });
        true
    }

    pub fn len(&self) -> usize {
        self.points.len()
    }

    pub fn is_empty(&self) -> bool {
        self.points.is_empty()
    }

    pub fn is_truncated(&self) -> bool {
        self.truncated
    }

    pub fn bytes_held(&self) -> usize {
        self.points.capacity() * std::mem::size_of::<CoarsePoint>()
    }

    pub fn open_info(&self) -> PreviewOpenInfo {
        PreviewOpenInfo {
            held_points: self.points.len() as u64,
            depth: self.depth,
            truncated: self.truncated,
        }
    }

    pub fn preview_spec(&self, cell_size: f64) -> Result<GridSpec, RasterError> {
        let b = &self.bounds;
        let long_side = (b.max_x - b.min_x).max(b.max_y - b.min_y);
        let coarsest_needed = if long_side.is_finite() && long_side > 0.0 {
            long_side / f64::from(PREVIEW_MAX_SIDE)
        } else {
            0.0
        };
        let cell = if cell_size.is_finite() {
            cell_size.max(coarsest_needed)
        } else {
            cell_size
        };
        let side = u64::from(PREVIEW_MAX_SIDE) + 2;
        GridSpec::from_bounds(b.min_x, b.min_y, b.max_x, b.max_y, cell, side * side)
    }

    pub fn render(&self, options: &PreviewOptions) -> Result<PreviewImage, RasterError> {
        if options.value == RasterValue::RgbMean && !self.has_color {
            return Err(RasterError::NoColor);
        }
        let ground_only = options.ground_only;
        let classes = if ground_only {
            ClassFilter::only(&[2])
        } else {
            ClassFilter::all()
        };
        let spec = self.preview_spec(options.cell_size)?;
        let mut acc = CellAccumulator::new(spec, options.value, classes);
        for p in &self.points {
            acc.add(p.x, p.y, f64::from(p.z), p.intensity, p.class, p.rgb);
        }
        if acc.accepted_points() == 0 {
            return Err(RasterError::NoPoints);
        }
        let colorizer = CellColorizer::new(&acc, None);
        let (width, height) = (spec.width as usize, spec.height as usize);
        let cell_count = spec.cell_count() as usize;
        let pixels: Vec<[u8; 4]> = if options.value == RasterValue::RgbMean {
            let cells: Vec<Option<[u16; 3]>> = (0..cell_count).map(|i| acc.rgb_at(i)).collect();
            fill_isolated_holes(&cells, width, height, mean_rgb)
                .into_iter()
                .map(|c| colorizer.rgba_of_rgb(c))
                .collect()
        } else {
            let cells: Vec<Option<f32>> = (0..cell_count).map(|i| acc.value_at(i)).collect();
            fill_isolated_holes(&cells, width, height, mean_value)
                .into_iter()
                .map(|c| colorizer.rgba_of_value(c))
                .collect()
        };
        let mut rgba = Vec::with_capacity(cell_count * 4);
        let mut filled = 0u32;
        for pixel in pixels {
            if pixel[3] != 0 {
                filled += 1;
            }
            rgba.extend_from_slice(&pixel);
        }
        Ok(PreviewImage {
            width: spec.width,
            height: spec.height,
            range: colorizer.range(),
            cell_size: spec.cell_size,
            points: acc.accepted_points(),
            filled_cells: filled,
            rgba,
        })
    }
}

pub const FILL_MIN_NEIGHBOURS: usize = 5;

pub fn fill_isolated_holes<T: Copy>(
    cells: &[Option<T>],
    width: usize,
    height: usize,
    mean: impl Fn(&[T]) -> T,
) -> Vec<Option<T>> {
    let mut out = cells.to_vec();
    if width == 0 || height == 0 || cells.len() != width * height {
        return out;
    }
    for row in 0..height {
        for col in 0..width {
            let index = row * width + col;
            if cells[index].is_some() {
                continue;
            }
            let mut found: Vec<T> = Vec::with_capacity(8);
            for r in row.saturating_sub(1)..=(row + 1).min(height - 1) {
                for c in col.saturating_sub(1)..=(col + 1).min(width - 1) {
                    if (r, c) == (row, col) {
                        continue;
                    }
                    if let Some(v) = cells[r * width + c] {
                        found.push(v);
                    }
                }
            }
            if found.len() >= FILL_MIN_NEIGHBOURS {
                out[index] = Some(mean(&found));
            }
        }
    }
    out
}

fn mean_value(values: &[f32]) -> f32 {
    values.iter().sum::<f32>() / values.len() as f32
}

fn mean_rgb(colors: &[[u16; 3]]) -> [u16; 3] {
    let n = colors.len() as u32;
    let channel = |k: usize| -> u16 {
        let sum: u32 = colors.iter().map(|c| u32::from(c[k])).sum();
        ((sum + n / 2) / n) as u16
    };
    [channel(0), channel(1), channel(2)]
}

#[derive(Debug, Clone, PartialEq)]
pub struct PreviewImage {
    pub width: u32,
    pub height: u32,
    pub range: Option<(f32, f32)>,
    pub cell_size: f64,
    pub points: u64,
    pub filled_cells: u32,
    pub rgba: Vec<u8>,
}

impl PreviewImage {
    pub fn to_bytes(&self) -> Vec<u8> {
        let (lo, hi) = self.range.unwrap_or((0.0, 0.0));
        let mut out = Vec::with_capacity(PREVIEW_HEADER_BYTES + self.rgba.len());
        out.extend_from_slice(&self.width.to_le_bytes());
        out.extend_from_slice(&self.height.to_le_bytes());
        out.extend_from_slice(&u32::from(self.range.is_some()).to_le_bytes());
        out.extend_from_slice(&lo.to_le_bytes());
        out.extend_from_slice(&hi.to_le_bytes());
        out.extend_from_slice(&(self.cell_size as f32).to_le_bytes());
        out.extend_from_slice(&u32::try_from(self.points).unwrap_or(u32::MAX).to_le_bytes());
        out.extend_from_slice(&self.filled_cells.to_le_bytes());
        out.extend_from_slice(&self.rgba);
        out
    }
}

pub struct CoarseReader<R: Read + Seek + Send> {
    points: ExtractPoints<'static, R>,
    store: CoarsePoints,
}

impl<R: Read + Seek + Send> CoarseReader<R> {
    pub fn new(reader: CopcReader<R>, bounds: XyBounds, has_color: bool, cap: usize) -> Self {
        let points = ExtractPoints::coarse(reader, cap as u64);
        let expected = usize::try_from(points.stats().candidate_points).unwrap_or(usize::MAX);
        let mut store = CoarsePoints::new(bounds, has_color, cap, expected);
        store.depth = points.depth_limit().unwrap_or(0);
        Self { points, store }
    }

    pub fn feed(&mut self, batch: usize) -> Result<bool, copc_core::Error> {
        for _ in 0..batch {
            match self.points.next() {
                Some(record) => {
                    if !self.store.push(&record?) {
                        return Ok(true);
                    }
                }
                None => return Ok(true),
            }
        }
        Ok(false)
    }

    pub fn progress(&self) -> (u64, u64) {
        let stats = self.points.stats();
        (stats.points_scanned, stats.candidate_points)
    }

    pub fn finish(self) -> CoarsePoints {
        self.store
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
                    intensity: 10,
                    classification: if i % 2 == 0 { 2 } else { 1 },
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

    fn bounds(side: u32) -> XyBounds {
        XyBounds {
            min_x: 0.0,
            min_y: 0.0,
            max_x: f64::from(side - 1),
            max_y: f64::from(side - 1),
        }
    }

    fn read_all(path: &std::path::Path, side: u32, cap: usize) -> (CoarsePoints, u64) {
        let reader = CopcReader::from_path(path).expect("open");
        let mut r = CoarseReader::new(reader, bounds(side), false, cap);
        let candidates = r.progress().1;
        while !r.feed(100).expect("feed") {}
        (r.finish(), candidates)
    }

    #[test]
    fn depth_limit_skips_deeper_nodes() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = make_copc(dir.path(), 60, 200);
        let deepest = {
            let reader = CopcReader::from_path(&path).expect("open");
            reader
                .file()
                .hierarchy_entries()
                .filter(|e| e.has_point_data())
                .map(|e| e.key.level)
                .max()
                .expect("nodes")
        };
        assert!(deepest >= 2, "the test needs a deep file: {deepest}");

        let reader = CopcReader::from_path(&path).expect("open");
        let all_nodes = ExtractPoints::all(reader).stats().nodes_total;
        let reader = CopcReader::from_path(&path).expect("open");
        let mut it = ExtractPoints::coarse(reader, 1000);
        let depth = it.depth_limit().expect("depth");
        assert!(depth < deepest, "depth {depth} of {deepest}");
        let mut n = 0u64;
        for record in it.by_ref() {
            record.expect("point");
            n += 1;
        }
        let stats = it.stats();
        assert!(stats.nodes_read < all_nodes, "{stats:?} of {all_nodes}");
        assert_eq!(stats.nodes_read, stats.nodes_selected);
        assert_eq!(n, stats.candidate_points);
        assert!(n <= 1000, "{n}");
        let (store, candidates) = read_all(&path, 60, 1000);
        assert_eq!(store.depth, depth);
        assert_eq!(candidates, n);
        assert_eq!(store.len() as u64, n);
    }

    #[test]
    fn a_larger_budget_reads_more_levels() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = make_copc(dir.path(), 60, 200);
        let small = ExtractPoints::coarse(CopcReader::from_path(&path).expect("open"), 300);
        let large = ExtractPoints::coarse(CopcReader::from_path(&path).expect("open"), 1_000_000);
        assert!(small.depth_limit() < large.depth_limit());
        assert_eq!(large.stats().candidate_points, 3600);
    }

    #[test]
    fn held_points_never_exceed_the_cap() {
        let dir = tempfile::tempdir().expect("tempdir");
        const POINTS_PER_NODE: u32 = 200;
        const CAP_SMALLER_THAN_THE_ROOT_NODE: usize = 50;
        const CAP_THE_UPPER_LEVELS_FIT_IN: usize = 1000;
        let path = make_copc(dir.path(), 60, POINTS_PER_NODE);
        let (store, _) = read_all(&path, 60, CAP_SMALLER_THAN_THE_ROOT_NODE);
        assert_eq!(store.len(), CAP_SMALLER_THAN_THE_ROOT_NODE);
        assert!(store.is_truncated());
        assert!(
            store.bytes_held()
                <= CAP_SMALLER_THAN_THE_ROOT_NODE * std::mem::size_of::<CoarsePoint>()
        );
        let (store, _) = read_all(&path, 60, CAP_THE_UPPER_LEVELS_FIT_IN);
        assert!(store.len() <= CAP_THE_UPPER_LEVELS_FIT_IN);
        assert!(!store.is_truncated());
        assert!(
            store.bytes_held() <= CAP_THE_UPPER_LEVELS_FIT_IN * std::mem::size_of::<CoarsePoint>()
        );
    }

    #[test]
    fn push_refuses_past_the_cap_and_keeps_memory_flat() {
        let mut store = CoarsePoints::new(bounds(10), false, 100, 0);
        let p = LasPointRecord::default();
        for _ in 0..10_000 {
            store.push(&p);
        }
        assert_eq!(store.len(), 100);
        assert!(store.is_truncated());
        assert!(store.bytes_held() <= 128 * std::mem::size_of::<CoarsePoint>());
    }

    #[test]
    fn render_switches_value_and_class_without_reading_again() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = make_copc(dir.path(), 40, 100);
        let (store, _) = read_all(&path, 40, 1_000_000);
        assert_eq!(store.len(), 1600);
        let options = |value, ground_only| PreviewOptions {
            cell_size: 4.0,
            value,
            ground_only,
        };
        let z = store
            .render(&options(RasterValue::ZMean, false))
            .expect("z");
        assert_eq!((z.width, z.height), (10, 10));
        assert_eq!(z.points, 1600);
        assert_eq!(z.rgba.len(), 10 * 10 * 4);
        assert!(z.range.is_some());
        let (lo, hi) = z.range.expect("range");
        assert!(lo < hi);
        let count = store
            .render(&options(RasterValue::Count, false))
            .expect("count");
        assert_eq!(count.range, Some((16.0, 16.0)));
        let ground = store
            .render(&options(RasterValue::Count, true))
            .expect("ground");
        assert_eq!(ground.points, 800, "x even is ground: half the points");
    }

    #[test]
    fn the_preview_grid_is_at_most_about_1024_cells_wide() {
        let store = CoarsePoints::new(
            XyBounds {
                min_x: 0.0,
                min_y: 0.0,
                max_x: 3200.0,
                max_y: 2400.0,
            },
            false,
            10,
            0,
        );
        let spec = store.preview_spec(0.5).expect("spec");
        assert!(spec.width <= PREVIEW_MAX_SIDE + 1 && spec.height <= PREVIEW_MAX_SIDE + 1);
        let spec = store.preview_spec(100.0).expect("spec");
        assert_eq!(spec.cell_size, 100.0);
        assert_eq!((spec.width, spec.height), (32, 24));
    }

    #[test]
    fn rgb_without_colour_and_empty_selection_are_japanese_errors() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = make_copc(dir.path(), 20, 100);
        let (store, _) = read_all(&path, 20, 1_000_000);
        let rgb = PreviewOptions {
            cell_size: 1.0,
            value: RasterValue::RgbMean,
            ground_only: false,
        };
        assert!(store
            .render(&rgb)
            .expect_err("no colour")
            .to_string()
            .contains("色"));
        let mut none = CoarsePoints::new(bounds(20), false, 10, 0);
        let p = LasPointRecord {
            classification: 1,
            ..Default::default()
        };
        none.push(&p);
        let ground = PreviewOptions {
            cell_size: 1.0,
            value: RasterValue::Count,
            ground_only: true,
        };
        assert!(none
            .render(&ground)
            .expect_err("no ground")
            .to_string()
            .contains("点がありません"));
    }

    #[test]
    fn to_bytes_has_the_documented_layout() {
        let image = PreviewImage {
            width: 2,
            height: 1,
            range: Some((1.5, 9.0)),
            cell_size: 2.0,
            points: 7,
            filled_cells: 1,
            rgba: vec![1, 2, 3, 255, 0, 0, 0, 0],
        };
        let b = image.to_bytes();
        assert_eq!(b.len(), PREVIEW_HEADER_BYTES + 8);
        let u32_at = |o: usize| u32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]]);
        let f32_at = |o: usize| f32::from_bits(u32_at(o));
        assert_eq!((u32_at(0), u32_at(4), u32_at(8)), (2, 1, 1));
        assert_eq!((f32_at(12), f32_at(16), f32_at(20)), (1.5, 9.0, 2.0));
        assert_eq!((u32_at(24), u32_at(28)), (7, 1));
        assert_eq!(&b[32..], &[1, 2, 3, 255, 0, 0, 0, 0]);
    }

    #[test]
    fn isolated_hole_gets_the_mean_of_its_eight_neighbours() {
        let mut cells = vec![Some(8.0f32); 9];
        cells[4] = None;
        cells[0] = Some(0.0);
        let out = fill_isolated_holes(&cells, 3, 3, mean_value);
        assert_eq!(out[4], Some(7.0));
    }

    #[test]
    fn four_neighbours_are_not_enough_but_five_are() {
        let four = [
            Some(1.0f32),
            Some(1.0),
            None,
            Some(1.0),
            None,
            None,
            Some(1.0),
            None,
            None,
        ];
        assert_eq!(fill_isolated_holes(&four, 3, 3, mean_value)[4], None);
        let five = [
            Some(2.0f32),
            Some(4.0),
            None,
            Some(6.0),
            None,
            None,
            Some(8.0),
            Some(10.0),
            None,
        ];
        assert_eq!(fill_isolated_holes(&five, 3, 3, mean_value)[4], Some(6.0));
    }

    #[test]
    fn edge_cells_count_only_existing_neighbours_and_corners_never_fill() {
        let mut cells = vec![Some(3.0f32); 12];
        cells[1] = None;
        assert_eq!(fill_isolated_holes(&cells, 4, 3, mean_value)[1], Some(3.0));
        cells[2] = None;
        assert_eq!(fill_isolated_holes(&cells, 4, 3, mean_value)[1], None);
        let mut cells = vec![Some(3.0f32); 12];
        cells[0] = None;
        assert_eq!(fill_isolated_holes(&cells, 4, 3, mean_value)[0], None);
    }

    #[test]
    fn the_fill_does_not_chain() {
        let mut cells = vec![Some(1.0f32); 15];
        for i in [6, 7, 0, 1, 5, 10, 11] {
            cells[i] = None;
        }
        let out = fill_isolated_holes(&cells, 5, 3, mean_value);
        assert_eq!(out[7], Some(1.0));
        assert_eq!(out[6], None);
        let mut cells = vec![Some(1.0f32); 15];
        for i in [6, 7, 0, 1, 5] {
            cells[i] = None;
        }
        let out = fill_isolated_holes(&cells, 5, 3, mean_value);
        assert_eq!(out[7], Some(1.0));
        assert_eq!(out[6], None);
    }

    #[test]
    fn rgb_mean_is_per_channel() {
        let mut cells = vec![Some([10u16, 20, 30]); 9];
        cells[4] = None;
        cells[0] = Some([90, 20, 30]);
        let out = fill_isolated_holes(&cells, 3, 3, mean_rgb);
        assert_eq!(out[4], Some([20, 20, 30]));
    }

    #[test]
    fn export_colouring_leaves_holes_empty_while_the_preview_fills_them() {
        let spec = GridSpec::from_bounds(0.0, 0.0, 3.0, 3.0, 1.0, 100).expect("spec");
        let mut acc = CellAccumulator::new(spec, RasterValue::ZMean, ClassFilter::all());
        for row in 0..3 {
            for col in 0..3 {
                if (row, col) != (1, 1) {
                    acc.add(
                        f64::from(col) + 0.5,
                        f64::from(row) + 0.5,
                        5.0,
                        0,
                        1,
                        [0; 3],
                    );
                }
            }
        }
        let colorizer = CellColorizer::new(&acc, None);
        assert_eq!(colorizer.rgba(&acc, 4)[3], 0);
        let cells: Vec<Option<f32>> = (0..9).map(|i| acc.value_at(i)).collect();
        assert_eq!(fill_isolated_holes(&cells, 3, 3, mean_value)[4], Some(5.0));
    }
}
