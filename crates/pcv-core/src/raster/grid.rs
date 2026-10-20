//! G1-1: the raster grid and the per-cell accumulators.
//!
//! A raster is a grid of square cells laid over the XY extent of a point cloud. The
//! points are streamed through `CellAccumulator::add` one at a time, so memory
//! depends on the number of cells (area / cell size squared), never on the number of
//! points.
//!
//! # Row order: row 0 is the NORTH row
//!
//! Cell `(col, row)`: `col` grows towards +X (east), and **`row` grows towards -Y
//! (south)**. Row 0 is the row with the largest Y. This is the order GeoTIFF (and
//! every image format) stores pixels in: the first pixel is the top-left corner of
//! the image, which is the north-west corner of the map. The flat index is
//! `row * width + col`, so iterating the accumulator output in index order gives a
//! top-to-bottom, left-to-right image that can be written to a TIFF as is.
//!
//! # Alignment
//!
//! The origin (south-west corner) is snapped *down* to a multiple of the cell size,
//! so rasters made from neighbouring layers with the same cell size line up cell for
//! cell.
//!
//! # Edges
//!
//! A cell covers `[x0, x0 + cell)` in X and `[y0, y0 + cell)` in Y, except that points
//! lying exactly on the maximum edge of the grid belong to the last column / the
//! first row (north row). Without that, the point with the largest X or Y of a cloud
//! would fall outside the grid it was built from.

use crate::raster::RasterError;
use copc_core::LasPointRecord;

/// The value written into a single-band float32 raster for cells that received no point.
pub const NODATA: f32 = -9999.0;

/// Position and size of the grid. See the module docs for the row order.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GridSpec {
    /// X of the west edge (a multiple of `cell_size`).
    pub origin_x: f64,
    /// Y of the SOUTH edge (a multiple of `cell_size`). The north edge is
    /// `origin_y + height * cell_size`, see `top_y`.
    pub origin_y: f64,
    pub cell_size: f64,
    pub width: u32,
    pub height: u32,
}

impl GridSpec {
    /// Builds the grid that covers the XY bounds. `max_cells` is the largest number of
    /// cells the caller accepts; more than that is refused (a raster whose size
    /// follows the area would otherwise eat all memory on a huge cloud or a tiny cell).
    pub fn from_bounds(
        min_x: f64,
        min_y: f64,
        max_x: f64,
        max_y: f64,
        cell_size: f64,
        max_cells: u64,
    ) -> Result<Self, RasterError> {
        let finite = [min_x, min_y, max_x, max_y].iter().all(|v| v.is_finite());
        if !finite || max_x < min_x || max_y < min_y {
            return Err(RasterError::InvalidArgument(
                "点群の範囲が正しくありません".to_string(),
            ));
        }
        if !cell_size.is_finite() || cell_size <= 0.0 {
            return Err(RasterError::InvalidArgument(
                "セルの大きさは0より大きい数にしてください".to_string(),
            ));
        }
        let origin_x = (min_x / cell_size).floor() * cell_size;
        let origin_y = (min_y / cell_size).floor() * cell_size;
        // At least one cell, so a cloud that is a single point (or a line) still has a grid.
        let cols = (((max_x - origin_x) / cell_size).ceil()).max(1.0);
        let rows = (((max_y - origin_y) / cell_size).ceil()).max(1.0);
        // Compare as f64 first: the product of two huge u32-range numbers must not wrap.
        if cols * rows > max_cells as f64 {
            return Err(RasterError::TooManyCells {
                cols,
                rows,
                max_cells,
            });
        }
        // cols * rows <= max_cells, but each side alone must also fit u32.
        if cols > f64::from(u32::MAX) || rows > f64::from(u32::MAX) {
            return Err(RasterError::TooManyCells {
                cols,
                rows,
                max_cells,
            });
        }
        Ok(Self {
            origin_x,
            origin_y,
            cell_size,
            width: cols as u32,
            height: rows as u32,
        })
    }

    pub fn cell_count(&self) -> u64 {
        u64::from(self.width) * u64::from(self.height)
    }

    /// Y of the north edge of the grid (the top of row 0).
    pub fn top_y(&self) -> f64 {
        self.origin_y + f64::from(self.height) * self.cell_size
    }

    /// X of the east edge of the grid.
    pub fn right_x(&self) -> f64 {
        self.origin_x + f64::from(self.width) * self.cell_size
    }

    /// Flat index (`row * width + col`, row 0 = north) of the cell containing the
    /// point, or `None` when it is outside the grid (or not finite).
    pub fn cell_index(&self, x: f64, y: f64) -> Option<usize> {
        if !x.is_finite() || !y.is_finite() {
            return None;
        }
        let top = self.top_y();
        let right = self.right_x();
        if x < self.origin_x || x > right || y < self.origin_y || y > top {
            return None;
        }
        // The max edge belongs to the last column / row 0 (see "Edges"), hence the clamps.
        let col =
            (((x - self.origin_x) / self.cell_size).floor() as u64).min(u64::from(self.width) - 1);
        // Count rows from the south edge (same half-open rule as X), then flip so that
        // row 0 is the north row.
        let south_row =
            (((y - self.origin_y) / self.cell_size).floor() as u64).min(u64::from(self.height) - 1);
        let row = u64::from(self.height) - 1 - south_row;
        usize::try_from(row * u64::from(self.width) + col).ok()
    }

    /// Centre of the cell at the flat index.
    pub fn cell_center(&self, index: usize) -> (f64, f64) {
        let width = self.width as usize;
        let col = index % width;
        let row = index / width;
        (
            self.origin_x + (col as f64 + 0.5) * self.cell_size,
            self.top_y() - (row as f64 + 0.5) * self.cell_size,
        )
    }
}

/// Which classifications are counted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClassFilter {
    mask: [bool; 256],
}

impl ClassFilter {
    /// Every point, whatever its classification.
    pub fn all() -> Self {
        Self { mask: [true; 256] }
    }

    /// Only points whose classification is in `classes`.
    pub fn only(classes: &[u8]) -> Self {
        let mut mask = [false; 256];
        for &c in classes {
            mask[usize::from(c)] = true;
        }
        Self { mask }
    }

    pub fn accepts(&self, classification: u8) -> bool {
        self.mask[usize::from(classification)]
    }
}

/// What each cell holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RasterValue {
    ZMin,
    ZMax,
    ZMean,
    /// Number of points (density).
    Count,
    IntensityMean,
    /// Mean of red, green, blue (u16 like LAS). Three-band output.
    RgbMean,
}

/// The per-cell storage. Only what the chosen value needs is kept (plan 2.1).
enum Cells {
    Min(Vec<f32>),
    Max(Vec<f32>),
    Count(Vec<u32>),
    /// Used by `ZMean` and `IntensityMean`.
    Mean {
        sum: Vec<f64>,
        count: Vec<u32>,
    },
    Rgb {
        sum: Vec<[u64; 3]>,
        count: Vec<u32>,
    },
}

/// Streams points into the grid and gives back one value per cell.
pub struct CellAccumulator {
    spec: GridSpec,
    value: RasterValue,
    classes: ClassFilter,
    cells: Cells,
    /// Sum of Z per cell. Kept only for the kinds whose value is not a height
    /// (count, intensity, RGB): the display layer puts the cell's mean Z on its
    /// point. Empty for the Z kinds (their value already is the height).
    z_sum: Vec<f64>,
    /// Points that were accepted by the class filter and fell inside the grid.
    accepted: u64,
}

impl CellAccumulator {
    pub fn new(spec: GridSpec, value: RasterValue, classes: ClassFilter) -> Self {
        let n = spec.cell_count() as usize;
        let cells = match value {
            RasterValue::ZMin => Cells::Min(vec![f32::INFINITY; n]),
            RasterValue::ZMax => Cells::Max(vec![f32::NEG_INFINITY; n]),
            RasterValue::Count => Cells::Count(vec![0; n]),
            RasterValue::ZMean | RasterValue::IntensityMean => Cells::Mean {
                sum: vec![0.0; n],
                count: vec![0; n],
            },
            RasterValue::RgbMean => Cells::Rgb {
                sum: vec![[0; 3]; n],
                count: vec![0; n],
            },
        };
        let z_sum = match value {
            RasterValue::Count | RasterValue::IntensityMean | RasterValue::RgbMean => {
                vec![0.0; n]
            }
            _ => Vec::new(),
        };
        Self {
            spec,
            value,
            classes,
            cells,
            z_sum,
            accepted: 0,
        }
    }

    pub fn spec(&self) -> &GridSpec {
        &self.spec
    }

    pub fn value_kind(&self) -> RasterValue {
        self.value
    }

    /// Number of points counted so far.
    pub fn accepted_points(&self) -> u64 {
        self.accepted
    }

    pub fn add_record(&mut self, p: &LasPointRecord) {
        self.add(
            p.x,
            p.y,
            p.z,
            p.intensity,
            p.classification,
            [p.red, p.green, p.blue],
        );
    }

    pub fn add(&mut self, x: f64, y: f64, z: f64, intensity: u16, class: u8, rgb: [u16; 3]) {
        if !self.classes.accepts(class) {
            return;
        }
        let Some(i) = self.spec.cell_index(x, y) else {
            return;
        };
        self.accepted += 1;
        if let Some(sum) = self.z_sum.get_mut(i) {
            *sum += z;
        }
        match &mut self.cells {
            Cells::Min(v) => v[i] = v[i].min(z as f32),
            Cells::Max(v) => v[i] = v[i].max(z as f32),
            Cells::Count(c) => c[i] = c[i].saturating_add(1),
            Cells::Mean { sum, count } => {
                let sample = if self.value == RasterValue::ZMean {
                    z
                } else {
                    f64::from(intensity)
                };
                sum[i] += sample;
                count[i] = count[i].saturating_add(1);
            }
            Cells::Rgb { sum, count } => {
                for (s, c) in sum[i].iter_mut().zip(rgb) {
                    *s += u64::from(c);
                }
                count[i] = count[i].saturating_add(1);
            }
        }
    }

    /// Whether the cell received at least one point.
    pub fn is_filled(&self, i: usize) -> bool {
        match &self.cells {
            Cells::Min(v) => v[i] != f32::INFINITY,
            Cells::Max(v) => v[i] != f32::NEG_INFINITY,
            Cells::Count(c) => c[i] > 0,
            Cells::Mean { count, .. } | Cells::Rgb { count, .. } => count[i] > 0,
        }
    }

    /// Single-band value of the cell; `None` when empty. For `RgbMean` this is
    /// `None` (use `rgb_at`).
    pub fn value_at(&self, i: usize) -> Option<f32> {
        if !self.is_filled(i) {
            return None;
        }
        match &self.cells {
            Cells::Min(v) | Cells::Max(v) => Some(v[i]),
            Cells::Count(c) => Some(c[i] as f32),
            Cells::Mean { sum, count } => Some((sum[i] / f64::from(count[i])) as f32),
            Cells::Rgb { .. } => None,
        }
    }

    /// Height to put on the cell's display point: the value itself for the Z kinds,
    /// the mean Z of the cell's points for count / intensity / RGB. `None` when empty.
    pub fn display_z_at(&self, i: usize) -> Option<f64> {
        if !self.is_filled(i) {
            return None;
        }
        match &self.cells {
            Cells::Min(v) | Cells::Max(v) => Some(f64::from(v[i])),
            Cells::Mean { sum, count } if self.value == RasterValue::ZMean => {
                Some(sum[i] / f64::from(count[i]))
            }
            Cells::Count(c) => Some(self.z_sum[i] / f64::from(c[i])),
            Cells::Mean { count, .. } | Cells::Rgb { count, .. } => {
                Some(self.z_sum[i] / f64::from(count[i]))
            }
        }
    }

    /// Mean colour of the cell; `None` when empty or when the kind is not `RgbMean`.
    pub fn rgb_at(&self, i: usize) -> Option<[u16; 3]> {
        match &self.cells {
            Cells::Rgb { sum, count } if count[i] > 0 => {
                let n = u64::from(count[i]);
                // The mean of u16 values fits u16.
                Some(sum[i].map(|s| u16::try_from(s / n).unwrap_or(u16::MAX)))
            }
            _ => None,
        }
    }

    /// All cells in image order (row 0 = north) as f32, empty cells as `nodata`.
    /// Lazy: no second copy of the grid is built. Feed it to
    /// `geotiff::write_f32`.
    pub fn f32_samples(&self, nodata: f32) -> impl Iterator<Item = f32> + '_ {
        (0..self.spec.cell_count() as usize).map(move |i| self.value_at(i).unwrap_or(nodata))
    }

    /// All cells in image order as RGB; empty cells are `None`, which
    /// `geotiff::write_rgb_u16` writes as a transparent pixel (alpha band 0), not as
    /// black. Feed it to that function.
    pub fn rgb_samples(&self) -> impl Iterator<Item = Option<[u16; 3]>> + '_ {
        (0..self.spec.cell_count() as usize).map(move |i| self.rgb_at(i))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec_10x10() -> GridSpec {
        // Cells of 1 m: x in [100, 110], y in [200, 210].
        GridSpec::from_bounds(100.0, 200.0, 110.0, 210.0, 1.0, 1_000_000).expect("spec")
    }

    #[test]
    fn spec_covers_bounds_and_snaps_origin_down() {
        let s = GridSpec::from_bounds(100.3, 200.7, 104.2, 202.1, 2.0, 100).expect("spec");
        assert_eq!(s.origin_x, 100.0);
        assert_eq!(s.origin_y, 200.0);
        assert_eq!(s.width, 3); // 100..106
        assert_eq!(s.height, 2); // 200..204
        assert_eq!(s.top_y(), 204.0);
        // Negative coordinates snap towards -infinity, not towards zero.
        let n = GridSpec::from_bounds(-0.5, -0.5, 0.5, 0.5, 1.0, 100).expect("spec");
        assert_eq!((n.origin_x, n.origin_y), (-1.0, -1.0));
        // Neighbouring layers with the same cell size share the same lattice.
        let a = GridSpec::from_bounds(10.2, 0.0, 20.0, 5.0, 0.5, 10_000).expect("a");
        let b = GridSpec::from_bounds(13.9, 0.0, 30.0, 5.0, 0.5, 10_000).expect("b");
        assert_eq!((b.origin_x - a.origin_x) % 0.5, 0.0);
    }

    #[test]
    fn single_point_extent_has_one_cell() {
        let s = GridSpec::from_bounds(5.5, 5.5, 5.5, 5.5, 1.0, 10).expect("spec");
        assert_eq!((s.width, s.height), (1, 1));
        assert_eq!(s.cell_index(5.5, 5.5), Some(0));
    }

    #[test]
    fn cell_index_row_zero_is_north() {
        let s = spec_10x10();
        // South-west corner: last row, first column.
        assert_eq!(s.cell_index(100.0, 200.0), Some(9 * 10));
        // North-west corner area: row 0, col 0.
        assert_eq!(s.cell_index(100.5, 209.5), Some(0));
        // Row 0, col 3.
        assert_eq!(s.cell_index(103.2, 209.9), Some(3));
        // Cell edges belong to the cell on their east / north side...
        assert_eq!(s.cell_index(101.0, 205.0), Some(4 * 10 + 1));
    }

    #[test]
    fn points_on_max_edge_belong_to_last_cell() {
        let s = spec_10x10();
        // Max X, min Y: last column, last row.
        assert_eq!(s.cell_index(110.0, 200.0), Some(9 * 10 + 9));
        // Max Y, min X: row 0, col 0.
        assert_eq!(s.cell_index(100.0, 210.0), Some(0));
        // Max X, max Y: row 0, last column.
        assert_eq!(s.cell_index(110.0, 210.0), Some(9));
    }

    #[test]
    fn points_outside_or_not_finite_have_no_cell() {
        let s = spec_10x10();
        assert_eq!(s.cell_index(99.999, 205.0), None);
        assert_eq!(s.cell_index(110.001, 205.0), None);
        assert_eq!(s.cell_index(105.0, 199.999), None);
        assert_eq!(s.cell_index(105.0, 210.001), None);
        assert_eq!(s.cell_index(f64::NAN, 205.0), None);
        assert_eq!(s.cell_index(105.0, f64::INFINITY), None);
    }

    #[test]
    fn cell_center_is_inverse_of_cell_index() {
        let s = spec_10x10();
        for i in [0usize, 7, 10, 55, 99] {
            let (x, y) = s.cell_center(i);
            assert_eq!(s.cell_index(x, y), Some(i));
        }
        assert_eq!(s.cell_center(0), (100.5, 209.5));
    }

    #[test]
    fn cap_refuses_too_many_cells_with_helpful_text() {
        let err = GridSpec::from_bounds(0.0, 0.0, 1000.0, 1000.0, 1.0, 999_999).expect_err("cap");
        let text = err.to_string();
        assert!(text.contains("1000"), "{text}");
        assert!(text.contains("セルの大きさ"), "{text}");
        assert!(text.contains("範囲"), "{text}");
        // Exactly at the cap is fine.
        assert!(GridSpec::from_bounds(0.0, 0.0, 1000.0, 1000.0, 1.0, 1_000_000).is_ok());
        // A tiny cell on a big area does not overflow.
        assert!(GridSpec::from_bounds(0.0, 0.0, 1e9, 1e9, 1e-6, u64::MAX).is_err());
    }

    #[test]
    fn rejects_bad_arguments() {
        assert!(GridSpec::from_bounds(0.0, 0.0, 1.0, 1.0, 0.0, 10).is_err());
        assert!(GridSpec::from_bounds(0.0, 0.0, 1.0, 1.0, -1.0, 10).is_err());
        assert!(GridSpec::from_bounds(0.0, 0.0, 1.0, 1.0, f64::NAN, 10).is_err());
        assert!(GridSpec::from_bounds(f64::NAN, 0.0, 1.0, 1.0, 1.0, 10).is_err());
        assert!(GridSpec::from_bounds(2.0, 0.0, 1.0, 1.0, 1.0, 10).is_err());
    }

    fn acc(value: RasterValue, classes: ClassFilter) -> CellAccumulator {
        // 2 x 2 cells of 1 m: x in [0, 2], y in [0, 2].
        let spec = GridSpec::from_bounds(0.0, 0.0, 2.0, 2.0, 1.0, 10).expect("spec");
        CellAccumulator::new(spec, value, classes)
    }

    // Cell indices in the 2x2 grid: NW = 0, NE = 1, SW = 2, SE = 3.

    #[test]
    fn z_min_max_mean() {
        let mut min = acc(RasterValue::ZMin, ClassFilter::all());
        let mut max = acc(RasterValue::ZMax, ClassFilter::all());
        let mut mean = acc(RasterValue::ZMean, ClassFilter::all());
        for a in [&mut min, &mut max, &mut mean] {
            a.add(0.5, 1.5, 3.0, 0, 2, [0; 3]); // NW
            a.add(0.6, 1.4, 5.0, 0, 2, [0; 3]); // NW
            a.add(0.7, 1.3, 1.0, 0, 2, [0; 3]); // NW
            a.add(1.5, 0.5, 7.0, 0, 2, [0; 3]); // SE
        }
        assert_eq!(min.value_at(0), Some(1.0));
        assert_eq!(max.value_at(0), Some(5.0));
        assert_eq!(mean.value_at(0), Some(3.0));
        assert_eq!(min.value_at(3), Some(7.0));
        // Empty cells are NoData.
        assert_eq!(min.value_at(1), None);
        assert_eq!(max.value_at(2), None);
        assert_eq!(mean.value_at(1), None);
        let samples: Vec<f32> = mean.f32_samples(NODATA).collect();
        assert_eq!(samples, vec![3.0, NODATA, NODATA, 7.0]);
        assert_eq!(mean.accepted_points(), 4);
    }

    #[test]
    fn count_and_intensity_mean() {
        let mut count = acc(RasterValue::Count, ClassFilter::all());
        let mut inten = acc(RasterValue::IntensityMean, ClassFilter::all());
        for a in [&mut count, &mut inten] {
            a.add(0.5, 0.5, 0.0, 100, 1, [0; 3]); // SW
            a.add(0.5, 0.6, 0.0, 300, 1, [0; 3]); // SW
            a.add(1.5, 1.5, 0.0, 65_535, 1, [0; 3]); // NE
        }
        assert_eq!(count.value_at(2), Some(2.0));
        assert_eq!(count.value_at(1), Some(1.0));
        assert_eq!(count.value_at(0), None);
        assert_eq!(inten.value_at(2), Some(200.0));
        assert_eq!(inten.value_at(1), Some(65_535.0));
    }

    #[test]
    fn display_z_is_value_for_z_kinds_and_mean_z_otherwise() {
        let mut max = acc(RasterValue::ZMax, ClassFilter::all());
        let mut count = acc(RasterValue::Count, ClassFilter::all());
        let mut rgb = acc(RasterValue::RgbMean, ClassFilter::all());
        for a in [&mut max, &mut count, &mut rgb] {
            a.add(0.5, 0.5, 2.0, 0, 1, [1; 3]); // SW
            a.add(0.5, 0.5, 6.0, 0, 1, [1; 3]); // SW
        }
        assert_eq!(max.display_z_at(2), Some(6.0));
        assert_eq!(count.display_z_at(2), Some(4.0));
        assert_eq!(rgb.display_z_at(2), Some(4.0));
        assert_eq!(count.display_z_at(0), None);
    }

    #[test]
    fn rgb_mean_is_three_band_u16() {
        let mut a = acc(RasterValue::RgbMean, ClassFilter::all());
        a.add(0.5, 0.5, 0.0, 0, 1, [65_535, 0, 100]);
        a.add(0.5, 0.5, 0.0, 0, 1, [65_535, 10, 300]);
        assert_eq!(a.rgb_at(2), Some([65_535, 5, 200]));
        assert_eq!(a.rgb_at(0), None);
        assert_eq!(a.value_at(2), None, "RGB has no single-band value");
        let px: Vec<Option<[u16; 3]>> = a.rgb_samples().collect();
        assert_eq!(px.len(), 4);
        assert_eq!(px[0], None);
        assert_eq!(px[2], Some([65_535, 5, 200]));
    }

    #[test]
    fn class_filter_skips_other_classes() {
        let mut a = acc(RasterValue::Count, ClassFilter::only(&[2, 9]));
        a.add(0.5, 0.5, 0.0, 0, 2, [0; 3]);
        a.add(0.5, 0.5, 0.0, 0, 9, [0; 3]);
        a.add(0.5, 0.5, 0.0, 0, 6, [0; 3]); // building: not counted
        a.add(1.5, 1.5, 0.0, 0, 6, [0; 3]); // building only: cell stays empty
        assert_eq!(a.value_at(2), Some(2.0));
        assert_eq!(a.value_at(1), None);
        assert_eq!(a.accepted_points(), 2);
    }

    #[test]
    fn points_outside_the_grid_are_ignored() {
        let mut a = acc(RasterValue::Count, ClassFilter::all());
        a.add(50.0, 50.0, 0.0, 0, 1, [0; 3]);
        assert_eq!(a.accepted_points(), 0);
    }
}
