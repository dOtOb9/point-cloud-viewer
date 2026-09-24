//! 小規模な合成データで、変換パイプライン全体(読み込み→octree分割→書き出し)を
//! 検証する。M4-1の受け入れ条件そのもの(2規模の実測)はサイズの都合でここでは
//! 確認しない(手動での実行手順は`TaskSheets/M4-import-and-conversion.md`のM4-1
//! 「結果」を参照)が、ここで小さく壊れていれば実データで測る意味が無いため、
//! 素朴な実装の正しさはここで最低限確かめる。

use las::{Builder, Color, Point, Transform, Vector};
use pcv_convert::{octree, point, writer};

#[test]
fn roundtrip_small_synthetic_cloud() {
    let dir = tempfile::tempdir().expect("tempdir");
    let input_path = dir.path().join("in.laz");
    let output_path = dir.path().join("out.copc.laz");

    let mut builder = Builder::default();
    builder.version = las::Version::new(1, 4); // point format 7はLAS 1.4が必要
    builder.point_format = las::point::Format::new(7).expect("format 7"); // 色+GPS時刻あり
    builder.transforms = Vector {
        x: Transform {
            scale: 0.001,
            offset: 0.0,
        },
        y: Transform {
            scale: 0.001,
            offset: 0.0,
        },
        z: Transform {
            scale: 0.001,
            offset: 0.0,
        },
    };
    let header = builder.into_header().expect("header");
    let mut las_writer = las::Writer::from_path(&input_path, header).expect("las writer");

    // 立方体状に点をばらまく。ノード上限を小さくして複数ノード・複数階層に
    // 分割されることを確かめる。
    const N: usize = 50_000;
    for i in 0..N {
        let t = i as f64;
        let point = Point {
            x: (t % 100.0) - 50.0,
            y: ((t / 100.0) % 100.0) - 50.0,
            z: (t / 500.0) % 20.0 - 10.0,
            intensity: (i % 65_536) as u16,
            classification: las::point::Classification::new((i % 10) as u8).expect("class"),
            color: Some(Color::new(((i % 256) * 257) as u16, 0, 0)),
            gps_time: Some(0.0),
            ..Default::default()
        };
        las_writer.write_point(point).expect("write point");
    }
    las_writer.close().expect("close writer");
    drop(las_writer);

    // ---- 変換 ----
    let source = point::read_all(&input_path).expect("read_all");
    assert_eq!(source.points.len(), N);
    assert!(source.has_color);

    let (center, halfsize) = octree::cube_from_bounds(source.bounds_min, source.bounds_max);
    let nodes = octree::build(&source.points, center, halfsize, 1_000);
    assert!(
        nodes.len() > 1,
        "ノード上限1,000点に対して{N}点あるので複数ノードに分かれるはず"
    );

    let stats = writer::write(&output_path, &source, &nodes, center, halfsize).expect("write copc");
    assert_eq!(stats.total_points, N as u64);
    assert_eq!(stats.node_count, nodes.len());

    // ---- 検証: pcv-coreで開けて、点数が一致し、ノードが読めるか ----
    let mut file = pcv_core::CopcFile::open(&output_path).expect("CopcFile::open");
    assert_eq!(file.info().point_count, N as u64);

    let hierarchy_sum: u64 = file
        .hierarchy()
        .nodes()
        .map(|node| u64::from(node.point_count))
        .sum();
    assert_eq!(hierarchy_sum, N as u64);

    let keys: Vec<_> = file
        .hierarchy()
        .nodes()
        .map(|node| (node.key, node.point_count))
        .collect();
    for (key, declared_count) in keys {
        let buffer = file.read_node(key).expect("read_node");
        assert_eq!(buffer.point_count, declared_count);
    }
}
