//! M4-1の受け入れ条件「出力したCOPCが`pcv-core`で開けて、hierarchyの点数の
//! 合計が入力の点数と一致し、いくつかのノードを`read_node`で読めること」を
//! 確かめる。GUIでの目視確認の代わり(`crates/pcv-core/examples/open_bench.rs`
//! を参考にした)。
//!
//! ```text
//! cargo run -p pcv-convert --release --example verify -- <入力.las/.laz> <出力.copc.laz>
//! ```

use std::path::Path;

use pcv_core::CopcFile;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (Some(input), Some(output)) = (args.first(), args.get(1)) else {
        eprintln!("usage: verify <入力.las/.laz> <出力.copc.laz>");
        std::process::exit(2);
    };

    if let Err(err) = verify(Path::new(input), Path::new(output)) {
        eprintln!("検証に失敗した: {err}");
        std::process::exit(1);
    }
    println!("OK: {output} は pcv-core で開け、点数が一致し、ノードを読めた");
}

fn verify(input: &Path, output: &Path) -> Result<(), String> {
    let input_reader = las::Reader::from_path(input).map_err(|e| e.to_string())?;
    let input_points = input_reader.header().number_of_points();
    println!("入力の申告点数  : {input_points}");

    let mut file = CopcFile::open(output).map_err(|e| e.to_string())?;
    println!("開けた          : {}", output.display());
    println!("CloudInfo点数   : {}", file.info().point_count);

    let hierarchy_sum: u64 = file
        .hierarchy()
        .nodes()
        .map(|n| u64::from(n.point_count))
        .sum();
    println!(
        "hierarchyノード : {} 個, 点数の合計 = {hierarchy_sum}",
        file.hierarchy().len()
    );

    if hierarchy_sum != input_points {
        return Err(format!(
            "hierarchyの点数合計({hierarchy_sum})が入力の申告点数({input_points})と一致しない"
        ));
    }

    // 粗いノードから数個、実際にread_nodeで読めるかを確かめる。
    let mut keys: Vec<_> = file
        .hierarchy()
        .nodes()
        .map(|n| (n.key, n.point_count))
        .collect();
    keys.sort_by_key(|(key, _)| (key.level, key.x, key.y, key.z));

    let mut checked = 0u64;
    for (key, declared_count) in keys.iter().take(5) {
        let buffer = file.read_node(*key).map_err(|e| e.to_string())?;
        if buffer.point_count != *declared_count {
            return Err(format!(
                "ノード{key:?}: hierarchyの申告({declared_count})とread_nodeの実点数({})が食い違う",
                buffer.point_count
            ));
        }
        println!(
            "  read_node({key:?}): {} 点, {} バイト",
            buffer.point_count,
            buffer.bytes.len()
        );
        checked += 1;
    }
    println!("read_nodeで確認したノード数: {checked}");

    Ok(())
}
