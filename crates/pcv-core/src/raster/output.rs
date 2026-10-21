//! G1-3 / G1-R1: what a finished raster turns into: a GeoTIFF.
//!
//! Both the desktop (`pcv-convert`) and the Web (`pcv-wasm`) runs end here, so the two
//! outputs are the same on both sides. Reading the points (the part that differs) stays
//! in those crates.
//!
//! Two forms (the window's "書き出す TIFF" buttons):
//!
//! - `Colored` (default): the picture as the preview shows it, 8-bit RGBA. Windows
//!   Photos shows it as it is, and GIS software places it with the geo tags.
//! - `Values`: the numbers (float32 for single-band kinds, 16-bit RGBA for RGB), for
//!   analysis.
//!
//! The raster is not turned into a point-cloud layer (owner's decision 2026-10-21, plan
//! section 13): the file is the deliverable.

use std::io::Write;

use crate::raster::color::CellColorizer;
use crate::raster::geotiff;
use crate::raster::{CellAccumulator, ClassFilter, RasterError, RasterValue, NODATA};

/// Which GeoTIFF to write.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TiffKind {
    /// 8-bit RGBA, coloured like the preview.
    #[default]
    Colored,
    /// The raw values.
    Values,
}

/// What the user asked for. Deserialised from the Tauri command / the Worker message.
#[derive(Debug, Clone, Copy, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RasterOptions {
    /// In the file's horizontal unit.
    pub cell_size: f64,
    pub value: RasterValue,
    /// Only points classified as ground (2).
    pub ground_only: bool,
    #[serde(default)]
    pub tiff: TiffKind,
    /// The colour range of the preview (`PreviewImage::range`), `[min, max]`. The colored
    /// file uses it so that its colours match the window. `None`: the range of the
    /// raster's own values.
    #[serde(default)]
    pub range: Option<(f32, f32)>,
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

/// Writes the GeoTIFF of a finished accumulator as `options.tiff` says.
pub fn write_geotiff<W: Write>(
    acc: &CellAccumulator,
    epsg: Option<u32>,
    options: &RasterOptions,
    out: &mut W,
) -> Result<(), RasterError> {
    match options.tiff {
        TiffKind::Colored => {
            let colorizer = CellColorizer::new(acc, options.range);
            geotiff::write_rgba_u8(out, acc.spec(), epsg, colorizer.rgba_samples(acc))
        }
        TiffKind::Values if acc.value_kind() == RasterValue::RgbMean => {
            geotiff::write_rgb_u16(out, acc.spec(), epsg, acc.rgb_samples())
        }
        TiffKind::Values => geotiff::write_f32(out, acc.spec(), epsg, NODATA, acc.f32_samples(NODATA)),
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::raster::GridSpec;
    use std::io::Cursor;
    use tiff::decoder::{Decoder, DecodingResult};
    use tiff::tags::Tag;

    fn acc(value: RasterValue) -> CellAccumulator {
        // 2 x 2 cells of 1 m at (10, 20); NW = 0, NE = 1, SW = 2, SE = 3.
        let spec = GridSpec::from_bounds(10.0, 20.0, 12.0, 22.0, 1.0, 10).expect("spec");
        CellAccumulator::new(spec, value, ClassFilter::all())
    }

    fn options(value: RasterValue, tiff: TiffKind, range: Option<(f32, f32)>) -> RasterOptions {
        RasterOptions {
            cell_size: 1.0,
            value,
            ground_only: false,
            tiff,
            range,
        }
    }

    #[test]
    fn values_geotiff_matches_the_accumulator() {
        let mut a = acc(RasterValue::ZMax);
        a.add(10.5, 20.5, 7.0, 0, 1, [0; 3]);
        let mut bytes = Vec::new();
        write_geotiff(
            &a,
            Some(6677),
            &options(RasterValue::ZMax, TiffKind::Values, None),
            &mut bytes,
        )
        .expect("write");
        let mut d = Decoder::new(Cursor::new(bytes)).expect("decoder");
        assert_eq!(d.dimensions().expect("dims"), (2, 2));
        match d.read_image().expect("image") {
            DecodingResult::F32(v) => assert_eq!(v, vec![NODATA, NODATA, 7.0, NODATA]),
            other => panic!("unexpected sample type: {other:?}"),
        }
    }

    #[test]
    fn rgb_values_geotiff_has_transparent_empty_cells() {
        let mut a = acc(RasterValue::RgbMean);
        a.add(10.5, 20.5, 7.0, 0, 1, [100, 200, 300]);
        let mut bytes = Vec::new();
        write_geotiff(
            &a,
            None,
            &options(RasterValue::RgbMean, TiffKind::Values, None),
            &mut bytes,
        )
        .expect("write");
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
    fn colored_geotiff_is_rgba8_with_the_given_range_and_the_geo_tags() {
        let mut a = acc(RasterValue::ZMean);
        a.add(10.5, 20.5, 14.0, 0, 1, [0; 3]); // SW (cell 2)
        a.add(11.5, 21.5, 20.0, 0, 1, [0; 3]); // NE (cell 1)
        let mut bytes = Vec::new();
        write_geotiff(
            &a,
            Some(6677),
            &options(RasterValue::ZMean, TiffKind::Colored, Some((10.0, 20.0))),
            &mut bytes,
        )
        .expect("write");
        let mut d = Decoder::new(Cursor::new(bytes)).expect("decoder");
        assert_eq!(d.dimensions().expect("dims"), (2, 2));
        match d.read_image().expect("image") {
            DecodingResult::U8(v) => {
                assert_eq!(v.len(), 16);
                assert_eq!(&v[0..4], &[0, 0, 0, 0], "NW is empty: transparent");
                assert_eq!(&v[4..8], &[255, 0, 0, 255], "NE = max of the given range: red");
                assert_eq!(&v[8..12], &[51, 255, 0, 255], "SW = t 0.4 of the given range");
            }
            other => panic!("unexpected sample type: {other:?}"),
        }
        assert_eq!(
            d.get_tag_f64_vec(Tag::ModelPixelScaleTag).expect("scale"),
            vec![1.0, 1.0, 0.0]
        );
        assert_eq!(
            d.get_tag_f64_vec(Tag::ModelTiepointTag).expect("tie"),
            vec![0.0, 0.0, 0.0, 10.0, 22.0, 0.0]
        );
        let keys = d.get_tag_u32_vec(Tag::GeoKeyDirectoryTag).expect("keys");
        assert_eq!(keys[keys.len() - 1], 6677);
    }

    #[test]
    fn colored_rgb_geotiff_keeps_the_colour() {
        let mut a = acc(RasterValue::RgbMean);
        a.add(10.5, 20.5, 0.0, 0, 1, [65_535, 0, 256]);
        let mut bytes = Vec::new();
        write_geotiff(
            &a,
            None,
            &options(RasterValue::RgbMean, TiffKind::Colored, None),
            &mut bytes,
        )
        .expect("write");
        let mut d = Decoder::new(Cursor::new(bytes)).expect("decoder");
        match d.read_image().expect("image") {
            DecodingResult::U8(v) => assert_eq!(&v[8..12], &[255, 0, 1, 255]),
            other => panic!("unexpected sample type: {other:?}"),
        }
    }

    #[test]
    fn options_json_has_the_new_fields_with_defaults() {
        let json = r#"{"cellSize":2.5,"value":"zMean","groundOnly":false}"#;
        let o: RasterOptions = serde_json::from_str(json).expect("old shape still reads");
        assert_eq!((o.tiff, o.range), (TiffKind::Colored, None));
        let json = r#"{"cellSize":2.5,"value":"count","groundOnly":true,"tiff":"values","range":[1,9]}"#;
        let o: RasterOptions = serde_json::from_str(json).expect("full shape");
        assert_eq!((o.tiff, o.range), (TiffKind::Values, Some((1.0, 9.0))));
    }

    #[test]
    fn warns_only_without_an_epsg_code() {
        assert!(missing_crs_warning(Some(6677)).is_none());
        assert!(missing_crs_warning(None).is_some());
        assert!(missing_crs_warning(Some(40_000)).is_some());
    }
}
