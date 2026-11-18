mod common;

use copc_core::NeverCancel;
use copc_writer::CopcWriterParams;
use e57::{
    E57Writer, Quaternion, Record, RecordDataType, RecordName, RecordValue, Transform, Translation,
};
use pcv_convert::import::convert_path_to_copc;

#[test]
fn combines_multiple_scans_applying_pose_and_spherical_conversion() {
    let dir = tempfile::tempdir().expect("tempdir");
    let input_path = dir.path().join("in.e57");
    let output_path = dir.path().join("out.copc.laz");

    let mut writer = E57Writer::from_file(&input_path, "guid-root").expect("create e57 writer");

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
        .expect("add scan1");
    pc1.set_transform(Some(Transform {
        rotation: Quaternion::default(),
        translation: Translation {
            x: 100.0,
            y: 200.0,
            z: 300.0,
        },
    }));

    let scan1_points: [(f64, f64, f64, i64, i64, i64, i64); 4] = [
        (0.0, 0.0, 0.0, 0, 0, 0, 0),
        (1.0, 0.0, 0.0, 255, 0, 0, 1000),
        (0.0, 1.0, 0.0, 128, 64, 32, 250),
        (0.0, 0.0, 1.0, 0, 255, 128, 999),
    ];
    for &(x, y, z, r, g, b, i) in &scan1_points {
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
        .expect("add scan2");
    let frac_1_sqrt_2 = std::f64::consts::FRAC_1_SQRT_2;
    pc2.set_transform(Some(Transform {
        rotation: Quaternion {
            w: frac_1_sqrt_2,
            x: 0.0,
            y: 0.0,
            z: frac_1_sqrt_2,
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

    let summary = convert_path_to_copc(
        &input_path,
        &output_path,
        dir.path(),
        &CopcWriterParams::default(),
        &NeverCancel,
        None,
        |_| {},
    )
    .expect("convert_path_to_copc");
    assert_eq!(summary.point_count, 5);
    assert!(!summary.crs_known);

    let (declared, points) = common::read_all_points(&output_path);
    assert_eq!(declared, 5);
    assert_eq!(points.len(), 5);

    let expected_16bit_scan1 = [
        (100.0, 200.0, 300.0, [0u16, 0, 0], 0u16),
        (101.0, 200.0, 300.0, [65535, 0, 0], 65535),
        (100.0, 201.0, 300.0, [32896, 16448, 8224], 16384),
        (100.0, 200.0, 301.0, [0, 65535, 32896], 65469),
    ];
    let expected_16bit_scan2 = (5.0, 15.0, 5.0, [0u16, 0, 0], 0u16);

    let all_expected_16bit: Vec<[u16; 3]> = expected_16bit_scan1
        .iter()
        .map(|&(_, _, _, c, _)| c)
        .chain(std::iter::once(expected_16bit_scan2.3))
        .collect();
    let all_expected_u8 = common::expected_u8_colors(&all_expected_16bit);

    let expected: Vec<(f64, f64, f64, [u8; 3], u16)> = expected_16bit_scan1
        .iter()
        .zip(all_expected_u8.iter().take(4))
        .map(|(&(x, y, z, _, i), &c)| (x, y, z, c, i))
        .chain(std::iter::once({
            let (x, y, z, _, i) = expected_16bit_scan2;
            (x, y, z, all_expected_u8[4], i)
        }))
        .collect();

    common::assert_points_match_unordered(&expected, &points, 0.001);
}
