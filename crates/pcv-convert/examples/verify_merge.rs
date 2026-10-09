//! `merge_las_to_copc`の受け入れ条件の確認(複数入力版)。
//! `examples/verify.rs`(単一入力)は1つの入力の点数しか検算できないため、
//! マージ後の出力は複数入力の合計・和集合を確認する別の確認手順が要る。
//!
//! 確認すること(`TaskSheets/TOOL-merge-las-to-copc.md`の受け入れ条件2):
//! - 出力のCloudInfo点数・hierarchy点数合計が、全入力ヘッダーの申告点数の
//!   合計と一致する
//! - 出力のバウンディングボックスが、全入力ヘッダーのバウンディングボックスの
//!   和集合である(浮動小数点の丸め分だけ許容誤差を見る)
//! - いくつかのノードをサンプルして、RGBが(0,0,0)でない点が存在する
//!   (`pcv-core`がビューアに渡すのと同じ8bit化後のバイト列。レイアウトは
//!   `crates/pcv-core/src/node_format.rs`のドキュメント参照。モジュール自体は
//!   非公開だが、`HEADER_BYTES`/`POINT_STRIDE`の値は`pcv_core`から再公開されている)
//!
//! ```text
//! cargo run -p pcv-convert --release --example verify_merge -- \
//!     <出力.copc.laz> <入力1.las> [入力2.las ...]
//! ```

use std::path::Path;

use pcv_core::{CopcFile, HEADER_BYTES, POINT_STRIDE};

/// 実世界座標の丸め誤差の許容量。出力のscale(既定0.001m)の半分より大きく
/// 取っておけば、量子化の丸め自体は誤検知にならない。
const BOUNDS_EPSILON_M: f64 = 0.01;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some((output, inputs)) = args.split_first() else {
        eprintln!("usage: verify_merge <出力.copc.laz> <入力1.las> [入力2.las ...]");
        std::process::exit(2);
    };
    if inputs.is_empty() {
        eprintln!("入力を1つ以上指定すること");
        std::process::exit(2);
    }

    if let Err(err) = verify(Path::new(output), inputs) {
        eprintln!("検証に失敗した: {err}");
        std::process::exit(1);
    }
    println!("OK: {output} は全{}入力の合計点数・和集合バウンディングボックスと一致し、色のあるノードを確認できた", inputs.len());
}

fn verify(output: &Path, inputs: &[String]) -> Result<(), String> {
    let mut declared_points_total = 0u64;
    let mut min = [f64::INFINITY; 3];
    let mut max = [f64::NEG_INFINITY; 3];

    for input in inputs {
        let reader = las::Reader::from_path(input).map_err(|e| format!("{input}: {e}"))?;
        let header = reader.header();
        declared_points_total += header.number_of_points();
        let bounds = header.bounds();
        min[0] = min[0].min(bounds.min.x);
        min[1] = min[1].min(bounds.min.y);
        min[2] = min[2].min(bounds.min.z);
        max[0] = max[0].max(bounds.max.x);
        max[1] = max[1].max(bounds.max.y);
        max[2] = max[2].max(bounds.max.z);
        println!(
            "入力 {input}: {} 点, bounds=({:.3},{:.3},{:.3})-({:.3},{:.3},{:.3})",
            header.number_of_points(),
            bounds.min.x,
            bounds.min.y,
            bounds.min.z,
            bounds.max.x,
            bounds.max.y,
            bounds.max.z
        );
    }
    println!("入力の合計      : {declared_points_total} 点");
    println!(
        "入力の和集合bounds: ({:.3},{:.3},{:.3})-({:.3},{:.3},{:.3})",
        min[0], min[1], min[2], max[0], max[1], max[2]
    );

    let mut file = CopcFile::open(output).map_err(|e| e.to_string())?;
    let info = file.info().clone();
    println!(
        "出力CloudInfo   : {} 点, bounds=({:.3},{:.3},{:.3})-({:.3},{:.3},{:.3}), 色あり={}",
        info.point_count,
        info.min[0],
        info.min[1],
        info.min[2],
        info.max[0],
        info.max[1],
        info.max[2],
        info.has_color
    );

    if info.point_count != declared_points_total {
        return Err(format!(
            "出力の点数({})が入力合計({declared_points_total})と一致しない",
            info.point_count
        ));
    }

    let hierarchy_sum: u64 = file
        .hierarchy()
        .nodes()
        .map(|n| u64::from(n.point_count))
        .sum();
    if hierarchy_sum != declared_points_total {
        return Err(format!(
            "hierarchyの点数合計({hierarchy_sum})が入力合計({declared_points_total})と一致しない"
        ));
    }

    for axis in 0..3 {
        if (info.min[axis] - min[axis]).abs() > BOUNDS_EPSILON_M {
            return Err(format!(
                "出力min[{axis}]={} が入力和集合の{}と{}m以上ずれている",
                info.min[axis], min[axis], BOUNDS_EPSILON_M
            ));
        }
        if (info.max[axis] - max[axis]).abs() > BOUNDS_EPSILON_M {
            return Err(format!(
                "出力max[{axis}]={} が入力和集合の{}と{}m以上ずれている",
                info.max[axis], max[axis], BOUNDS_EPSILON_M
            ));
        }
    }

    // いくつかのノードをサンプルして、RGBが非ゼロの点が1つ以上あることを確認する。
    let mut keys: Vec<_> = file.hierarchy().nodes().map(|n| n.key).collect();
    keys.sort_by_key(|key| (key.level, key.x, key.y, key.z));
    let sample_keys: Vec<_> = keys.iter().rev().take(5).copied().collect();

    let mut found_nonzero_color = false;
    let mut sampled_points = 0u64;
    for key in sample_keys {
        let buffer = file.read_node(key).map_err(|e| e.to_string())?;
        let mut offset = HEADER_BYTES;
        while offset + POINT_STRIDE <= buffer.bytes.len() {
            let r = buffer.bytes[offset + 12];
            let g = buffer.bytes[offset + 13];
            let b = buffer.bytes[offset + 14];
            if (r, g, b) != (0, 0, 0) {
                found_nonzero_color = true;
            }
            sampled_points += 1;
            offset += POINT_STRIDE;
        }
    }
    println!("色のサンプル    : {sampled_points} 点確認、非ゼロRGBあり={found_nonzero_color}");
    if !found_nonzero_color {
        return Err("サンプルしたノードの点が全てRGB=(0,0,0)だった".to_string());
    }

    Ok(())
}
