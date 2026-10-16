//! The point record kept in the spill and in the LOD runs (L3-C).
//!
//! Before L3-C a record was the generic `copc_core::serialize_le` form: 57
//! bytes for point format 3 with RGB, with x, y, z as three f64 and one byte
//! per flag. Now a record is the point as the output COPC stores it, with
//! nothing the output cannot hold:
//!
//! ```text
//! [ x y z ][ body ]
//!   body = intensity u16, return numbers u8 (4+4 bits), flags u8,
//!          classification u8, user data u8, scan angle i16 (0.006 degree
//!          steps), point source id u16, GPS time f64, RGB 3 x u16 (only
//!          when the output has colour), extra bytes
//! ```
//!
//! `body` is byte for byte the LAS point record (PDRF 6/7) from byte 12 on,
//! so the nodes need no re-encoding. x, y, z come in two forms:
//!
//! - **Quantized** (`transform` is `Some`): three i32, exactly the integers
//!   the output stores (12 bytes). The whole record is then the output's
//!   point record: 30 bytes (PDRF 6) or 36 bytes (PDRF 7) plus extra bytes.
//!   This needs the output's scale and offset before the first point is
//!   written (`SpillWriter::create`).
//! - **Wide** (`transform` is `None`): three f64 (24 bytes), for the paths
//!   that choose the offset after they have seen all points (E57/PLY/PCD
//!   import). The coordinates are quantized when the nodes are encoded.
//!
//! The octree is built from `RecordFormat::xyz`. For quantized records that
//! is `scale * i + offset`, which is the value the output stores, so a point
//! near the plane between two octants is placed by its output coordinate.

use copc_core::{Error, Result, StreamingLayout};
use las::point::Format as LasFormat;

/// Bytes of x, y, z in a LAS point record (three i32).
pub(crate) const LAS_XYZ_BYTES: usize = 12;
/// Bytes of x, y, z in a wide record (three f64).
const WIDE_XYZ_BYTES: usize = 24;

/// The LAS scale and offset of the output file.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LasTransform {
    pub scale: (f64, f64, f64),
    pub offset: (f64, f64, f64),
}

/// The LAS point format the output uses for `layout`: PDRF 7 with colour,
/// else PDRF 6, plus the layout's extra bytes.
pub(crate) fn output_point_format(layout: &StreamingLayout) -> Result<LasFormat> {
    let id = if layout.has_color { 7u8 } else { 6u8 };
    let mut format = LasFormat::new(id).map_err(|e| Error::Las(format!("point format: {e}")))?;
    format.extra_bytes = layout.extra_bytes;
    Ok(format)
}

/// How the records of one spill (and all runs made from it) are laid out.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct RecordFormat {
    transform: Option<LasTransform>,
    /// Bytes of the output's LAS point record (x, y, z included).
    las_len: usize,
}

impl RecordFormat {
    pub(crate) fn new(layout: &StreamingLayout, transform: Option<LasTransform>) -> Result<Self> {
        let format = output_point_format(layout)?;
        Ok(Self {
            transform,
            las_len: usize::from(format.len()),
        })
    }

    pub(crate) fn transform(&self) -> Option<LasTransform> {
        self.transform
    }

    /// Bytes of the x, y, z part of a record.
    pub(crate) fn xyz_bytes(&self) -> usize {
        match self.transform {
            Some(_) => LAS_XYZ_BYTES,
            None => WIDE_XYZ_BYTES,
        }
    }

    /// Bytes of one record.
    pub(crate) fn width(&self) -> usize {
        self.xyz_bytes() + (self.las_len - LAS_XYZ_BYTES)
    }

    /// The position of a record; `record` holds at least `xyz_bytes()` bytes.
    #[inline]
    pub(crate) fn xyz(&self, record: &[u8]) -> (f64, f64, f64) {
        match self.transform {
            Some(t) => {
                let axis = |at: usize, scale: f64, offset: f64| {
                    let raw = i32::from_le_bytes([
                        record[at],
                        record[at + 1],
                        record[at + 2],
                        record[at + 3],
                    ]);
                    scale * f64::from(raw) + offset
                };
                (
                    axis(0, t.scale.0, t.offset.0),
                    axis(4, t.scale.1, t.offset.1),
                    axis(8, t.scale.2, t.offset.2),
                )
            }
            None => {
                let axis = |at: usize| {
                    f64::from_le_bytes([
                        record[at],
                        record[at + 1],
                        record[at + 2],
                        record[at + 3],
                        record[at + 4],
                        record[at + 5],
                        record[at + 6],
                        record[at + 7],
                    ])
                };
                (axis(0), axis(8), axis(16))
            }
        }
    }

    /// The part of a record after x, y, z.
    #[inline]
    pub(crate) fn body<'a>(&self, record: &'a [u8]) -> &'a [u8] {
        &record[self.xyz_bytes()..]
    }

    /// Writes the wide x, y, z of a record (only for wide records).
    pub(crate) fn write_wide_xyz(record: &mut [u8], x: f64, y: f64, z: f64) {
        record[0..8].copy_from_slice(&x.to_le_bytes());
        record[8..16].copy_from_slice(&y.to_le_bytes());
        record[16..24].copy_from_slice(&z.to_le_bytes());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn layout(has_color: bool, extra_bytes: u16) -> StreamingLayout {
        StreamingLayout {
            point_format: 3,
            has_gps: true,
            has_color,
            has_nir: false,
            has_waveform: false,
            extra_bytes,
            extra_bytes_descriptors: Vec::new(),
        }
    }

    fn transform() -> LasTransform {
        LasTransform {
            scale: (0.01, 0.01, 0.001),
            offset: (100.0, 200.0, 0.0),
        }
    }

    /// The sizes the docs and the benchmark notes quote.
    #[test]
    fn record_widths() {
        let quantized = |color, extra| {
            RecordFormat::new(&layout(color, extra), Some(transform()))
                .unwrap()
                .width()
        };
        assert_eq!(quantized(false, 0), 30);
        assert_eq!(quantized(true, 0), 36);
        assert_eq!(quantized(true, 4), 40);
        let wide = RecordFormat::new(&layout(true, 0), None).unwrap();
        assert_eq!(wide.width(), 48);
        assert_eq!(wide.xyz_bytes(), 24);
    }

    #[test]
    fn quantized_xyz_is_scale_times_integer_plus_offset() {
        let format = RecordFormat::new(&layout(true, 0), Some(transform())).unwrap();
        let mut record = vec![0u8; format.width()];
        record[0..4].copy_from_slice(&(-5i32).to_le_bytes());
        record[4..8].copy_from_slice(&7i32.to_le_bytes());
        record[8..12].copy_from_slice(&123_456i32.to_le_bytes());
        assert_eq!(
            format.xyz(&record),
            (
                0.01 * f64::from(-5) + 100.0,
                0.01 * f64::from(7) + 200.0,
                0.001 * f64::from(123_456)
            )
        );
    }

    #[test]
    fn wide_xyz_round_trips() {
        let format = RecordFormat::new(&layout(false, 0), None).unwrap();
        let mut record = vec![0u8; format.width()];
        RecordFormat::write_wide_xyz(&mut record, 1.25, -2.5e9, 3.0e-7);
        assert_eq!(format.xyz(&record), (1.25, -2.5e9, 3.0e-7));
    }
}
