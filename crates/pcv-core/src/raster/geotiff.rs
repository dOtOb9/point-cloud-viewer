use std::io::Write;

use crate::crs::is_geotiff_epsg_code;
use crate::raster::{GridSpec, RasterError};

const TYPE_ASCII: u16 = 2;
const TYPE_SHORT: u16 = 3;
const TYPE_LONG: u16 = 4;
const TYPE_DOUBLE: u16 = 12;

const STRIP_TARGET_BYTES: u64 = 64 * 1024;

const TAG_IMAGE_WIDTH: u16 = 256;
const TAG_IMAGE_LENGTH: u16 = 257;
const TAG_BITS_PER_SAMPLE: u16 = 258;
const TAG_COMPRESSION: u16 = 259;
const TAG_PHOTOMETRIC_INTERPRETATION: u16 = 262;
const TAG_STRIP_OFFSETS: u16 = 273;
const TAG_SAMPLES_PER_PIXEL: u16 = 277;
const TAG_ROWS_PER_STRIP: u16 = 278;
const TAG_STRIP_BYTE_COUNTS: u16 = 279;
const TAG_PLANAR_CONFIGURATION: u16 = 284;
const TAG_EXTRA_SAMPLES: u16 = 338;
const TAG_SAMPLE_FORMAT: u16 = 339;
const TAG_MODEL_PIXEL_SCALE: u16 = 33550;
const TAG_MODEL_TIEPOINT: u16 = 33922;
const TAG_GEO_KEY_DIRECTORY: u16 = 34735;
const TAG_GDAL_NODATA: u16 = 42113;

const COMPRESSION_NONE: u16 = 1;
const PLANAR_CONFIGURATION_CHUNKY: u16 = 1;
const EXTRA_SAMPLES_UNASSOCIATED_ALPHA: u16 = 2;
const SAMPLE_FORMAT_UNSIGNED_INTEGER: u16 = 1;
const SAMPLE_FORMAT_IEEE_FLOAT: u16 = 3;
const PHOTOMETRIC_BLACK_IS_ZERO: u16 = 1;
const PHOTOMETRIC_RGB: u16 = 2;

const GEO_KEY_DIRECTORY_VERSION: u16 = 1;
const GEO_KEY_REVISION: u16 = 1;
const GEO_KEY_MINOR_REVISION: u16 = 0;
const GEO_KEY_COUNT: u16 = 3;
const GEO_KEY_INLINE_VALUE: u16 = 0;
const ONE_VALUE: u16 = 1;
const GT_MODEL_TYPE_GEO_KEY: u16 = 1024;
const GT_RASTER_TYPE_GEO_KEY: u16 = 1025;
const PROJECTED_CS_TYPE_GEO_KEY: u16 = 3072;
const MODEL_TYPE_PROJECTED: u16 = 1;
const RASTER_PIXEL_IS_AREA: u16 = 1;

const NO_NEXT_IFD: u32 = 0;

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

struct PixelFormat {
    samples_per_pixel: u16,
    bits_per_sample: u16,
    sample_format: u16,
    photometric: u16,
    has_alpha: bool,
}

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
        sample_format: SAMPLE_FORMAT_IEEE_FLOAT,
        photometric: PHOTOMETRIC_BLACK_IS_ZERO,
        has_alpha: false,
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

pub fn write_rgb_u16<W: Write>(
    out: &mut W,
    spec: &GridSpec,
    epsg: Option<u32>,
    pixels: impl Iterator<Item = Option<[u16; 3]>>,
) -> Result<(), RasterError> {
    let format = PixelFormat {
        samples_per_pixel: 4,
        bits_per_sample: 16,
        sample_format: SAMPLE_FORMAT_UNSIGNED_INTEGER,
        photometric: PHOTOMETRIC_RGB,
        has_alpha: true,
    };
    write_tiff(out, spec, epsg, &format, None, pixels, |p, buf| {
        let (rgb, alpha) = match p {
            Some(rgb) => (*rgb, u16::MAX),
            None => ([0, 0, 0], 0),
        };
        for c in rgb {
            buf.extend_from_slice(&c.to_le_bytes());
        }
        buf.extend_from_slice(&alpha.to_le_bytes());
    })
}

pub fn write_rgba_u8<W: Write>(
    out: &mut W,
    spec: &GridSpec,
    epsg: Option<u32>,
    pixels: impl Iterator<Item = [u8; 4]>,
) -> Result<(), RasterError> {
    let format = PixelFormat {
        samples_per_pixel: 4,
        bits_per_sample: 8,
        sample_format: SAMPLE_FORMAT_UNSIGNED_INTEGER,
        photometric: PHOTOMETRIC_RGB,
        has_alpha: true,
    };
    write_tiff(out, spec, epsg, &format, None, pixels, |p, buf| {
        buf.extend_from_slice(p)
    })
}

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
    let mut entries = vec![
        longs(TAG_IMAGE_WIDTH, &[spec.width]),
        longs(TAG_IMAGE_LENGTH, &[spec.height]),
        shorts(TAG_BITS_PER_SAMPLE, &vec![format.bits_per_sample; n]),
        shorts(TAG_COMPRESSION, &[COMPRESSION_NONE]),
        shorts(TAG_PHOTOMETRIC_INTERPRETATION, &[format.photometric]),
        longs(TAG_STRIP_OFFSETS, strip_offsets),
        shorts(TAG_SAMPLES_PER_PIXEL, &[format.samples_per_pixel]),
        longs(TAG_ROWS_PER_STRIP, &[rows_per_strip]),
        longs(TAG_STRIP_BYTE_COUNTS, strip_counts),
        shorts(TAG_PLANAR_CONFIGURATION, &[PLANAR_CONFIGURATION_CHUNKY]),
    ];
    if format.has_alpha {
        entries.push(shorts(
            TAG_EXTRA_SAMPLES,
            &[EXTRA_SAMPLES_UNASSOCIATED_ALPHA],
        ));
    }
    entries.extend([
        shorts(TAG_SAMPLE_FORMAT, &vec![format.sample_format; n]),
        doubles(
            TAG_MODEL_PIXEL_SCALE,
            &[spec.cell_size, spec.cell_size, 0.0],
        ),
        doubles(
            TAG_MODEL_TIEPOINT,
            &[0.0, 0.0, 0.0, spec.origin_x, spec.top_y(), 0.0],
        ),
    ]);
    if let Some(code) = epsg {
        entries.push(shorts(
            TAG_GEO_KEY_DIRECTORY,
            &[
                GEO_KEY_DIRECTORY_VERSION,
                GEO_KEY_REVISION,
                GEO_KEY_MINOR_REVISION,
                GEO_KEY_COUNT,
                GT_MODEL_TYPE_GEO_KEY,
                GEO_KEY_INLINE_VALUE,
                ONE_VALUE,
                MODEL_TYPE_PROJECTED,
                GT_RASTER_TYPE_GEO_KEY,
                GEO_KEY_INLINE_VALUE,
                ONE_VALUE,
                RASTER_PIXEL_IS_AREA,
                PROJECTED_CS_TYPE_GEO_KEY,
                GEO_KEY_INLINE_VALUE,
                ONE_VALUE,
                code as u16,
            ],
        ));
    }
    if let Some(text) = nodata_text {
        entries.push(ascii(TAG_GDAL_NODATA, text));
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
    if let Some(code) = epsg {
        if !is_geotiff_epsg_code(code) {
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

    out.write_all(b"II")?;
    out.write_all(&42u16.to_le_bytes())?;
    out.write_all(&8u32.to_le_bytes())?;

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
    out.write_all(&NO_NEXT_IFD.to_le_bytes())?;

    for e in &entries {
        if e.data.len() > 4 {
            out.write_all(&e.data)?;
            if e.data.len() % 2 == 1 {
                out.write_all(&[0])?;
            }
        }
    }

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
        assert!(d.get_tag_f64_vec(Tag::ModelTiepointTag).is_ok());
    }

    #[test]
    fn rgb_roundtrip() {
        let s = spec(3, 2);
        let pixels = (0..6u16).map(|i| (i != 4).then_some([i * 1000, 65_535 - i, i]));
        let mut out = Vec::new();
        write_rgb_u16(&mut out, &s, Some(6677), pixels).expect("write");
        let mut d = Decoder::new(Cursor::new(out)).expect("decoder");
        assert_eq!(d.dimensions().expect("dims"), (3, 2));
        match d.read_image().expect("image") {
            DecodingResult::U16(v) => {
                assert_eq!(v.len(), 24);
                assert_eq!(&v[0..4], &[0, 65_535, 0, 65_535]);
                assert_eq!(&v[16..20], &[0, 0, 0, 0]);
                assert_eq!(&v[20..24], &[5000, 65_530, 5, 65_535]);
            }
            other => panic!("unexpected sample type: {other:?}"),
        }
        assert!(d.find_tag(Tag::GdalNodata).expect("find").is_none());
        assert_eq!(
            d.get_tag_u32_vec(Tag::ExtraSamples).expect("extra"),
            vec![2]
        );
        assert_eq!(d.get_tag_u32(Tag::SamplesPerPixel).expect("spp"), 4);
    }

    #[test]
    fn rgba_u8_roundtrip_with_geo_tags() {
        let s = spec(3, 2);
        let pixels = (0..6u8).map(|i| {
            if i == 4 {
                [0, 0, 0, 0]
            } else {
                [i * 10, 255 - i, i, 255]
            }
        });
        let mut out = Vec::new();
        write_rgba_u8(&mut out, &s, Some(6677), pixels).expect("write");
        let mut d = Decoder::new(Cursor::new(out)).expect("decoder");
        assert_eq!(d.dimensions().expect("dims"), (3, 2));
        match d.read_image().expect("image") {
            DecodingResult::U8(v) => {
                assert_eq!(v.len(), 24);
                assert_eq!(&v[0..4], &[0, 255, 0, 255]);
                assert_eq!(&v[16..20], &[0, 0, 0, 0]);
                assert_eq!(&v[20..24], &[50, 250, 5, 255]);
            }
            other => panic!("unexpected sample type: {other:?}"),
        }
        assert_eq!(d.get_tag_u32(Tag::SamplesPerPixel).expect("spp"), 4);
        assert_eq!(
            d.get_tag_u32_vec(Tag::ExtraSamples).expect("extra"),
            vec![2]
        );
        assert_eq!(
            d.get_tag_f64_vec(Tag::ModelPixelScaleTag).expect("scale"),
            vec![0.5, 0.5, 0.0]
        );
        assert_eq!(
            d.get_tag_f64_vec(Tag::ModelTiepointTag).expect("tie"),
            vec![0.0, 0.0, 0.0, 1000.0, 2001.0, 0.0]
        );
        let keys = d
            .get_tag_u32_vec(Tag::GeoKeyDirectoryTag)
            .expect("geo keys");
        assert_eq!(keys[keys.len() - 1], 6677);
        assert!(d.find_tag(Tag::GdalNodata).expect("find").is_none());
    }

    #[test]
    fn many_strips_roundtrip() {
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
