//! Developer tool: checks that two COPC files hold the same points in every node.
//!
//! Used for ADR-0019, to compare the output of the index-based LOD builder (the
//! build before the change) with the record-carrying one. The chunk order in the
//! file and the order of points inside a node may differ; what must be equal is
//! the set of nodes and, for every node, the multiset of points as the viewer
//! sees them (`pcv-core` node buffer: relative position, color, intensity,
//! classification). The files are compared node by node, so memory stays at
//! about one node per file whatever the number of points (L3-C: the first
//! version held both files, which took 30 GiB for 325 million points).
//!
//! ```text
//! cargo run -p pcv-convert --release --example compare_copc_nodes -- <a.copc.laz> <b.copc.laz>
//! ```

use std::collections::BTreeSet;
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

/// The sorted point records of one node.
fn read_node(file: &mut CopcFile, key: NodeKey, path: &Path) -> Result<Vec<Vec<u8>>, String> {
    let buffer = file
        .read_node(key)
        .map_err(|e| format!("{}: node {key:?}: {e}", path.display()))?;
    let body = buffer
        .bytes
        .get(HEADER_BYTES..)
        .ok_or_else(|| format!("node {key:?}: buffer shorter than its header"))?;
    let mut points: Vec<Vec<u8>> = body
        .as_chunks::<POINT_STRIDE>()
        .0
        .iter()
        .map(|point| point.to_vec())
        .collect();
    points.sort();
    Ok(points)
}

fn node_keys(file: &CopcFile) -> BTreeSet<NodeKey> {
    file.hierarchy().nodes().map(|node| node.key).collect()
}

fn compare(a: &Path, b: &Path) -> Result<String, String> {
    let mut file_a = CopcFile::open(a).map_err(|e| format!("{}: {e}", a.display()))?;
    let mut file_b = CopcFile::open(b).map_err(|e| format!("{}: {e}", b.display()))?;
    let keys_a = node_keys(&file_a);
    let keys_b = node_keys(&file_b);
    if keys_a.len() != keys_b.len() {
        return Err(format!(
            "node count differs: {} vs {}",
            keys_a.len(),
            keys_b.len()
        ));
    }
    let mut total = 0usize;
    for (key_a, key_b) in keys_a.iter().zip(&keys_b) {
        if key_a != key_b {
            return Err(format!("node keys differ: {key_a:?} vs {key_b:?}"));
        }
        let points_a = read_node(&mut file_a, *key_a, a)?;
        let points_b = read_node(&mut file_b, *key_b, b)?;
        if points_a != points_b {
            return Err(format!(
                "node {key_a:?} differs ({} vs {} points)",
                points_a.len(),
                points_b.len()
            ));
        }
        total += points_a.len();
    }
    Ok(format!("{} nodes, {total} points", keys_a.len()))
}
