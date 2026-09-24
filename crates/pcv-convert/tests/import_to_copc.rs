//! M4-4受け入れ条件: 「書き出したLASを`copc-writer`でCOPCに変換し`pcv-core`で
//! 開けることを、少なくとも1形式で統合テストする」。
//!
//! 優先度が最も高いE57で確認する(`TaskSheets/ADR-0008-formats-and-crs.md`の
//! 優先順位「E57 → PLY → PCD」参照)。経路は
//! E57 → (`pcv_convert::import::to_las`) → LAS → (`copc_writer::convert_las_to_copc_streaming`、
//! ADR-0006で採用済みの経路) → COPC → (`pcv_core::CopcFile::open`)。
//! `crates/pcv-convert/examples/verify.rs`(M4-1の検証)と同じ確認observableを使う。

use copc_core::NeverCancel;
use copc_writer::{convert_las_to_copc_streaming, CopcWriterParams};
use e57::{E57Writer, Record};
use pcv_convert::import::to_las;
use pcv_core::CopcFile;

#[test]
fn e57_to_las_to_copc_opens_in_pcv_core() {
    let dir = tempfile::tempdir().expect("tempdir");
    let e57_path = dir.path().join("in.e57");
    let las_path = dir.path().join("intermediate.las");
    let copc_path = dir.path().join("out.copc.laz");

    // ---- E57を組み立てる(直交座標+色、姿勢無し) ----
    let mut writer = E57Writer::from_file(&e57_path, "guid-root").expect("create e57 writer");
    let prototype = vec![
        Record::CARTESIAN_X_F64,
        Record::CARTESIAN_Y_F64,
        Record::CARTESIAN_Z_F64,
        Record::COLOR_RED_U8,
        Record::COLOR_GREEN_U8,
        Record::COLOR_BLUE_U8,
    ];
    let mut pc = writer
        .add_pointcloud("guid-scan1", prototype)
        .expect("add scan");

    const N: usize = 2_000;
    for i in 0..N {
        let t = i as f64;
        pc.add_point(vec![
            e57::RecordValue::Double((t % 50.0) - 25.0),
            e57::RecordValue::Double(((t / 50.0) % 50.0) - 25.0),
            e57::RecordValue::Double((t / 400.0) - 2.5),
            e57::RecordValue::Integer((i % 256) as i64),
            e57::RecordValue::Integer(((i * 3) % 256) as i64),
            e57::RecordValue::Integer(((i * 7) % 256) as i64),
        ])
        .expect("add point");
    }
    pc.finalize().expect("finalize scan");
    writer.finalize().expect("finalize e57");

    // ---- E57 → LAS(このクレートの担当) ----
    let summary = to_las(&e57_path, &las_path, None).expect("to_las");
    assert_eq!(summary.point_count, N as u64);

    // ---- LAS → COPC(ADR-0006で採用済みのcopc-writer経路。M4-1bのexamples/convert_streaming.rsと同じ呼び方) ----
    let params = CopcWriterParams::default();
    let spill_dir = dir.path().to_path_buf();
    convert_las_to_copc_streaming(&las_path, &copc_path, &params, &spill_dir, &NeverCancel)
        .expect("convert las to copc");

    // ---- pcv-coreで開けることを確認する(examples/verify.rsと同じ確認内容) ----
    let mut copc = CopcFile::open(&copc_path).expect("open copc with pcv-core");
    assert_eq!(copc.info().point_count, N as u64);

    let hierarchy_sum: u64 = copc
        .hierarchy()
        .nodes()
        .map(|n| u64::from(n.point_count))
        .sum();
    assert_eq!(hierarchy_sum, N as u64);

    let keys: Vec<_> = copc.hierarchy().nodes().map(|n| n.key).collect();
    assert!(!keys.is_empty());
    for key in keys {
        let buffer = copc.read_node(key).expect("read_node");
        assert!(buffer.point_count > 0);
    }
}
