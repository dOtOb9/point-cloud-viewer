//! M4-6a調査用の使い捨てヘルパー。COPCファイルのhierarchy全体
//! (ノードキー・点数)をソート済みテキストで標準出力へ書く。改修前後の
//! 出力を`diff`で機械的に比較するために使う。`spike/m4-6`だけに存在する。
//!
//! ```text
//! cargo run -p pcv-convert --example spike_dump_hierarchy -- <入力.copc.laz>
//! ```

use std::path::Path;

use pcv_core::CopcFile;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(input) = args.first() else {
        eprintln!("usage: spike_dump_hierarchy <入力.copc.laz>");
        std::process::exit(2);
    };

    let mut file = CopcFile::open(Path::new(input)).expect("開けなかった");
    println!("total_point_count={}", file.info().point_count);

    let mut nodes: Vec<_> = file
        .hierarchy()
        .nodes()
        .map(|n| (n.key, n.point_count))
        .collect();
    nodes.sort_by_key(|(key, _)| (key.level, key.x, key.y, key.z));
    println!("node_count={}", nodes.len());
    for (key, count) in &nodes {
        println!(
            "level={} x={} y={} z={} count={}",
            key.level, key.x, key.y, key.z, count
        );
    }

    // 全ノードをread_nodeで読み、hierarchyの申告点数と実点数が一致するかも
    // 確かめる(改修前後どちらでも同じ手順で行う)。
    let mut total_read = 0u64;
    for (key, declared) in &nodes {
        let buffer = file.read_node(*key).expect("read_nodeに失敗");
        assert_eq!(
            buffer.point_count, *declared,
            "node {key:?}: hierarchy申告とread_node実点数が食い違う"
        );
        total_read += u64::from(buffer.point_count);
    }
    println!("read_node_total={total_read}");
}
