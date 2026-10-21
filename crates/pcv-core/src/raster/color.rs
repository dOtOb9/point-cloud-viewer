//! G1-R1: the colour of a raster cell. One function for the preview and for the colored
//! GeoTIFF, so the picture in the window and the exported picture cannot drift apart.
//!
//! - Elevation / count / intensity: the cell's value is mapped into `min..max` and looked
//!   up in the elevation ramp. `min..max` is the range of the preview's values; the
//!   export gets the same range from the window (`RasterOptions::range`), so the colours
//!   of the file match the colours the user looked at.
//! - RGB: the cell's mean colour as it is, u16 to u8.
//! - Empty cell: alpha 0 (transparent).
//!
//! # The ramp is a copy
//!
//! `ELEVATION_RAMP` is copied from `ELEVATION_INTENSITY_RAMP` in `src/renderer/colormap.ts`
//! (CloudCompare's blue > green > yellow > red). It cannot be shared across Rust and
//! TypeScript, so both sides have a test with the same sample values
//! (`ramp_matches_colormap_ts` here, "the Rust raster ramp" in `colormap.test.ts`).
//! Change the stops in one place and the other test fails.

use crate::color_depth::{self, ColorBitDepth};
use crate::raster::{CellAccumulator, RasterValue};

/// `(t, [r, g, b])` with every component in 0..=1. Same stops as `colormap.ts`.
pub const ELEVATION_RAMP: [(f32, [f32; 3]); 4] = [
    (0.0, [0.0, 0.0, 1.0]),       // blue (low / weak)
    (1.0 / 3.0, [0.0, 1.0, 0.0]), // green
    (2.0 / 3.0, [1.0, 1.0, 0.0]), // yellow
    (1.0, [1.0, 0.0, 0.0]),       // red (high / strong)
];

/// A transparent pixel (empty cell).
pub const TRANSPARENT: [u8; 4] = [0, 0, 0, 0];

fn to_u8(c: f32) -> u8 {
    (c.clamp(0.0, 1.0) * 255.0).round() as u8
}

/// The ramp colour at `t` (clamped to 0..=1), as 8-bit RGB. Linear between the stops,
/// like `sampleRamp` in `colormap.ts`.
pub fn ramp_color(t: f32) -> [u8; 3] {
    let t = t.clamp(0.0, 1.0);
    for pair in ELEVATION_RAMP.windows(2) {
        let (ta, a) = pair[0];
        let (tb, b) = pair[1];
        if t <= tb {
            let local = if tb > ta { (t - ta) / (tb - ta) } else { 0.0 };
            return [
                to_u8(a[0] + (b[0] - a[0]) * local),
                to_u8(a[1] + (b[1] - a[1]) * local),
                to_u8(a[2] + (b[2] - a[2]) * local),
            ];
        }
    }
    let (_, last) = ELEVATION_RAMP[ELEVATION_RAMP.len() - 1];
    [to_u8(last[0]), to_u8(last[1]), to_u8(last[2])]
}

/// `value` in `range` as 0..=1. A range with no width gives 0 (same as `normalizeValue`).
fn normalize(value: f32, range: (f32, f32)) -> f32 {
    if range.1 > range.0 {
        ((value - range.0) / (range.1 - range.0)).clamp(0.0, 1.0)
    } else {
        0.0
    }
}

/// Smallest and largest value of the filled cells of a single-band raster. `None` for
/// RGB (no single value) and for a raster with no filled cell.
pub fn value_range(acc: &CellAccumulator) -> Option<(f32, f32)> {
    let mut range: Option<(f32, f32)> = None;
    for i in 0..acc.spec().cell_count() as usize {
        if let Some(v) = acc.value_at(i) {
            range = Some(match range {
                None => (v, v),
                Some((lo, hi)) => (lo.min(v), hi.max(v)),
            });
        }
    }
    range
}

/// Turns the cells of one accumulator into RGBA pixels. Built once per picture (it
/// looks at the cells to find the colour depth and the range), then asked per cell.
pub struct CellColorizer {
    kind: RasterValue,
    range: Option<(f32, f32)>,
    depth: ColorBitDepth,
}

impl CellColorizer {
    /// `range`: the colour range to use. `None` takes the min..max of `acc` itself (the
    /// preview); the export passes the preview's range. Ignored for RGB.
    pub fn new(acc: &CellAccumulator, range: Option<(f32, f32)>) -> Self {
        let kind = acc.value_kind();
        let (range, depth) = if kind == RasterValue::RgbMean {
            // Some encoders write 0..=255 into the 16-bit fields (see `color_depth`).
            let colors = (0..acc.spec().cell_count() as usize)
                .filter_map(|i| acc.rgb_at(i))
                .map(|[r, g, b]| (r, g, b));
            (None, color_depth::detect(colors))
        } else {
            (range.or_else(|| value_range(acc)), ColorBitDepth::Sixteen)
        };
        Self { kind, range, depth }
    }

    /// The range the colours were made with (what the legend shows). `None` for RGB.
    pub fn range(&self) -> Option<(f32, f32)> {
        self.range
    }

    /// RGBA of the cell at the flat index; empty cells are transparent.
    pub fn rgba(&self, acc: &CellAccumulator, i: usize) -> [u8; 4] {
        if self.kind == RasterValue::RgbMean {
            self.rgba_of_rgb(acc.rgb_at(i))
        } else {
            self.rgba_of_value(acc.value_at(i))
        }
    }

    /// RGBA of a mean colour (RGB rasters). `None` is an empty cell. Split from `rgba`
    /// so the preview can colour values it changed (`preview::fill_isolated_holes`).
    pub fn rgba_of_rgb(&self, rgb: Option<[u16; 3]>) -> [u8; 4] {
        match rgb {
            Some([r, g, b]) => [
                self.depth.to_u8(r),
                self.depth.to_u8(g),
                self.depth.to_u8(b),
                255,
            ],
            None => TRANSPARENT,
        }
    }

    /// RGBA of a single-band value through the ramp. `None` is an empty cell.
    pub fn rgba_of_value(&self, value: Option<f32>) -> [u8; 4] {
        match (value, self.range) {
            (Some(v), Some(range)) => {
                let [r, g, b] = ramp_color(normalize(v, range));
                [r, g, b, 255]
            }
            _ => TRANSPARENT,
        }
    }

    /// All cells in image order (row 0 = north). Lazy, like `CellAccumulator::f32_samples`.
    pub fn rgba_samples<'a>(
        &'a self,
        acc: &'a CellAccumulator,
    ) -> impl Iterator<Item = [u8; 4]> + 'a {
        (0..acc.spec().cell_count() as usize).map(move |i| self.rgba(acc, i))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::raster::{ClassFilter, GridSpec};

    fn acc(value: RasterValue) -> CellAccumulator {
        // 2 x 2 cells of 1 m; NW = 0, NE = 1, SW = 2, SE = 3.
        let spec = GridSpec::from_bounds(0.0, 0.0, 2.0, 2.0, 1.0, 10).expect("spec");
        CellAccumulator::new(spec, value, ClassFilter::all())
    }

    /// The same table is in `src/renderer/colormap.test.ts` ("the Rust raster ramp"); the
    /// numbers there come from `elevationToColor` with round(c * 255).
    pub const RAMP_SAMPLES: [(f32, [u8; 3]); 8] = [
        (0.0, [0, 0, 255]),
        (0.05, [0, 38, 217]),
        (0.25, [0, 191, 64]),
        (0.4, [51, 255, 0]),
        (0.55, [166, 255, 0]),
        (0.8, [255, 153, 0]),
        (0.95, [255, 38, 0]),
        (1.0, [255, 0, 0]),
    ];

    #[test]
    fn ramp_matches_colormap_ts() {
        for (t, expected) in RAMP_SAMPLES {
            assert_eq!(ramp_color(t), expected, "t = {t}");
        }
        // Outside 0..=1 is clamped to the ends.
        assert_eq!(ramp_color(-3.0), [0, 0, 255]);
        assert_eq!(ramp_color(7.0), [255, 0, 0]);
    }

    #[test]
    fn height_uses_the_range_of_the_values_and_empty_cells_are_transparent() {
        let mut a = acc(RasterValue::ZMean);
        a.add(0.5, 1.5, 10.0, 0, 1, [0; 3]); // NW: lowest
        a.add(1.5, 0.5, 30.0, 0, 1, [0; 3]); // SE: highest
        let c = CellColorizer::new(&a, None);
        assert_eq!(c.range(), Some((10.0, 30.0)));
        assert_eq!(c.rgba(&a, 0), [0, 0, 255, 255]);
        assert_eq!(c.rgba(&a, 3), [255, 0, 0, 255]);
        assert_eq!(c.rgba(&a, 1), TRANSPARENT);
        assert_eq!(c.rgba(&a, 2), TRANSPARENT);
        assert_eq!(c.rgba_samples(&a).count(), 4);
    }

    #[test]
    fn a_given_range_wins_over_the_cells_own_range() {
        // The export uses the preview's range, not the min..max of its own (finer) cells.
        let mut a = acc(RasterValue::ZMax);
        a.add(0.5, 1.5, 14.0, 0, 1, [0; 3]);
        let c = CellColorizer::new(&a, Some((10.0, 20.0)));
        assert_eq!(c.range(), Some((10.0, 20.0)));
        assert_eq!(c.rgba(&a, 0), [51, 255, 0, 255]); // t = 0.4
    }

    #[test]
    fn a_flat_range_does_not_divide_by_zero() {
        let mut a = acc(RasterValue::Count);
        a.add(0.5, 1.5, 0.0, 0, 1, [0; 3]);
        let c = CellColorizer::new(&a, None);
        assert_eq!(c.rgba(&a, 0), [0, 0, 255, 255]);
    }

    #[test]
    fn rgb_is_u16_to_u8_and_empty_is_transparent() {
        let mut a = acc(RasterValue::RgbMean);
        a.add(0.5, 1.5, 0.0, 0, 1, [65_535, 32_768, 256]);
        let c = CellColorizer::new(&a, None);
        assert_eq!(c.range(), None);
        assert_eq!(c.rgba(&a, 0), [255, 128, 1, 255]);
        assert_eq!(c.rgba(&a, 1), TRANSPARENT);
    }

    #[test]
    fn rgb_written_as_eight_bit_values_is_not_shifted_to_black() {
        let mut a = acc(RasterValue::RgbMean);
        a.add(0.5, 1.5, 0.0, 0, 1, [200, 100, 50]);
        let c = CellColorizer::new(&a, None);
        assert_eq!(c.rgba(&a, 0), [200, 100, 50, 255]);
    }
}
