//! Developer tool: checks that two COPC files hold the same points in every node.
//!
//! Used for ADR-0019, to compare the output of the index-based LOD builder (the
//! build before the change) with the record-carrying one. The chunk order in the
//! file and the order of points inside a node may differ; what must be equal is
//! the set of nodes and, for every node, the multiset of points as the viewer
//! sees them (`pcv-core` node buffer: relative position, color, intensity,
//! classification).
//!
//! ```text
//! cargo run -p pcv-convert --release --example compare_copc_nodes -- <a.copc.laz> <b.copc.laz>
//! ```

use std::collections::BTreeMap;
use std::path::Path;

use pcv_core::{CopcFile, NodeKey, HEADER_BYTES, POINT_STRIDE};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [a, b] = args.as_slice() else {
        eprintln!("usage: compare_copc_nodes <a.copc.laz> <b.copc.laz>");
        std::process::exit(2);
    };
    match compare(Path::new(a), Path::new(b)) {
        Ok(summary) => println!("SAME: {summary}"),
        Err(message) => {
            eprintln!("DIFFERENT: {message}");
            std::process::exit(1);
        }
    }
}

/// Every node as its sorted list of point records.
fn read_nodes(path: &Path) -> Result<BTreeMap<NodeKey, Vec<Vec<u8>>>, String> {
    let mut file = CopcFile::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let keys: Vec<NodeKey> = file.hierarchy().nodes().map(|node| node.key).collect();
    let mut nodes = BTreeMap::new();
    for key in keys {
        let buffer = file
            .read_node(key)
            .map_err(|e| format!("{}: node {key:?}: {e}", path.display()))?;
        let body = buffer
            .bytes
            .get(HEADER_BYTES..)
            .ok_or_else(|| format!("node {key:?}: buffer shorter than its header"))?;
        let mut points: Vec<Vec<u8>> = body
            .chunks_exact(POINT_STRIDE)
            .map(<[u8]>::to_vec)
            .collect();
        points.sort();
        nodes.insert(key, points);
    }
    Ok(nodes)
}

fn compare(a: &Path, b: &Path) -> Result<String, String> {
    let nodes_a = read_nodes(a)?;
    let nodes_b = read_nodes(b)?;
    if nodes_a.len() != nodes_b.len() {
        return Err(format!(
            "node count differs: {} vs {}",
            nodes_a.len(),
            nodes_b.len()
        ));
    }
    let mut total = 0usize;
    for ((key_a, points_a), (key_b, points_b)) in nodes_a.iter().zip(&nodes_b) {
        if key_a != key_b {
            return Err(format!("node keys differ: {key_a:?} vs {key_b:?}"));
        }
        if points_a != points_b {
            return Err(format!(
                "node {key_a:?} differs ({} vs {} points)",
                points_a.len(),
                points_b.len()
            ));
        }
        total += points_a.len();
    }
    Ok(format!("{} nodes, {total} points", nodes_a.len()))
}
