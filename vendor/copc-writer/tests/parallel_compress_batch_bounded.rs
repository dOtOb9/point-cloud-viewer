//! M4-10(`TaskSheets/M4-import-and-conversion.md`)の回帰テスト:
//! ノードごとのLAZ圧縮を並列化(`parallel-compress`)しても、**同時に圧縮する
//! ノード数(バッチサイズ)がノード数(≒点数)に比例しない**ことを確かめる。
//!
//! # 経緯
//!
//! `compress_nodes_parallel`(`writer.rs`)は`batch_size = 2 *
//! rayon::current_num_threads()`ノードずつをまとめて並列圧縮する
//! (関数のドキュメントコメント参照。ピークメモリは`2 * batch *
//! max_points_per_node * record_len`バイト程度、という見積もりもそこに書いて
//! ある)。この定数は総ノード数に依存しないので、ノード数が何倍になろうと、
//! 同時に抱える生バッファ・圧縮済みバッファの数は増えないはず。
//!
//! 「読まずに信じる」のではなく、M4-8の`parallel_lod_open_files_bounded.rs`と
//! 同じ考え方(実際に動かして確かめる)で、回帰テスト専用API
//! (`write_copc_from_spill_with_fs_and_batch_sizes`。本番の変換経路は使わない)
//! が返す「バッチごとに実際に処理したノード数」の記録を使って確かめる。
//! 点数が10倍違う2つの入力で変換し、**観測された最大バッチサイズが一致する**
//! (ノード数が10倍になっても、同時に圧縮するノード数の上限は変わらない)ことを
//! 確認する。

use std::path::Path;

use copc_core::{LasPointRecord, NeverCancel, StreamingLayout};
use copc_writer::{
    write_copc_from_spill_with_fs_and_batch_sizes, CopcWriteMetadata, CopcWriterParams,
    MemoryScratchFs, SpillWriter,
};

/// x/y/z全軸に散らした決定的な合成点群(多段のoctree分割を実際に起こすため)。
fn record(seed: u32) -> LasPointRecord {
    let f = f64::from(seed);
    LasPointRecord {
        x: (f * 1.5) % 10_000.0,
        y: (f * 2.25) % 10_000.0,
        z: (f * 0.75) % 10_000.0,
        return_number: 1,
        number_of_returns: 1,
        ..LasPointRecord::default()
    }
}

/// `point_count`個の合成点群を並列圧縮で変換し、実際に観測されたバッチ
/// (`rayon`の`par_iter`へ一度に渡したノードのまとまり)ごとのノード数を返す。
fn batch_sizes_for(point_count: u32, max_points_per_node: u32) -> Vec<usize> {
    let fs = MemoryScratchFs::new();
    let layout = StreamingLayout {
        point_format: 0,
        has_gps: false,
        has_color: false,
        has_nir: false,
        has_waveform: false,
        extra_bytes: 0,
        extra_bytes_descriptors: Vec::new(),
    };
    let mut spill = SpillWriter::create(&fs, layout).expect("SpillWriter::create");
    for seed in 0..point_count {
        spill.push(&record(seed)).expect("spill.push");
    }
    let spill_reader = spill.finalize().expect("spill.finalize");

    let output_path = Path::new("batch_bounded.copc.laz");
    write_copc_from_spill_with_fs_and_batch_sizes(
        &fs,
        output_path,
        spill_reader,
        &CopcWriterParams::new(max_points_per_node).with_parallel_node_compression(true),
        &NeverCancel,
        &CopcWriteMetadata::default(),
    )
    .expect("write_copc_from_spill_with_fs_and_batch_sizes")
}

#[test]
fn compress_batch_size_does_not_scale_with_node_count() {
    const MAX_POINTS_PER_NODE: u32 = 20;
    // ノード数が確実に`2 * rayon::current_num_threads()`を超えるよう、
    // 小さい方でも十分な数のノードができる規模にする(CIの2〜4スレッド、
    // 開発機の20スレッド超のどちらでも上限に張り付くように余裕を取った)。
    let small = batch_sizes_for(100_000, MAX_POINTS_PER_NODE);
    let large = batch_sizes_for(1_000_000, MAX_POINTS_PER_NODE);

    assert!(
        !small.is_empty(),
        "バッチが一度も記録されていない(テスト不備)"
    );
    assert!(
        !large.is_empty(),
        "バッチが一度も記録されていない(テスト不備)"
    );

    // 両方とも複数バッチに分かれていること(1バッチで収まる規模だと
    // 「上限に張り付いている」ことを確認できないため)。
    assert!(
        small.len() > 1,
        "小さい方が1バッチで収まってしまった(ノード数が少なすぎる): {small:?}"
    );
    assert!(
        large.len() > 1,
        "大きい方が1バッチで収まってしまった: {large:?}"
    );

    let small_max = *small.iter().max().unwrap();
    let large_max = *large.iter().max().unwrap();
    let small_nodes: usize = small.iter().sum();
    let large_nodes: usize = large.iter().sum();

    assert_eq!(
        small_max, large_max,
        "最大バッチサイズ(同時に圧縮するノード数)がノード数に応じて変わっている: \
         小({small_nodes}ノード、最大バッチ{small_max})・大({large_nodes}ノード、\
         最大バッチ{large_max})。`2 * rayon::current_num_threads()`で頭打ちに\
         なっているはず"
    );
    assert!(
        large_nodes >= small_nodes * 5,
        "テスト不備: ノード数が10倍の入力で、実際のノード数が十分に増えていない \
         (小{small_nodes}・大{large_nodes})"
    );
}
