//! COPC を開くコストと、点予算を埋めるまでのノード読み出しコストを測る。
//!
//! ```text
//! cargo run -p pcv-core --release --example open_bench -- <file.copc.laz> [点予算]
//! ```
//!
//! `TaskSheets/M1-point-rendering.md` の完了条件を GUI 抜きで検証するためのもの。
//!
//! 測る対象は2つある。
//!
//! 1. **開くコスト** — COPC はファイル内に octree を持つため、開く処理はヘッダと
//!    hierarchy を読むだけで完結し、点データは読まないはずである。点数が34倍の
//!    ファイルで開く時間も34倍になるなら、hierarchy 以外を余計に読んでいる。
//!
//! 2. **点予算を埋めるコスト** — LOD が最初の画を出すまでに何ノード読む必要があり、
//!    それに何秒かかるか。ノード1つの読み出しは LAZ 伸長を含むため CPU を食う。
//!    ここで出る「毎秒何ノード」が、`pcv://` ハンドラを同期のままにした場合の
//!    構造的な上限になる（同期ハンドラは Rust のメインスレッドで直列に走るため）。

use std::path::Path;
use std::time::Instant;

use pcv_core::{CopcFile, NodeKey};

const DEFAULT_POINT_BUDGET: u64 = 3_000_000;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(path) = args.first() else {
        eprintln!("usage: open_bench <file.copc.laz> [point_budget]");
        std::process::exit(2);
    };
    let budget = args
        .get(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_POINT_BUDGET);

    measure(Path::new(path), budget);
}

fn measure(path: &Path, budget: u64) {
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);

    let started = Instant::now();
    let mut file = match CopcFile::open(path) {
        Ok(file) => file,
        Err(err) => {
            println!("{name}: 開けなかった: {err}");
            return;
        }
    };
    let open_ms = started.elapsed().as_secs_f64() * 1000.0;

    println!("{name}");
    println!("  ファイルサイズ  : {:.2} GB", size as f64 / 1e9);
    println!("  総点数          : {}", file.info().point_count);
    println!("  hierarchy ノード: {}", file.hierarchy().len());
    println!("  開く時間        : {open_ms:.1} ms");
    println!();

    // 粗いノードから順に読む。LOD は画面空間誤差で選ぶが、ここでは
    // 「最初の画を出すのに必要な量」の目安として level の浅い順に取る。
    let mut keys: Vec<(NodeKey, u32)> = file
        .hierarchy()
        .nodes()
        .map(|node| (node.key, node.point_count))
        .collect();
    keys.sort_by_key(|(key, _)| (key.level, key.x, key.y, key.z));

    let mut points = 0u64;
    let mut bytes = 0u64;
    let mut nodes = 0u32;
    let mut slowest_ms = 0.0f64;

    let started = Instant::now();
    for (key, _) in &keys {
        if points >= budget {
            break;
        }
        let per_node = Instant::now();
        match file.read_node(*key) {
            Ok(buffer) => {
                let ms = per_node.elapsed().as_secs_f64() * 1000.0;
                slowest_ms = slowest_ms.max(ms);
                points += u64::from(buffer.point_count);
                bytes += buffer.bytes.len() as u64;
                nodes += 1;
            }
            Err(err) => {
                println!("  ノード {key:?} が読めなかった: {err}");
                return;
            }
        }
    }
    let total_s = started.elapsed().as_secs_f64();

    println!("  点予算 {budget} を埋めるまで");
    println!("    読んだノード  : {nodes}");
    println!("    読んだ点      : {points}");
    println!(
        "    転送バイト    : {:.1} MiB",
        bytes as f64 / (1024.0 * 1024.0)
    );
    println!("    所要時間      : {:.2} 秒", total_s);
    println!("    最も遅い1ノード: {slowest_ms:.1} ms");
    println!();
    println!("    ノード/秒     : {:.1}", f64::from(nodes) / total_s);
    println!(
        "    点/秒         : {:.0}",
        points as f64 / total_s.max(f64::EPSILON)
    );
    println!(
        "    MiB/秒        : {:.1}",
        bytes as f64 / (1024.0 * 1024.0) / total_s.max(f64::EPSILON)
    );
    println!();
    println!("  ※ この「ノード/秒」が、pcv:// を同期ハンドラのままにした場合の構造的上限になる。");
    println!();
}
