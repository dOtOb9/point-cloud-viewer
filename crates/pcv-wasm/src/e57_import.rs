use std::io::{Read, Seek};

use e57::{CartesianCoordinate, E57Reader, PointCloud, PointCloudReaderSimple};

use crate::point_file_import::RawPoint;

pub(crate) struct E57Stream<R: Read + Seek + 'static> {
    points: Option<PointCloudReaderSimple<'static, R>>,
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

    pub(crate) fn declared_point_count(&self) -> u64 {
        self.declared_points
    }

    fn open_scan(&mut self) -> Result<bool, String> {
        let Some(pc) = self.pointclouds.get(self.next_scan) else {
            return Ok(false);
        };
        self.next_scan += 1;
        // SAFETY: `self.reader` is from `Box::into_raw` in `open`, freed only in `Drop` after `self.points` is cleared, and dereferenced only here while `self.points` is `None`, so this `&mut` is the only one and outlives the iterator.
        let reader: &'static mut E57Reader<R> = unsafe { &mut *self.reader };
        let iter = reader
            .pointcloud_simple(pc)
            .map_err(|e| format!("E57のスキャンを開けない: {e}"))?;
        self.points = Some(iter);
        Ok(true)
    }

    pub(crate) fn next_point(&mut self) -> Result<Option<RawPoint>, String> {
        loop {
            if self.points.is_none() && !self.open_scan()? {
                return Ok(None);
            }
            let Some(iter) = self.points.as_mut() else {
                return Ok(None);
            };
            let Some(point) = iter.next() else {
                self.points = None;
                continue;
            };
            let point = point.map_err(|e| format!("E57の点を読めない: {e}"))?;
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
        self.points = None;
        // SAFETY: `self.reader` came from `Box::into_raw` in `open`, the iterator that borrowed it was just dropped, and `Drop` runs once.
        drop(unsafe { Box::from_raw(self.reader) });
    }
}

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
        expect(&points[4], (5.0, 15.0, 5.0), [0, 0, 0], 0);
    }

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

        let mut partial = E57Stream::open(Cursor::new(bytes)).expect("open");
        for _ in 0..100 {
            assert!(partial.next_point().expect("next_point").is_some());
        }
        drop(partial);
    }

    #[test]
    #[ignore = "writes the E57 fixture for the Web E2E; run with PCV_E57_FIXTURE set"]
    fn write_e57_fixture_for_e2e() {
        let Ok(path) = std::env::var("PCV_E57_FIXTURE") else {
            panic!("set PCV_E57_FIXTURE to the output path");
        };
        let mut writer = E57Writer::from_file(&path, "guid-root").expect("writer");
        let mut pc = writer
            .add_pointcloud(
                "guid-scan",
                vec![
                    Record::CARTESIAN_X_F64,
                    Record::CARTESIAN_Y_F64,
                    Record::CARTESIAN_Z_F64,
                    Record::COLOR_RED_U8,
                    Record::COLOR_GREEN_U8,
                    Record::COLOR_BLUE_U8,
                ],
            )
            .expect("scan");
        for i in 0..2000i64 {
            pc.add_point(vec![
                RecordValue::Double(((i * 37) % 500) as f64 * 0.1),
                RecordValue::Double(((i * 53) % 500) as f64 * 0.1),
                RecordValue::Double(((i * 13) % 200) as f64 * 0.1),
                RecordValue::Integer(i % 256),
                RecordValue::Integer((i * 3) % 256),
                RecordValue::Integer((i * 7) % 256),
            ])
            .expect("add point");
        }
        pc.finalize().expect("finalize scan");
        writer.finalize().expect("finalize e57");
    }

    #[test]
    fn garbage_is_an_error_not_a_panic() {
        assert!(E57Stream::open(Cursor::new(b"not an e57 file at all".to_vec())).is_err());
    }
}
