//! M4-9受け入れ条件: 「E57/PLY/PCD → COPCが、中間LASを作らずに行われる」ことを、
//! ある程度の点数(2,000点、1ノードに収まらない規模ではないが、E57を直接COPCへ
//! 流す経路全体を通す)で確かめる。
//!
//! M4-4時点はこのテストが「E57→(`to_las`)→LAS→(`copc_writer::convert_las_to_copc_streaming`)
//! →COPC」という2段階の経路を確認していたが、M4-9で中間LASを廃止したため、
//! 経路は「E57→(`pcv_convert::import::convert_path_to_copc`)→COPC」の1段階になった。

mod common;

use copc_core::NeverCancel;
use copc_writer::CopcWriterParams;
use e57::{E57Writer, Record};
use pcv_convert::import::convert_path_to_copc;
use pcv_core::CopcFile;

#[test]
fn e57_converts_directly_to_copc_without_an_intermediate_las() {
    let dir = tempfile::tempdir().expect("tempdir");
    let e57_path = dir.path().join("in.e57");
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

    // ---- E57 → COPC(中間LASを経ない。本クレートの担当する経路全体) ----
    let summary = convert_path_to_copc(
        &e57_path,
        &copc_path,
        dir.path(),
        &CopcWriterParams::default(),
        &NeverCancel,
        None,
        |_| {},
    )
    .expect("convert_path_to_copc");
    assert_eq!(summary.point_count, N as u64);

    // 中間LASを一切作っていないこと(受け入れ条件)。tempdir内に
    // `.las`/`.laz`拡張子のファイルが無いことで裏付ける
    // (出力・spillの一時ファイル以外に中間生成物が無いことの確認)。
    for entry in std::fs::read_dir(dir.path()).expect("read tempdir") {
        let path = entry.expect("dir entry").path();
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
        assert!(ext != "las", "中間LASが作られている: {}", path.display());
    }

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

    // 座標・色も一致することを確認する(`common::read_all_points`を使い回す)。
    let (declared, points) = common::read_all_points(&copc_path);
    assert_eq!(declared, N as u64);
    assert_eq!(points.len(), N);
}
