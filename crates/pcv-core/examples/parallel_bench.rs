#![allow(clippy::disallowed_methods)]

use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Instant;

use pcv_core::{CopcFile, NodeKey};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(path) = args.first() else {
        eprintln!("usage: parallel_bench <file.copc.laz> [max_threads]");
        std::process::exit(2);
    };
    let max_threads: usize = args.get(1).and_then(|s| s.parse().ok()).unwrap_or_else(|| {
        std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(8)
    });

    let path = Path::new(path);
    let name = path.file_name().unwrap_or_default().to_string_lossy();

    let keys: Vec<NodeKey> = {
        let file = match CopcFile::open(path) {
            Ok(file) => file,
            Err(err) => {
                println!("{name}: 開けなかった: {err}");
                return;
            }
        };
        let mut nodes: Vec<_> = file
            .hierarchy()
            .nodes()
            .map(|node| (node.key, node.point_count))
            .collect();
        nodes.sort_by_key(|(key, _)| (key.level, key.x, key.y, key.z));
        nodes.into_iter().take(160).map(|(key, _)| key).collect()
    };

    println!("{name}  読むノード数: {}", keys.len());
    println!(
        "  論理コア数: {}",
        std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(0)
    );
    println!();
    println!("  スレッド数   所要時間      ノード/秒     MiB/秒    1コアあたり");
    println!("  ----------------------------------------------------------------");

    let keys = Arc::new(keys);
    let mut single_rate = 0.0f64;

    for threads in thread_counts(max_threads) {
        let mut files: Vec<CopcFile> = Vec::with_capacity(threads);
        for _ in 0..threads {
            match CopcFile::open(path) {
                Ok(file) => files.push(file),
                Err(err) => {
                    println!("  {threads:>6}   開けなかった: {err}");
                    return;
                }
            }
        }

        let next = Arc::new(AtomicUsize::new(0));
        let bytes = Arc::new(AtomicUsize::new(0));
        let started = Instant::now();

        std::thread::scope(|scope| {
            for mut file in files {
                let keys = Arc::clone(&keys);
                let next = Arc::clone(&next);
                let bytes = Arc::clone(&bytes);
                scope.spawn(move || loop {
                    let index = next.fetch_add(1, Ordering::Relaxed);
                    let Some(&key) = keys.get(index) else { break };
                    match file.read_node(key) {
                        Ok(buffer) => {
                            bytes.fetch_add(buffer.bytes.len(), Ordering::Relaxed);
                        }
                        Err(err) => eprintln!("ノード {key:?} が読めなかった: {err}"),
                    }
                });
            }
        });

        let secs = started.elapsed().as_secs_f64();
        let rate = keys.len() as f64 / secs;
        let mib = bytes.load(Ordering::Relaxed) as f64 / (1024.0 * 1024.0) / secs;
        if threads == 1 {
            single_rate = rate;
        }
        let scaling = if single_rate > 0.0 {
            format!("{:.2}x", rate / single_rate / threads as f64)
        } else {
            "-".to_string()
        };
        println!("  {threads:>6}   {secs:>8.2} 秒 {rate:>10.1} {mib:>10.1} {scaling:>12}");
    }

    println!();
    println!("  ※「1コアあたり」が 1.00 に近いほど理想的な並列化。");
    println!("     スレッドを増やしても値が落ちるなら、そこが頭打ち。");
}

fn thread_counts(max: usize) -> Vec<usize> {
    let mut out = Vec::new();
    let mut n = 1;
    while n <= max {
        out.push(n);
        n *= 2;
    }
    if out.last() != Some(&max) {
        out.push(max);
    }
    out
}
