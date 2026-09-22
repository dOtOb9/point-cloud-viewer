//! COPC を開くコストを測る。
//!
//! ```text
//! cargo run -p pcv-core --release --example open_bench -- data/autzen-classified.copc.laz data/sofi.copc.laz
//! ```
//!
//! `TaskSheets/M1-point-rendering.md` の完了条件のうち、最も鋭い一項目
//! 「**開くまでの時間がファイルサイズに比例しないこと**」を GUI 抜きで検証するためのもの。
//!
//! COPC はファイル内に octree を持つため、開く処理は「ヘッダと hierarchy を読む」だけで
//! 完結し、点データは読まないはずである。点数が34倍のファイルで開く時間も34倍になるなら、
//! hierarchy 以外に点データを余計に読んでいることになり、構成が機能していない。

use std::path::Path;
use std::time::Instant;

use pcv_core::{CopcFile, NodeKey};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() {
        eprintln!("usage: open_bench <file.copc.laz>...");
        std::process::exit(2);
    }

    for arg in &args {
        measure(Path::new(arg));
    }
}

fn measure(path: &Path) {
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

    let point_count = file.info().point_count;
    let node_count = file.hierarchy().len();

    println!("{name}");
    println!("  ファイルサイズ : {:.2} GB", size as f64 / 1e9);
    println!("  総点数         : {point_count}");
    println!("  hierarchy ノード: {node_count}");
    println!("  開く時間       : {open_ms:.1} ms   <- ここがサイズに比例したら設計が壊れている");

    // 描画開始までの体感に効くので、ルートノード1つの読み出しも測る。
    let started = Instant::now();
    match file.read_node(NodeKey::root()) {
        Ok(buffer) => {
            let read_ms = started.elapsed().as_secs_f64() * 1000.0;
            let mib = buffer.bytes.len() as f64 / (1024.0 * 1024.0);
            println!(
                "  ルートノード   : {} 点 / {:.2} MiB / {read_ms:.1} ms",
                buffer.point_count, mib
            );
        }
        Err(err) => println!("  ルートノード   : 読めなかった: {err}"),
    }
    println!();
}
