//! M4-6a調査用の使い捨てヘルパー。改修前後で`copc-writer`の出力を比べるための
//! 小さな合成LASを書き出すだけ。`spike/m4-6`ブランチだけに存在し、mainには
//! 入れない(タスクシート「約束」参照)。
//!
//! 点を3D空間に広く散らし、octreeが複数ノード・複数レベルに分かれるようにする
//! (「同じノード構成になること」の確認に意味を持たせるため。1ノードしか
//! できないデータでは改修の検証にならない)。
//!
//! ```text
//! cargo run -p pcv-convert --example spike_make_las -- <出力.las> [点数=200000]
//! ```

use std::path::Path;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(output) = args.first() else {
        eprintln!("usage: spike_make_las <出力.las> [点数=200000]");
        std::process::exit(2);
    };
    let point_count: u32 = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(200_000);

    write_synthetic_las(Path::new(output), point_count);
    println!("書いた: {output} ({point_count}点)");
}

/// 点をxyz全軸に広く散らした点群。LAS 1.4 / point format 6(GPS時刻あり、
/// 色なし)。CRSは付けない(このスパイクの検証には不要)。
fn write_synthetic_las(path: &Path, point_count: u32) {
    let mut builder = las::Builder::from((1, 4));
    builder.point_format = las::point::Format::new(6).expect("format 6");
    let header = builder.into_header().expect("valid header");
    let mut writer = las::Writer::from_path(path, header).expect("LAS writerの作成に失敗");

    // 疑似乱数(線形合同法。再現性のため固定シードで十分): 3軸それぞれ
    // 別の乗数を使い、軸間の相関を避ける。
    let mut seed_x: u64 = 0x9E3779B97F4A7C15;
    let mut seed_y: u64 = 0xBF58476D1CE4E5B9;
    let mut seed_z: u64 = 0x94D049BB133111EB;
    let next = |seed: &mut u64| -> f64 {
        *seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
        ((*seed >> 11) as f64) / ((1u64 << 53) as f64) // [0, 1)
    };

    for i in 0..point_count {
        let x = next(&mut seed_x) * 1000.0;
        let y = next(&mut seed_y) * 1000.0;
        let z = next(&mut seed_z) * 100.0;
        let point = las::Point {
            x,
            y,
            z,
            intensity: (i % 65536) as u16,
            gps_time: Some(f64::from(i) * 1e-3),
            ..Default::default()
        };
        writer.write_point(point).expect("点の書き込みに失敗");
    }
    writer.close().expect("LAS writerのクローズに失敗");
}
