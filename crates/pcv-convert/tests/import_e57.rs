//! E57 → LAS の受け入れテスト(M4-4)。
//!
//! `e57`クレート自身の`E57Writer`でテスト用のE57ファイルを組み立てる
//! (E57はバイナリ形式が複雑なため、自前でバイト列を組み立てるのは現実的でない。
//! 読み込み側で使っているのと同じcrateの書き込みAPIを使うのは、
//! M4-1bが`copc-writer`自身の変換関数で検証データを作ったのと同じ考え方)。
//!
//! 2つのスキャンを1ファイルに入れ、それぞれ別の姿勢(回転・並進)を持たせる:
//! - スキャン1: 直交座標、姿勢=並進のみ、色(U8 0-255)と強度(Integer 0-1000、
//!   8bitではない値域にして「値域の違いに対応できているか」を確かめる)
//! - スキャン2: 球面座標のみ(色・強度なし)、姿勢=Z軸90度回転+並進
//!
//! 期待値は、`e57`クレートの`PointCloudReaderSimple`が既定で行う
//! 姿勢適用・球面→直交変換・正規化の式を手で計算して求めたもの
//! (`crates/pcv-convert/src/import/e57.rs`のモジュールコメントに
//! 引用した`pc_reader_simple.rs`の実装を参照)。

use e57::{
    E57Writer, Quaternion, Record, RecordDataType, RecordName, RecordValue, Transform, Translation,
};
use pcv_convert::import::to_las;

#[test]
fn combines_multiple_scans_applying_pose_and_spherical_conversion() {
    let dir = tempfile::tempdir().expect("tempdir");
    let input_path = dir.path().join("in.e57");
    let output_path = dir.path().join("out.las");

    let mut writer = E57Writer::from_file(&input_path, "guid-root").expect("create e57 writer");

    // ---- スキャン1: 直交座標 + 色(U8) + 強度(Integer 0-1000)。姿勢=並進のみ ----
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
        rotation: Quaternion::default(), // 単位クォータニオン(回転なし)
        translation: Translation {
            x: 100.0,
            y: 200.0,
            z: 300.0,
        },
    }));
    // 色・強度の値域は明示せず、プロトタイプの型(色は0-255、強度は0-1000)から
    // クレートが自動で導く既定値をそのまま使う(`PointCloudWriter::new`参照)。

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

    // ---- スキャン2: 球面座標のみ(色・強度なし)。姿勢=Z軸90度回転+並進 ----
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
        // Z軸周り90度回転(w=x=0の平面回転)。(x,y,z) -> (-y, x, z)に写す
        // (`pc_reader_simple.rs`の`prepare_transform`の式で実際に導出した結果。
        // 下の期待値コメントも参照)。
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
    // range=10, azimuth=0, elevation=0 → 局所直交座標(10, 0, 0)
    // (`convert_to_cartesian`: x=r*cos(elev)*cos(az), y=r*cos(elev)*sin(az), z=r*sin(elev))
    pc2.add_point(vec![
        RecordValue::Double(10.0),
        RecordValue::Double(0.0),
        RecordValue::Double(0.0),
    ])
    .expect("add point");
    pc2.finalize().expect("finalize scan2");

    writer.finalize().expect("finalize e57");

    // ---- 変換 ----
    let summary = to_las(&input_path, &output_path, None).expect("to_las");
    assert_eq!(summary.point_count, 5);
    assert!(!summary.crs_known);

    let mut reader = las::Reader::from_path(&output_path).expect("open las");
    let transforms = *reader.header().transforms();
    let points: Vec<_> = reader
        .read_all()
        .expect("read all points")
        .points()
        .map(|p| p.expect("point"))
        .collect();
    assert_eq!(points.len(), 5);

    let coord_tolerance = |scale: f64| scale / 2.0 + 1e-6;

    // スキャン1: 姿勢=並進のみなので、座標は「局所座標 + 並進(100,200,300)」。
    let expected_scan1 = [
        // (x, y, z, r16, g16, b16, intensity16)
        (100.0, 200.0, 300.0, 0u16, 0u16, 0u16, 0u16),
        (101.0, 200.0, 300.0, 65535, 0, 0, 65535),
        // 色域0-255からの正規化は65535/255=257が整数になるため、
        // 単純に「元の値 * 257」に一致する: 128*257=32896、64*257=16448、
        // 32*257=8224。強度域0-1000は257のような都合の良い比にならないため、
        // 250/1000*65535=16383.75→16384のように丸めが入る。
        (100.0, 201.0, 300.0, 32896, 16448, 8224, 16384),
        // 255*257=65535、999/1000*65535=65469.465→65469。
        (100.0, 200.0, 301.0, 0, 65535, 32896, 65469),
    ];
    for (i, (ex, ey, ez, er, eg, eb, ei)) in expected_scan1.into_iter().enumerate() {
        let p = &points[i];
        assert!(
            (p.x - ex).abs() <= coord_tolerance(transforms.x.scale),
            "point {i}: x mismatch (got {}, expected {ex})",
            p.x
        );
        assert!((p.y - ey).abs() <= coord_tolerance(transforms.y.scale));
        assert!((p.z - ez).abs() <= coord_tolerance(transforms.z.scale));
        let color = p.color.expect("scan1 has color");
        assert_eq!(color.red, er, "point {i}: red mismatch");
        assert_eq!(color.green, eg, "point {i}: green mismatch");
        assert_eq!(color.blue, eb, "point {i}: blue mismatch");
        assert_eq!(p.intensity, ei, "point {i}: intensity mismatch");
    }

    // スキャン2: 局所(10,0,0) --回転(x,y,z)->(-y,x,z)--> (0,10,0) --+並進(5,5,5)--> (5,15,5)。
    let scan2_point = &points[4];
    assert!((scan2_point.x - 5.0).abs() <= coord_tolerance(transforms.x.scale));
    assert!((scan2_point.y - 15.0).abs() <= coord_tolerance(transforms.y.scale));
    assert!((scan2_point.z - 5.0).abs() <= coord_tolerance(transforms.z.scale));
    // スキャン2は色を持たないが、ファイル全体では(スキャン1が色を持つため)
    // 点フォーマットは色ありになるので、この点の色は既定値の黒になる。
    assert_eq!(
        scan2_point.color,
        Some(las::Color::new(0, 0, 0)),
        "scan2 has no color of its own, defaults to black"
    );
    assert_eq!(scan2_point.intensity, 0);
}
