//! G1-3: what a finished raster turns into: a GeoTIFF and a display point cloud.
//!
//! Both the desktop (`pcv-convert`) and the Web (`pcv-wasm`) runs end here, so the two
//! outputs are the same on both sides. Reading the points (the part that differs) and
//! writing the COPC (also different) stay in those crates.
//!
//! # The display point cloud (plan 2.1)
//!
//! One point per non-empty cell, placed at the cell centre:
//!
//! - Z kinds (min, max, mean): Z = the cell's value.
//! - Count / intensity / RGB: Z = the mean Z of the cell's points, and the value goes
//!   into the intensity (count is scaled so that the largest count is 65535;
//!   intensity mean is used as it is). The RGB kind puts the mean colour on the point.
//!
//! Then the existing renderer and layer machinery show the raster without a new
//! pipeline.

use std::io::Write;

use copc_core::LasPointRecord;

use crate::raster::geotiff;
use crate::raster::{CellAccumulator, ClassFilter, RasterError, RasterValue, NODATA};

/// What the user asked for. Deserialised from the Tauri command / the Worker message.
#[derive(Debug, Clone, Copy, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RasterOptions {
    /// In the file's horizontal unit.
    pub cell_size: f64,
    pub value: RasterValue,
    /// Only points classified as ground (2).
    pub ground_only: bool,
}

impl RasterOptions {
    pub fn class_filter(&self) -> ClassFilter {
        if self.ground_only {
            ClassFilter::only(&[2])
        } else {
            ClassFilter::all()
        }
    }
}

/// Writes the GeoTIFF of a finished accumulator: float32 for the single-band kinds,
/// RGBA (with an alpha band) for `RgbMean`.
pub fn write_geotiff<W: Write>(
    acc: &CellAccumulator,
    epsg: Option<u32>,
    out: &mut W,
) -> Result<(), RasterError> {
    if acc.value_kind() == RasterValue::RgbMean {
        geotiff::write_rgb_u16(out, acc.spec(), epsg, acc.rgb_samples())
    } else {
        geotiff::write_f32(out, acc.spec(), epsg, NODATA, acc.f32_samples(NODATA))
    }
}

/// The warning for the error log when the GeoTIFF cannot carry a CRS.
pub fn missing_crs_warning(epsg: Option<u32>) -> Option<String> {
    match epsg {
        Some(code) if code != 0 && code < 32767 => None,
        _ => Some(
            "座標系(EPSG)が分からないため、GeoTIFFには座標系を書いていません。\
             GISで開くときは座標系を指定してください"
                .to_string(),
        ),
    }
}

/// Number of non-empty cells (the display layer's point count). Walks every cell.
pub fn filled_cells(acc: &CellAccumulator) -> u64 {
    (0..acc.spec().cell_count() as usize)
        .filter(|&i| acc.is_filled(i))
        .count() as u64
}

/// Where a walk over the display points of a finished accumulator has got to. It does
/// not borrow the accumulator (the caller passes it on every call), so a struct that
/// owns both can keep one: the Web yields to the event loop between batches and
/// resumes from `cells_visited`.
pub struct DisplayCursor {
    next_cell: usize,
    /// Count is scaled so that this count becomes 65535 (1 for other kinds).
    count_max: f32,
    /// Length of the extra-bytes block the output layout expects (zero-filled).
    extra_bytes_len: usize,
}

impl DisplayCursor {
    /// `extra_bytes_len` is the layout's extra bytes per point (the output keeps the
    /// source's point format, so the records must have the same size).
    pub fn new(acc: &CellAccumulator, extra_bytes_len: usize) -> Self {
        let count_max = if acc.value_kind() == RasterValue::Count {
            (0..acc.spec().cell_count() as usize)
                .filter_map(|i| acc.value_at(i))
                .fold(1.0_f32, f32::max)
        } else {
            1.0
        };
        Self {
            next_cell: 0,
            count_max,
            extra_bytes_len,
        }
    }

    /// Number of cells looked at so far (progress of the emit phase).
    pub fn cells_visited(&self) -> u64 {
        self.next_cell as u64
    }

    /// The next non-empty cell as a point, or `None` after the last cell.
    pub fn next_record(&mut self, acc: &CellAccumulator) -> Option<LasPointRecord> {
        let total = acc.spec().cell_count() as usize;
        while self.next_cell < total {
            let i = self.next_cell;
            self.next_cell += 1;
            if let Some(record) = self.record_at(acc, i) {
                return Some(record);
            }
        }
        None
    }

    fn record_at(&self, acc: &CellAccumulator, i: usize) -> Option<LasPointRecord> {
        let z = acc.display_z_at(i)?;
        let (x, y) = acc.spec().cell_center(i);
        let intensity = match acc.value_kind() {
            RasterValue::Count => {
                let v = acc.value_at(i).unwrap_or(0.0);
                (v / self.count_max * 65_535.0).round().clamp(0.0, 65_535.0) as u16
            }
            RasterValue::IntensityMean => {
                acc.value_at(i).unwrap_or(0.0).round().clamp(0.0, 65_535.0) as u16
            }
            _ => 0,
        };
        let [red, green, blue] = acc.rgb_at(i).unwrap_or([0, 0, 0]);
        Some(LasPointRecord {
            x,
            y,
            z,
            intensity,
            return_number: 1,
            number_of_returns: 1,
            classification: 1,
            red,
            green,
            blue,
            extra_bytes: vec![0; self.extra_bytes_len],
            ..Default::default()
        })
    }
}

/// The display points of a finished accumulator as an iterator: one per non-empty
/// cell, in image order (this is what the desktop hands to the COPC writer).
pub struct DisplayPoints<'a> {
    acc: &'a CellAccumulator,
    cursor: DisplayCursor,
}

impl<'a> DisplayPoints<'a> {
    pub fn new(acc: &'a CellAccumulator, extra_bytes_len: usize) -> Self {
        Self {
            acc,
            cursor: DisplayCursor::new(acc, extra_bytes_len),
        }
    }
}

impl Iterator for DisplayPoints<'_> {
    type Item = LasPointRecord;

    fn next(&mut self) -> Option<LasPointRecord> {
        self.cursor.next_record(self.acc)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::raster::GridSpec;
    use std::io::Cursor;
    use tiff::decoder::{Decoder, DecodingResult};

    fn acc(value: RasterValue) -> CellAccumulator {
        // 2 x 2 cells of 1 m at (10, 20); NW = 0, NE = 1, SW = 2, SE = 3.
        let spec = GridSpec::from_bounds(10.0, 20.0, 12.0, 22.0, 1.0, 10).expect("spec");
        CellAccumulator::new(spec, value, ClassFilter::all())
    }

    #[test]
    fn z_mean_display_points_sit_at_cell_centres_with_the_value_as_z() {
        let mut a = acc(RasterValue::ZMean);
        a.add(10.2, 20.2, 4.0, 0, 1, [0; 3]); // SW
        a.add(10.8, 20.8, 8.0, 0, 1, [0; 3]); // SW
        a.add(11.5, 21.5, 1.0, 0, 1, [0; 3]); // NE
        let points: Vec<_> = DisplayPoints::new(&a, 0).collect();
        assert_eq!(points.len(), 2, "one point per non-empty cell");
        // Image order: NE (cell 1) first, then SW (cell 2).
        assert_eq!((points[0].x, points[0].y, points[0].z), (11.5, 21.5, 1.0));
        assert_eq!((points[1].x, points[1].y, points[1].z), (10.5, 20.5, 6.0));
        assert_eq!(filled_cells(&a), 2);
    }

    #[test]
    fn count_goes_into_intensity_and_z_is_the_mean_height() {
        let mut a = acc(RasterValue::Count);
        for _ in 0..4 {
            a.add(10.5, 20.5, 3.0, 0, 1, [0; 3]); // SW: 4 points
        }
        a.add(11.5, 21.5, 5.0, 0, 1, [0; 3]); // NE: 1 point
        let points: Vec<_> = DisplayPoints::new(&a, 2).collect();
        assert_eq!(points.len(), 2);
        assert_eq!((points[0].z, points[0].intensity), (5.0, 16_384)); // 1/4 of 65535, rounded
        assert_eq!((points[1].z, points[1].intensity), (3.0, 65_535));
        assert_eq!(points[0].extra_bytes.len(), 2);
    }

    #[test]
    fn rgb_display_points_carry_the_mean_colour() {
        let mut a = acc(RasterValue::RgbMean);
        a.add(10.5, 20.5, 2.0, 0, 1, [1000, 2000, 3000]);
        a.add(10.5, 20.5, 4.0, 0, 1, [3000, 2000, 1000]);
        let points: Vec<_> = DisplayPoints::new(&a, 0).collect();
        assert_eq!(points.len(), 1);
        assert_eq!(
            (points[0].red, points[0].green, points[0].blue),
            (2000, 2000, 2000)
        );
        assert_eq!(points[0].z, 3.0);
    }

    #[test]
    fn geotiff_matches_the_accumulator() {
        let mut a = acc(RasterValue::ZMax);
        a.add(10.5, 20.5, 7.0, 0, 1, [0; 3]);
        let mut bytes = Vec::new();
        write_geotiff(&a, Some(6677), &mut bytes).expect("write");
        let mut d = Decoder::new(Cursor::new(bytes)).expect("decoder");
        assert_eq!(d.dimensions().expect("dims"), (2, 2));
        match d.read_image().expect("image") {
            DecodingResult::F32(v) => assert_eq!(v, vec![NODATA, NODATA, 7.0, NODATA]),
            other => panic!("unexpected sample type: {other:?}"),
        }
    }

    #[test]
    fn rgb_geotiff_has_transparent_empty_cells() {
        let mut a = acc(RasterValue::RgbMean);
        a.add(10.5, 20.5, 7.0, 0, 1, [100, 200, 300]);
        let mut bytes = Vec::new();
        write_geotiff(&a, None, &mut bytes).expect("write");
        let mut d = Decoder::new(Cursor::new(bytes)).expect("decoder");
        match d.read_image().expect("image") {
            DecodingResult::U16(v) => {
                assert_eq!(&v[0..4], &[0, 0, 0, 0], "empty cell: alpha 0");
                assert_eq!(&v[8..12], &[100, 200, 300, 65_535]);
            }
            other => panic!("unexpected sample type: {other:?}"),
        }
    }

    #[test]
    fn warns_only_without_an_epsg_code() {
        assert!(missing_crs_warning(Some(6677)).is_none());
        assert!(missing_crs_warning(None).is_some());
        assert!(missing_crs_warning(Some(40_000)).is_some());
    }
}
