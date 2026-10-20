//! G1-2: a small hand-written GeoTIFF writer.
//!
//! Why hand-written (plan `TaskSheets/G1-raster-and-dtm.md`, section 3): the GeoTIFF
//! tags would have to be written through a generic tag API anyway, and the file is
//! simple: classic TIFF (not BigTIFF), little-endian, **uncompressed**, stored in
//! strips. Reading the whole writer takes one sitting, and `tiff` is used only by the
//! tests to read the result back.
//!
//! # File layout
//!
//! ```text
//! 8-byte header | IFD (the tag table) | out-of-line tag values | strips of pixels
//! ```
//!
//! Every offset is known before anything is written (the tag table has a fixed size
//! and the pixel data comes last), so the writer only goes forward and works with any
//! `std::io::Write` (a file, a `Vec<u8>`, a download buffer). The pixels are taken
//! from an iterator and written one strip (about 64 KiB) at a time, so **no second
//! full copy of the image is built**.
//!
//! # Georeferencing
//!
//! - `ModelPixelScaleTag` (33550): `(cell, cell, 0)`.
//! - `ModelTiepointTag` (33922): ties pixel `(0, 0, 0)` to `(origin_x, top_y, 0)`.
//!   Pixel `(0, 0)` is the top-left (north-west) cell and the raster type is
//!   PixelIsArea, so that is the top-left *corner* of the cell, as `GridSpec` has it.
//! - `GeoKeyDirectoryTag` (34735) is written only when the caller has an EPSG code:
//!   `GTModelType = 1` (projected), `GTRasterType = 1` (PixelIsArea) and
//!   `ProjectedCSTypeGeoKey = epsg`. Without a code no CRS keys are written (a
//!   "projected" model type with no CRS would claim more than we know); the caller is
//!   expected to warn.
//! - `GDAL_NODATA` (42113, ASCII) for the float form.

use std::io::Write;

use crate::raster::{GridSpec, RasterError};

const TYPE_ASCII: u16 = 2;
const TYPE_SHORT: u16 = 3;
const TYPE_LONG: u16 = 4;
const TYPE_DOUBLE: u16 = 12;

/// Target size of one strip in bytes. The writer holds one strip at a time.
const STRIP_TARGET_BYTES: u64 = 64 * 1024;

/// One IFD entry. `data` is the value already in little-endian bytes.
struct Entry {
    tag: u16,
    field_type: u16,
    count: u32,
    data: Vec<u8>,
}

fn shorts(tag: u16, values: &[u16]) -> Entry {
    Entry {
        tag,
        field_type: TYPE_SHORT,
        count: values.len() as u32,
        data: values.iter().flat_map(|v| v.to_le_bytes()).collect(),
    }
}

fn longs(tag: u16, values: &[u32]) -> Entry {
    Entry {
        tag,
        field_type: TYPE_LONG,
        count: values.len() as u32,
        data: values.iter().flat_map(|v| v.to_le_bytes()).collect(),
    }
}

fn doubles(tag: u16, values: &[f64]) -> Entry {
    Entry {
        tag,
        field_type: TYPE_DOUBLE,
        count: values.len() as u32,
        data: values.iter().flat_map(|v| v.to_le_bytes()).collect(),
    }
}

/// ASCII value, with the terminating NUL TIFF requires.
fn ascii(tag: u16, text: &str) -> Entry {
    let mut data = text.as_bytes().to_vec();
    data.push(0);
    Entry {
        tag,
        field_type: TYPE_ASCII,
        count: data.len() as u32,
        data,
    }
}

/// What differs between the two forms.
struct PixelFormat {
    samples_per_pixel: u16,
    bits_per_sample: u16,
    /// 3 = IEEE float, 1 = unsigned integer.
    sample_format: u16,
    /// 1 = BlackIsZero (single band), 2 = RGB.
    photometric: u16,
}

/// Writes a single-band float32 GeoTIFF. `values` is every cell in image order (row 0
/// = north, see `grid`), `width * height` of them. Empty cells should already hold
/// `nodata`, which is also written to the `GDAL_NODATA` tag.
pub fn write_f32<W: Write>(
    out: &mut W,
    spec: &GridSpec,
    epsg: Option<u32>,
    nodata: f32,
    values: impl Iterator<Item = f32>,
) -> Result<(), RasterError> {
    if !nodata.is_finite() {
        return Err(RasterError::InvalidArgument(
            "NoDataの値は有限の数にしてください".to_string(),
        ));
    }
    let format = PixelFormat {
        samples_per_pixel: 1,
        bits_per_sample: 32,
        sample_format: 3,
        photometric: 1,
    };
    let nodata_text = format!("{nodata}");
    write_tiff(
        out,
        spec,
        epsg,
        &format,
        Some(&nodata_text),
        values,
        |v, buf| buf.extend_from_slice(&v.to_le_bytes()),
    )
}

/// Writes a 3-band u16 RGB GeoTIFF (no NoData tag). `pixels` is every cell in image order.
pub fn write_rgb_u16<W: Write>(
    out: &mut W,
    spec: &GridSpec,
    epsg: Option<u32>,
    pixels: impl Iterator<Item = [u16; 3]>,
) -> Result<(), RasterError> {
    let format = PixelFormat {
        samples_per_pixel: 3,
        bits_per_sample: 16,
        sample_format: 1,
        photometric: 2,
    };
    write_tiff(out, spec, epsg, &format, None, pixels, |p, buf| {
        for c in p {
            buf.extend_from_slice(&c.to_le_bytes());
        }
    })
}

/// The tag table. `strip_offsets` / `strip_counts` are one entry per strip.
fn build_entries(
    spec: &GridSpec,
    epsg: Option<u32>,
    format: &PixelFormat,
    nodata_text: Option<&str>,
    rows_per_strip: u32,
    strip_offsets: &[u32],
    strip_counts: &[u32],
) -> Vec<Entry> {
    let n = usize::from(format.samples_per_pixel);
    // Tags must be in ascending order in a TIFF IFD.
    let mut entries = vec![
        longs(256, &[spec.width]),                              // ImageWidth
        longs(257, &[spec.height]),                             // ImageLength
        shorts(258, &vec![format.bits_per_sample; n]),          // BitsPerSample
        shorts(259, &[1]),                                      // Compression: none
        shorts(262, &[format.photometric]),                     // PhotometricInterpretation
        longs(273, strip_offsets),                              // StripOffsets
        shorts(277, &[format.samples_per_pixel]),               // SamplesPerPixel
        longs(278, &[rows_per_strip]),                          // RowsPerStrip
        longs(279, strip_counts),                               // StripByteCounts
        shorts(284, &[1]),                                      // PlanarConfiguration: chunky
        shorts(339, &vec![format.sample_format; n]),            // SampleFormat
        doubles(33550, &[spec.cell_size, spec.cell_size, 0.0]), // ModelPixelScaleTag
        doubles(33922, &[0.0, 0.0, 0.0, spec.origin_x, spec.top_y(), 0.0]), // ModelTiepointTag
    ];
    if let Some(code) = epsg {
        // Header (version 1.0.0, 3 keys), then key = (id, location 0 = inline, count 1, value).
        entries.push(shorts(
            34735,
            &[
                1,
                1,
                0,
                3, //
                1024,
                0,
                1,
                1, // GTModelTypeGeoKey = ModelTypeProjected
                1025,
                0,
                1,
                1, // GTRasterTypeGeoKey = RasterPixelIsArea
                3072,
                0,
                1,
                code as u16, // ProjectedCSTypeGeoKey
            ],
        ));
    }
    if let Some(text) = nodata_text {
        entries.push(ascii(42113, text)); // GDAL_NODATA
    }
    entries
}

fn write_tiff<W: Write, S>(
    out: &mut W,
    spec: &GridSpec,
    epsg: Option<u32>,
    format: &PixelFormat,
    nodata_text: Option<&str>,
    mut samples: impl Iterator<Item = S>,
    encode: impl Fn(&S, &mut Vec<u8>),
) -> Result<(), RasterError> {
    // ProjectedCSTypeGeoKey is a SHORT: 0 and 32767 ("user defined") are not EPSG codes.
    if let Some(code) = epsg {
        if code == 0 || code >= 32767 {
            return Err(RasterError::InvalidArgument(format!(
                "EPSGコード {code} はGeoTIFFに書けません"
            )));
        }
    }
    if spec.width == 0 || spec.height == 0 {
        return Err(RasterError::InvalidArgument(
            "画像の大きさが0です".to_string(),
        ));
    }

    let bytes_per_pixel =
        u64::from(format.samples_per_pixel) * u64::from(format.bits_per_sample) / 8;
    let row_bytes = u64::from(spec.width) * bytes_per_pixel;
    let image_bytes = row_bytes * u64::from(spec.height);
    let rows_per_strip = (STRIP_TARGET_BYTES / row_bytes).clamp(1, u64::from(spec.height)) as u32;
    let strip_count = spec.height.div_ceil(rows_per_strip) as usize;

    // First pass with zero offsets only to measure the layout (sizes do not depend on
    // the offset values); the second pass has the real ones.
    let zeros = vec![0u32; strip_count];
    let measure = build_entries(
        spec,
        epsg,
        format,
        nodata_text,
        rows_per_strip,
        &zeros,
        &zeros,
    );
    let ifd_size = 2 + measure.len() as u64 * 12 + 4;
    let mut extra_bytes = 0u64;
    for e in &measure {
        if e.data.len() > 4 {
            extra_bytes += (e.data.len() as u64).next_multiple_of(2);
        }
    }
    let extra_start = 8 + ifd_size;
    let image_start = extra_start + extra_bytes;
    if image_start + image_bytes > u64::from(u32::MAX) {
        return Err(RasterError::TooLargeForTiff);
    }

    let mut strip_offsets = Vec::with_capacity(strip_count);
    let mut strip_counts = Vec::with_capacity(strip_count);
    for s in 0..strip_count as u64 {
        let first_row = s * u64::from(rows_per_strip);
        let rows = u64::from(rows_per_strip).min(u64::from(spec.height) - first_row);
        strip_offsets.push((image_start + first_row * row_bytes) as u32);
        strip_counts.push((rows * row_bytes) as u32);
    }
    let entries = build_entries(
        spec,
        epsg,
        format,
        nodata_text,
        rows_per_strip,
        &strip_offsets,
        &strip_counts,
    );

    // Header: little-endian, magic 42, the IFD follows right after the header.
    out.write_all(b"II")?;
    out.write_all(&42u16.to_le_bytes())?;
    out.write_all(&8u32.to_le_bytes())?;

    // IFD.
    out.write_all(&(entries.len() as u16).to_le_bytes())?;
    let mut next_extra = extra_start;
    for e in &entries {
        out.write_all(&e.tag.to_le_bytes())?;
        out.write_all(&e.field_type.to_le_bytes())?;
        out.write_all(&e.count.to_le_bytes())?;
        if e.data.len() <= 4 {
            let mut inline = [0u8; 4];
            inline[..e.data.len()].copy_from_slice(&e.data);
            out.write_all(&inline)?;
        } else {
            out.write_all(&(next_extra as u32).to_le_bytes())?;
            next_extra += (e.data.len() as u64).next_multiple_of(2);
        }
    }
    out.write_all(&0u32.to_le_bytes())?; // no next IFD

    // Out-of-line values, in the same order as the offsets above.
    for e in &entries {
        if e.data.len() > 4 {
            out.write_all(&e.data)?;
            if e.data.len() % 2 == 1 {
                out.write_all(&[0])?;
            }
        }
    }

    // Pixels, one strip at a time.
    let mut buf: Vec<u8> = Vec::with_capacity(STRIP_TARGET_BYTES as usize + row_bytes as usize);
    let mut written = 0u64;
    let total = u64::from(spec.width) * u64::from(spec.height);
    for &count in &strip_counts {
        buf.clear();
        let pixels_in_strip = u64::from(count) / bytes_per_pixel;
        for _ in 0..pixels_in_strip {
            let Some(sample) = samples.next() else {
                return Err(RasterError::SampleCountMismatch {
                    expected: total,
                    actual: written,
                });
            };
            encode(&sample, &mut buf);
            written += 1;
        }
        out.write_all(&buf)?;
    }
    if samples.next().is_some() {
        return Err(RasterError::SampleCountMismatch {
            expected: total,
            actual: total + 1,
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use tiff::decoder::{Decoder, DecodingResult};
    use tiff::tags::Tag;

    fn spec(width: u32, height: u32) -> GridSpec {
        GridSpec {
            origin_x: 1000.0,
            origin_y: 2000.0,
            cell_size: 0.5,
            width,
            height,
        }
    }

    fn f32_image(spec: &GridSpec, epsg: Option<u32>) -> Vec<u8> {
        let values = (0..spec.width * spec.height).map(|i| {
            if i == 3 {
                crate::raster::NODATA
            } else {
                i as f32 * 0.25
            }
        });
        let mut out = Vec::new();
        write_f32(&mut out, spec, epsg, crate::raster::NODATA, values).expect("write");
        out
    }

    #[test]
    fn f32_roundtrip_values_and_nodata_tag() {
        let s = spec(7, 5);
        let bytes = f32_image(&s, Some(6677));
        let mut d = Decoder::new(Cursor::new(bytes)).expect("decoder");
        assert_eq!(d.dimensions().expect("dims"), (7, 5));
        match d.read_image().expect("image") {
            DecodingResult::F32(v) => {
                assert_eq!(v.len(), 35);
                assert_eq!(v[0], 0.0);
                assert_eq!(v[3], -9999.0);
                assert_eq!(v[34], 34.0 * 0.25);
            }
            other => panic!("unexpected sample type: {other:?}"),
        }
        let nodata = d.get_tag_ascii_string(Tag::GdalNodata).expect("nodata tag");
        assert_eq!(nodata, "-9999");
    }

    #[test]
    fn geo_tags_have_the_expected_values() {
        let s = spec(7, 5);
        let bytes = f32_image(&s, Some(6677));
        let mut d = Decoder::new(Cursor::new(bytes)).expect("decoder");
        let scale = d
            .get_tag_f64_vec(Tag::ModelPixelScaleTag)
            .expect("pixel scale");
        assert_eq!(scale, vec![0.5, 0.5, 0.0]);
        let tie = d.get_tag_f64_vec(Tag::ModelTiepointTag).expect("tiepoint");
        // Top-left corner: x = origin_x, y = origin_y + height * cell = 2000 + 5 * 0.5.
        assert_eq!(tie, vec![0.0, 0.0, 0.0, 1000.0, 2002.5, 0.0]);
        let keys = d
            .get_tag_u32_vec(Tag::GeoKeyDirectoryTag)
            .expect("geo keys");
        assert_eq!(
            keys,
            vec![1, 1, 0, 3, 1024, 0, 1, 1, 1025, 0, 1, 1, 3072, 0, 1, 6677]
        );
    }

    #[test]
    fn no_epsg_writes_no_geo_key_directory() {
        let s = spec(4, 4);
        let bytes = f32_image(&s, None);
        let mut d = Decoder::new(Cursor::new(bytes)).expect("decoder");
        assert!(d.find_tag(Tag::GeoKeyDirectoryTag).expect("find").is_none());
        // The position tags are still there.
        assert!(d.get_tag_f64_vec(Tag::ModelTiepointTag).is_ok());
    }

    #[test]
    fn rgb_roundtrip() {
        let s = spec(3, 2);
        let pixels = (0..6u16).map(|i| [i * 1000, 65_535 - i, i]);
        let mut out = Vec::new();
        write_rgb_u16(&mut out, &s, Some(6677), pixels).expect("write");
        let mut d = Decoder::new(Cursor::new(out)).expect("decoder");
        assert_eq!(d.dimensions().expect("dims"), (3, 2));
        match d.read_image().expect("image") {
            DecodingResult::U16(v) => {
                assert_eq!(v.len(), 18);
                assert_eq!(&v[0..3], &[0, 65_535, 0]);
                assert_eq!(&v[15..18], &[5000, 65_530, 5]);
            }
            other => panic!("unexpected sample type: {other:?}"),
        }
        assert!(d.find_tag(Tag::GdalNodata).expect("find").is_none());
    }

    #[test]
    fn many_strips_roundtrip() {
        // Wide enough that one strip holds a single row (row = 20 000 * 4 B > 64 KiB / 2),
        // so there are many strips and the last one is checked too.
        let s = spec(20_000, 5);
        let values = (0..s.width * s.height).map(|i| i as f32);
        let mut out = Vec::new();
        write_f32(&mut out, &s, None, -1.0, values).expect("write");
        let mut d = Decoder::new(Cursor::new(out)).expect("decoder");
        match d.read_image().expect("image") {
            DecodingResult::F32(v) => {
                assert_eq!(v.len(), 100_000);
                assert_eq!(v[99_999], 99_999.0);
                assert_eq!(v[20_000], 20_000.0);
            }
            other => panic!("unexpected sample type: {other:?}"),
        }
    }

    #[test]
    fn wrong_number_of_samples_is_an_error() {
        let s = spec(4, 4);
        let mut out = Vec::new();
        let few = write_f32(&mut out, &s, None, -1.0, (0..10).map(|i| i as f32));
        assert!(matches!(few, Err(RasterError::SampleCountMismatch { .. })));
        let mut out = Vec::new();
        let many = write_f32(&mut out, &s, None, -1.0, (0..17).map(|i| i as f32));
        assert!(matches!(many, Err(RasterError::SampleCountMismatch { .. })));
    }

    #[test]
    fn refuses_images_that_do_not_fit_classic_tiff() {
        // 40 000 x 40 000 x 4 B = 6.4 GB. The check happens before any pixel is read.
        let s = spec(40_000, 40_000);
        let mut out = Vec::new();
        let r = write_f32(&mut out, &s, None, -1.0, std::iter::empty());
        assert!(matches!(r, Err(RasterError::TooLargeForTiff)));
        assert!(out.is_empty(), "nothing is written when refusing");
    }

    #[test]
    fn rejects_bad_epsg_and_nodata() {
        let s = spec(2, 2);
        let mut out = Vec::new();
        assert!(write_f32(&mut out, &s, Some(0), -1.0, (0..4).map(|i| i as f32)).is_err());
        assert!(write_f32(&mut out, &s, Some(70_000), -1.0, (0..4).map(|i| i as f32)).is_err());
        assert!(write_f32(&mut out, &s, None, f32::NAN, (0..4).map(|i| i as f32)).is_err());
    }
}
