//! E57 → COPC の受け入れテスト(M4-4→M4-9で中間LASを経ない形に書き換え)。
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

    // ---- 変換(中間LASを経ず直接COPCへ) ----
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

    // スキャン1: 姿勢=並進のみなので、座標は「局所座標 + 並進(100,200,300)」。
    // 期待する16bit色は、E57の0-255値域を0.0..1.0へ正規化してから
    // 65535を掛けた値(`e57.rs`のモジュールコメント参照)。
    let expected_16bit_scan1 = [
        (100.0, 200.0, 300.0, [0u16, 0, 0], 0u16),
        (101.0, 200.0, 300.0, [65535, 0, 0], 65535),
        // 色域0-255からの正規化は65535/255=257が整数になるため、
        // 単純に「元の値 * 257」に一致する: 128*257=32896、64*257=16448、
        // 32*257=8224。強度域0-1000は257のような都合の良い比にならないため、
        // 250/1000*65535=16383.75→16384のように丸めが入る。
        (100.0, 201.0, 300.0, [32896, 16448, 8224], 16384),
        // 255*257=65535、999/1000*65535=65469.465→65469。
        (100.0, 200.0, 301.0, [0, 65535, 32896], 65469),
    ];
    // スキャン2: 局所(10,0,0) --回転(x,y,z)->(-y,x,z)--> (0,10,0) --+並進(5,5,5)--> (5,15,5)。
    // 色を持たないが、ファイル全体では(スキャン1が色を持つため)点フォーマットは
    // 色ありになるので、この点の色は既定値の黒(16bit)になる
    // (`e57.rs`の`for_each_point`、`point.color.unwrap_or([0,0,0])`参照)。
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

    // scaleの丸め誤差(choose_scale_offsetの決め方どおり、高々scale/2。
    // 入力の範囲は数百メートル規模なので最も細かいスケール0.1mmが選ばれる
    // はずで、十分小さい固定値で確認する)。
    common::assert_points_match_unordered(&expected, &points, 0.001);
}
