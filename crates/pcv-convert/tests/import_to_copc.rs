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

    for entry in std::fs::read_dir(dir.path()).expect("read tempdir") {
        let path = entry.expect("dir entry").path();
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
        assert!(ext != "las", "中間LASが作られている: {}", path.display());
    }

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

    let (declared, points) = common::read_all_points(&copc_path);
    assert_eq!(declared, N as u64);
    assert_eq!(points.len(), N);
}
