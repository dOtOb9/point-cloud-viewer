//! G1-R1: the live preview of the Rasterize window.
//!
//! Reading every point takes minutes on a big cloud (Shibuya: about 3 minutes), so the
//! window cannot redo that on every click. Instead:
//!
//! 1. When the window opens, `CoarseReader` reads only the UPPER levels of the COPC
//!    octree (`ExtractPoints::coarse`: the deepest level whose total stays within the
//!    point budget) into a `CoarsePoints` store. The upper levels are a thinned copy
//!    of the whole cloud.
//! 2. The store is kept while the window is open (desktop: Tauri state, Web: the
//!    Worker). A click on value / class / cell size only calls `CoarsePoints::render`,
//!    which adds the held points into a small grid and colours it. No file is read.
//!
//! # Memory is bounded by the cap, not by the point count
//!
//! `CoarsePoints::push` refuses a point once `cap` points are held (`is_truncated`).
//! Each held point is `size_of::<CoarsePoint>()` bytes (32), so the store is at most
//! `cap * 32` bytes. The preview grid has at most about `PREVIEW_MAX_SIDE`^2 cells.
//! Tests: `held_points_never_exceed_the_cap`, `depth_limit_skips_deeper_nodes`.
//!
//! # What the preview is not
//!
//! It is an approximation made from thinned points: its min / max can be off, and thin
//! areas have empty cells. The window says so. The numbers it hands to the export are
//! only the colour range (`PreviewImage::range`).

use std::io::{Read, Seek};

use copc_core::LasPointRecord;
use copc_reader::CopcReader;

use crate::extract::ExtractPoints;
use crate::raster::color::CellColorizer;
use crate::raster::{CellAccumulator, ClassFilter, GridSpec, RasterError, RasterValue};

/// The longest side of the preview grid, in cells (the grid may be one cell larger
/// because the origin is snapped down to a multiple of the cell size).
pub const PREVIEW_MAX_SIDE: u32 = 1024;

/// How many points the preview store may hold. The upper COPC levels are read up to
/// this many (`ExtractPoints::coarse`). See `TaskSheets/G1-T11-raster-window.md` for how
/// the value was chosen (measured).
pub const PREVIEW_POINT_BUDGET: u64 = 3_000_000;

/// Bytes of the header in front of the pixels in `PreviewImage::to_bytes`.
pub const PREVIEW_HEADER_BYTES: usize = 32;

/// One held point: only what the accumulator needs. x / y stay f64 (map coordinates
/// can be large), z is f32 (a height needs no more).
#[derive(Debug, Clone, Copy)]
struct CoarsePoint {
    x: f64,
    y: f64,
    z: f32,
    intensity: u16,
    class: u8,
    rgb: [u16; 3],
}

/// The extent the preview covers (XY of the file header).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct XyBounds {
    pub min_x: f64,
    pub min_y: f64,
    pub max_x: f64,
    pub max_y: f64,
}

/// What the window asks for. Deserialised from the Tauri command / the Worker message.
#[derive(Debug, Clone, Copy, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewOptions {
    /// In the file's horizontal unit.
    pub cell_size: f64,
    pub value: RasterValue,
    pub ground_only: bool,
}

/// What the window learns when the store is ready.
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewOpenInfo {
    pub held_points: u64,
    /// The deepest COPC level that was read.
    pub depth: i32,
    /// The cap was reached before the selected levels were read completely.
    pub truncated: bool,
}

/// The thinned points kept while the window is open.
pub struct CoarsePoints {
    points: Vec<CoarsePoint>,
    cap: usize,
    bounds: XyBounds,
    has_color: bool,
    depth: i32,
    truncated: bool,
}

impl CoarsePoints {
    /// `expected` is how many points are about to come (reserves that much, at most
    /// `cap`, so a small cloud does not reserve the whole cap).
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

    /// Keeps the point; returns `false` (and keeps nothing) when `cap` points are held.
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

    /// Bytes the held points take (what the cap bounds).
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

    /// The grid the preview uses: the user's cell size, but never finer than
    /// `PREVIEW_MAX_SIDE` cells along the longer side of the extent.
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
            cell_size // from_bounds reports it
        };
        let side = u64::from(PREVIEW_MAX_SIDE) + 2;
        GridSpec::from_bounds(b.min_x, b.min_y, b.max_x, b.max_y, cell, side * side)
    }

    /// Adds the held points into the preview grid and colours it. Reads no file.
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
        let mut rgba = Vec::with_capacity(spec.cell_count() as usize * 4);
        let mut filled = 0u32;
        for pixel in colorizer.rgba_samples(&acc) {
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

/// A rendered preview: RGBA pixels (row 0 = north, transparent = empty cell) and what
/// the legend needs.
#[derive(Debug, Clone, PartialEq)]
pub struct PreviewImage {
    pub width: u32,
    pub height: u32,
    /// The colour range of the values (`None` for RGB). The export gets it back.
    pub range: Option<(f32, f32)>,
    /// The cell size the preview really used (it can be coarser than the one asked for).
    pub cell_size: f64,
    /// Held points that were added (after the class filter).
    pub points: u64,
    pub filled_cells: u32,
    pub rgba: Vec<u8>,
}

impl PreviewImage {
    /// One buffer for both sides to hand over (Tauri `Response`, Worker transfer). All
    /// numbers are little-endian; the pixels follow the 32-byte header.
    ///
    /// ```text
    ///  0 u32 width        4 u32 height      8 u32 flags (bit 0: range present)
    /// 12 f32 range min   16 f32 range max  20 f32 cell size (preview)
    /// 24 u32 points      28 u32 filled cells
    /// 32 .. width * height * 4 bytes of RGBA
    /// ```
    ///
    /// `src/datasource/raster-preview.ts` reads it.
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

/// Reads the upper levels of a COPC into a `CoarsePoints`, a batch of points at a time
/// (so the caller can report progress, check for cancel, or yield to the event loop).
pub struct CoarseReader<R: Read + Seek + Send> {
    points: ExtractPoints<'static, R>,
    store: CoarsePoints,
}

impl<R: Read + Seek + Send> CoarseReader<R> {
    /// `cap`: the most points to keep (`PREVIEW_POINT_BUDGET`, or less in tests). The
    /// levels read are chosen so that they fit it.
    pub fn new(reader: CopcReader<R>, bounds: XyBounds, has_color: bool, cap: usize) -> Self {
        let points = ExtractPoints::coarse(reader, cap as u64);
        let expected = usize::try_from(points.stats().candidate_points).unwrap_or(usize::MAX);
        let mut store = CoarsePoints::new(bounds, has_color, cap, expected);
        store.depth = points.depth_limit().unwrap_or(0);
        Self { points, store }
    }

    /// Reads up to `batch` points. `Ok(true)` when everything is read (or the cap
    /// stopped the reading).
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

    /// `(points read, points that will be read)`.
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

    /// `side * side` points on a 1 m lattice (z = x + y; ground when x is even).
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
        let path = make_copc(dir.path(), 60, 200); // 3600 points, several levels
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
        // Only the upper levels were read, and they fit the budget.
        assert!(stats.nodes_read < all_nodes, "{stats:?} of {all_nodes}");
        assert_eq!(stats.nodes_read, stats.nodes_selected);
        assert_eq!(n, stats.candidate_points);
        assert!(n <= 1000, "{n}");
        // The reader of the window picks the same depth and keeps exactly those points.
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
        // A budget over the file takes every node.
        assert_eq!(large.stats().candidate_points, 3600);
    }

    #[test]
    fn held_points_never_exceed_the_cap() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = make_copc(dir.path(), 60, 200);
        // The cap is smaller than the root node (200 points), so reading is cut off.
        let (store, _) = read_all(&path, 60, 50);
        assert_eq!(store.len(), 50);
        assert!(store.is_truncated());
        assert!(store.bytes_held() <= 50 * std::mem::size_of::<CoarsePoint>());
        // A cap the levels fit in is not truncated and holds no more than the cap.
        let (store, _) = read_all(&path, 60, 1000);
        assert!(store.len() <= 1000);
        assert!(!store.is_truncated());
        assert!(store.bytes_held() <= 1000 * std::mem::size_of::<CoarsePoint>());
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
        // Nothing grew past the cap, however many points were offered.
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
        // 4 m cells over a 39 m extent: 10 x 10 cells, 16 points each.
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
        // A coarser cell than needed is kept as the user asked.
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
        // Everything here is class 1 or 2, so "ground only" works; make a cloud with none.
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
}
