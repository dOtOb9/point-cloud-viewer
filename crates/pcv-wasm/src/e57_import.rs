//! E57 reader for the Web conversion (R7, `TaskSheets/R7-web-ply-e57.md`).
//!
//! This is a COPY of `crates/pcv-convert/src/import/e57.rs`, rewritten in one way: the
//! original pushes points into a `visit` callback, but the Web converter is driven batch by
//! batch (`feed`), so here `next_point` returns one point per call. What the `e57` crate does
//! for us is the same (per-scan pose applied, spherical to Cartesian, intensity / colour
//! normalised to 0.0..1.0), see the long comment in the original for the details.
//!
//! Why copied instead of shared: see the comment on the `pcd-rs` dependency in
//! `crates/pcv-wasm/Cargo.toml`. A fix in one file must be made in the other.
//!
//! # The feed design: one iterator that lives across `feed` calls
//!
//! `E57Reader::pointcloud_simple` returns an iterator that borrows the reader. To keep that
//! iterator between two `feed` calls the struct has to hold both the reader and the iterator
//! that borrows it (a self-referential struct). The alternatives were:
//!
//! - Re-create the iterator in every `feed` and skip the points already consumed. The iterator
//!   has no seek: skipping decodes everything again from the start of the scan, so the whole
//!   conversion would be O(n^2) in the number of points. Not acceptable for large files.
//! - Run the whole conversion in one wasm call. Then the Worker cannot see a cancel message
//!   (messages are only handled between calls), so cancel would not work.
//!
//! So this file does the self-reference by hand, in the smallest way: the reader lives in a
//! `Box` that is turned into a raw pointer, and the iterator borrows it through that pointer
//! (`'static` lifetime, see `E57Stream::open_scan`). The two `unsafe` blocks are `open_scan`
//! and `Drop`; the SAFETY comments there say why they are sound. No extra crate is used.
//!
//! Cost: each point is decoded once (O(n) in total). Memory: the reader, the XML metadata of
//! the file and the e57 crate's own queue for the scan being read (one packet at a time);
//! nothing depends on the number of points.

use std::io::{Read, Seek};

use e57::{CartesianCoordinate, E57Reader, PointCloud, PointCloudReaderSimple};

use crate::point_file_import::RawPoint;

/// E57 opened from any `Read + Seek` (the browser `File` reader, or a `Cursor` in tests).
/// `'static` is needed because the iterator below borrows the boxed reader with a `'static`
/// lifetime (see `open_scan`).
pub(crate) struct E57Stream<R: Read + Seek + 'static> {
    /// The iterator over the scan being read. It borrows `*reader`, so it is declared first
    /// and `Drop` clears it before the reader is freed.
    points: Option<PointCloudReaderSimple<'static, R>>,
    /// Owned `Box<E57Reader<R>>` as a raw pointer (freed in `Drop`). A raw pointer, not a
    /// `Box`, so that moving `E57Stream` does not invalidate the borrow held by `points`.
    reader: *mut E57Reader<R>,
    pointclouds: Vec<PointCloud>,
    next_scan: usize,
    has_color: bool,
    declared_points: u64,
}

impl<R: Read + Seek + 'static> E57Stream<R> {
    pub(crate) fn open(source: R) -> Result<Self, String> {
        let reader = E57Reader::new(source).map_err(|e| format!("E57を開けない: {e}"))?;
        let pointclouds = reader.pointclouds();
        let has_color = pointclouds.iter().any(PointCloud::has_color);
        let declared_points = pointclouds.iter().map(|pc| pc.records).sum();
        Ok(Self {
            points: None,
            reader: Box::into_raw(Box::new(reader)),
            pointclouds,
            next_scan: 0,
            has_color,
            declared_points,
        })
    }

    pub(crate) fn has_color(&self) -> bool {
        self.has_color
    }

    /// The sum of `records` over all scans. `next_point` can yield fewer points: points with
    /// no valid Cartesian position (direction only, empty grid slots) are skipped.
    pub(crate) fn declared_point_count(&self) -> u64 {
        self.declared_points
    }

    /// Start reading the next scan, or return `false` when all scans are done.
    fn open_scan(&mut self) -> Result<bool, String> {
        let Some(pc) = self.pointclouds.get(self.next_scan) else {
            return Ok(false);
        };
        self.next_scan += 1;
        // SAFETY: `self.reader` comes from `Box::into_raw` in `open` and is freed only in
        // `Drop`, after `self.points` is cleared, so the reference is valid for as long as the
        // iterator exists. It is the only reference to the reader: this is the only place that
        // dereferences the pointer, and a new one is made only when `self.points` is `None`
        // (see `next_point`), so no two `&mut` are alive at the same time. The `'static` is a
        // lie that the drop order above makes harmless.
        let reader: &'static mut E57Reader<R> = unsafe { &mut *self.reader };
        let iter = reader
            .pointcloud_simple(pc)
            .map_err(|e| format!("E57のスキャンを開けない: {e}"))?;
        self.points = Some(iter);
        Ok(true)
    }

    /// The next valid point of the file (all scans in order), or `None` at the end.
    pub(crate) fn next_point(&mut self) -> Result<Option<RawPoint>, String> {
        loop {
            if self.points.is_none() && !self.open_scan()? {
                return Ok(None);
            }
            let Some(iter) = self.points.as_mut() else {
                return Ok(None);
            };
            let Some(point) = iter.next() else {
                // This scan is finished; go on with the next one.
                self.points = None;
                continue;
            };
            let point = point.map_err(|e| format!("E57の点を読めない: {e}"))?;
            // Pose and spherical to Cartesian are already applied by the crate's defaults.
            let CartesianCoordinate::Valid { x, y, z } = point.cartesian else {
                continue;
            };
            let color = point
                .color
                .map(|c| {
                    [
                        normalize_unit_to_u16(c.red),
                        normalize_unit_to_u16(c.green),
                        normalize_unit_to_u16(c.blue),
                    ]
                })
                .unwrap_or([0, 0, 0]);
            let intensity = point.intensity.map(normalize_unit_to_u16).unwrap_or(0);
            return Ok(Some(RawPoint {
                x,
                y,
                z,
                color,
                intensity,
            }));
        }
    }
}

impl<R: Read + Seek + 'static> Drop for E57Stream<R> {
    fn drop(&mut self) {
        // The iterator borrows the reader, so it must go first.
        self.points = None;
        // SAFETY: `self.reader` came from `Box::into_raw` in `open`, nothing borrows it any
        // more (the iterator was just dropped) and `Drop` runs once.
        drop(unsafe { Box::from_raw(self.reader) });
    }
}

/// The `e57` crate normalises intensity and colour to 0.0..=1.0 by default; map that to the
/// 16 bit range of LAS.
fn normalize_unit_to_u16(value: f32) -> u16 {
    (value.clamp(0.0, 1.0) * 65535.0).round() as u16
}

#[cfg(test)]
mod tests {
    use super::*;
    use e57::{
        E57Writer, Quaternion, Record, RecordDataType, RecordName, RecordValue, Transform,
        Translation,
    };
    use std::io::Cursor;

    /// Write the same two-scan file as `crates/pcv-convert/tests/import_e57.rs`: scan 1 has
    /// Cartesian points, colour (U8) and intensity (0..1000) with a translation; scan 2 has
    /// spherical coordinates only with a 90 degree rotation about Z plus a translation.
    fn write_two_scan_file(path: &std::path::Path) {
        let mut writer = E57Writer::from_file(path, "guid-root").expect("create e57 writer");

        let prototype1 = vec![
            Record::CARTESIAN_X_F64,
            Record::CARTESIAN_Y_F64,
            Record::CARTESIAN_Z_F64,
            Record::COLOR_RED_U8,
            Record::COLOR_GREEN_U8,
            Record::COLOR_BLUE_U8,
            Record {
                name: RecordName::Intensity,
                data_type: RecordDataType::Integer { min: 0, max: 1000 },
            },
        ];
        let mut pc1 = writer
            .add_pointcloud("guid-scan1", prototype1)
            .expect("scan1");
        pc1.set_transform(Some(Transform {
            rotation: Quaternion::default(),
            translation: Translation {
                x: 100.0,
                y: 200.0,
                z: 300.0,
            },
        }));
        let scan1: [(f64, f64, f64, i64, i64, i64, i64); 4] = [
            (0.0, 0.0, 0.0, 0, 0, 0, 0),
            (1.0, 0.0, 0.0, 255, 0, 0, 1000),
            (0.0, 1.0, 0.0, 128, 64, 32, 250),
            (0.0, 0.0, 1.0, 0, 255, 128, 999),
        ];
        for &(x, y, z, r, g, b, i) in &scan1 {
            pc1.add_point(vec![
                RecordValue::Double(x),
                RecordValue::Double(y),
                RecordValue::Double(z),
                RecordValue::Integer(r),
                RecordValue::Integer(g),
                RecordValue::Integer(b),
                RecordValue::Integer(i),
            ])
            .expect("add point");
        }
        pc1.finalize().expect("finalize scan1");

        let prototype2 = vec![
            Record::SPHERICAL_RANGE_F64,
            Record::SPHERICAL_AZIMUTH_F64,
            Record::SPHERICAL_ELEVATION_F64,
        ];
        let mut pc2 = writer
            .add_pointcloud("guid-scan2", prototype2)
            .expect("scan2");
        let h = std::f64::consts::FRAC_1_SQRT_2;
        pc2.set_transform(Some(Transform {
            rotation: Quaternion {
                w: h,
                x: 0.0,
                y: 0.0,
                z: h,
            },
            translation: Translation {
                x: 5.0,
                y: 5.0,
                z: 5.0,
            },
        }));
        pc2.add_point(vec![
            RecordValue::Double(10.0),
            RecordValue::Double(0.0),
            RecordValue::Double(0.0),
        ])
        .expect("add point");
        pc2.finalize().expect("finalize scan2");
        writer.finalize().expect("finalize e57");
    }

    fn read_file(path: &std::path::Path) -> Vec<u8> {
        std::fs::read(path).expect("read back the e57")
    }

    #[test]
    fn two_scans_are_merged_with_pose_spherical_conversion_and_normalisation() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("in.e57");
        write_two_scan_file(&path);

        let mut stream = E57Stream::open(Cursor::new(read_file(&path))).expect("open");
        assert!(stream.has_color(), "scan 1 has colour");
        assert_eq!(stream.declared_point_count(), 5);

        let mut points = Vec::new();
        while let Some(p) = stream.next_point().expect("next_point") {
            points.push(p);
        }
        assert_eq!(points.len(), 5);

        // Scan 1: local coordinate + translation (100, 200, 300). Colour 0..255 is normalised to
        // 0..1 and then scaled to 16 bit (so value * 257); intensity 0..1000 is scaled by 65.535.
        let expect = |p: &RawPoint, xyz: (f64, f64, f64), color: [u16; 3], intensity: u16| {
            assert!((p.x - xyz.0).abs() < 1e-9, "x {} vs {}", p.x, xyz.0);
            assert!((p.y - xyz.1).abs() < 1e-9, "y {} vs {}", p.y, xyz.1);
            assert!((p.z - xyz.2).abs() < 1e-9, "z {} vs {}", p.z, xyz.2);
            assert_eq!(p.color, color);
            assert_eq!(p.intensity, intensity);
        };
        expect(&points[0], (100.0, 200.0, 300.0), [0, 0, 0], 0);
        expect(&points[1], (101.0, 200.0, 300.0), [65535, 0, 0], 65535);
        expect(
            &points[2],
            (100.0, 201.0, 300.0),
            [32896, 16448, 8224],
            16384,
        );
        expect(&points[3], (100.0, 200.0, 301.0), [0, 65535, 32896], 65469);
        // Scan 2: local (10, 0, 0), rotated to (0, 10, 0), plus (5, 5, 5). No colour, no intensity.
        expect(&points[4], (5.0, 15.0, 5.0), [0, 0, 0], 0);
    }

    /// 20_000 points in one scan, read in small batches through the iterator that lives across
    /// calls. Checks that every point comes out exactly once and in order (so the long-lived
    /// iterator keeps its position), and that dropping the stream half way is fine
    /// (the `Drop` order).
    #[test]
    fn long_lived_iterator_keeps_position_and_drops_cleanly() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("big.e57");
        let count = 20_000u32;
        {
            let mut writer = E57Writer::from_file(&path, "guid-root").expect("writer");
            let mut pc = writer
                .add_pointcloud(
                    "guid-scan",
                    vec![
                        Record::CARTESIAN_X_F32,
                        Record::CARTESIAN_Y_F32,
                        Record::CARTESIAN_Z_F32,
                    ],
                )
                .expect("scan");
            for i in 0..count {
                pc.add_point(vec![
                    RecordValue::Single(i as f32),
                    RecordValue::Single(0.0),
                    RecordValue::Single(0.0),
                ])
                .expect("add point");
            }
            pc.finalize().expect("finalize scan");
            writer.finalize().expect("finalize e57");
        }
        let bytes = read_file(&path);

        // Read everything in batches of 777 (like `feed`); a batch never holds more than 777.
        let mut stream = E57Stream::open(Cursor::new(bytes.clone())).expect("open");
        let mut next_expected = 0u32;
        loop {
            let mut batch = Vec::new();
            while batch.len() < 777 {
                match stream.next_point().expect("next_point") {
                    Some(p) => batch.push(p),
                    None => break,
                }
            }
            for p in &batch {
                assert_eq!(p.x, f64::from(next_expected));
                next_expected += 1;
            }
            if batch.len() < 777 {
                break;
            }
        }
        assert_eq!(next_expected, count);

        // Drop in the middle of a scan: the iterator must be released before the reader.
        let mut partial = E57Stream::open(Cursor::new(bytes)).expect("open");
        for _ in 0..100 {
            assert!(partial.next_point().expect("next_point").is_some());
        }
        drop(partial);
    }

    #[test]
    fn garbage_is_an_error_not_a_panic() {
        assert!(E57Stream::open(Cursor::new(b"not an e57 file at all".to_vec())).is_err());
    }
}
