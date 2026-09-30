//! M4-6b: 「メモリ上のScratchFsを使った変換の統合テスト」(受け入れ条件)。
//!
//! `crates/pcv-wasm/src/convert.rs`の`WasmConverter`は`web_sys::File`・
//! `FileSystemSyncAccessHandle`というブラウザ専用の型を引数に取るため、
//! ネイティブターゲットのテストからは直接呼べない。その代わり、
//! `WasmConverter::feed`/`finish`が内部で使うのと**同じ関数**
//! (`copc_writer::SpillWriter::create`/`push`/`finalize`と
//! `write_copc_from_spill_with_fs`)を、OPFSではなく
//! `copc_writer::MemoryScratchFs`(`Vec<u8>`だけで完結する実装。
//! `vendor/copc-writer/src/scratch.rs`)に対して呼ぶことで、
//! 「TypeScript側からバッチ単位で駆動する」という設計そのもの
//! (バッチに分けてspillへpushし、最後に`finish`相当の呼び出しでoctreeを
//! 構築する)が正しく動くことをネイティブで検証する。
//!
//! `vendor/copc-writer`本体の`ScratchFs`抽象がバイト単位で挙動を変えて
//! いないことは`crates/pcv-convert/tests/streaming_conversion.rs`の
//! `native_output_hash_matches_recorded_value`で別途確認済み(`NativeScratchFs`
//! 側)。このテストは**OPFS向けの`ScratchFs`利用パターン(バッチ駆動)**が
//! 壊れていないかを検証する、目的の異なるテストである。

use copc_core::{LasPointRecord, NeverCancel, StreamingLayout};
use copc_writer::{
    write_copc_from_spill_with_fs, CopcWriteMetadata, CopcWriterParams, MemoryScratchFs,
    SpillWriter,
};

/// x/y/z全軸に散らした決定的な合成点群を書いたLASファイルを作る
/// (`crates/pcv-convert/tests/streaming_conversion.rs`の
/// `write_synthetic_las_scattered_in_3d`と同じ考え方: 1ノードしかできないと
/// octree分割ロジックをほとんど検証できないため)。
fn write_synthetic_las(path: &std::path::Path, point_count: u32) {
    let mut builder = las::Builder::from((1, 2));
    builder.point_format = las::point::Format::new(2).expect("format 2(RGBあり)");
    let header = builder.into_header().expect("valid header");
    let mut writer = las::Writer::from_path(path, header).expect("LAS writerの作成に失敗");
    for i in 0..point_count {
        let x = f64::from((i * 37) % 500) * 0.1;
        let y = f64::from((i * 53) % 500) * 0.1;
        let z = f64::from((i * 13) % 200) * 0.1;
        let point = las::Point {
            x,
            y,
            z,
            intensity: (i % 1000) as u16,
            color: Some(las::Color {
                red: (i % 256) as u16,
                green: ((i * 3) % 256) as u16,
                blue: ((i * 7) % 256) as u16,
            }),
            ..Default::default()
        };
        writer.write_point(point).expect("点の書き込みに失敗");
    }
    writer.close().expect("LAS writerのクローズに失敗");
}

#[test]
fn batched_feed_via_memory_scratch_fs_produces_openable_copc() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("synthetic.las");
    let point_count = 2_000u32;
    write_synthetic_las(&source, point_count);

    // `WasmConverter::new`と同じ手順: ヘッダーからlayout/metadata/総点数を取る。
    let mut reader = las::Reader::new(std::io::BufReader::new(
        std::fs::File::open(&source).unwrap(),
    ))
    .unwrap();
    let layout = StreamingLayout::from_las_header(reader.header());
    let total_points = reader.header().number_of_points();
    assert_eq!(total_points, u64::from(point_count));
    let mut point_data = las::PointDataBuilder::new()
        .for_header(reader.header())
        .build();

    let fs = MemoryScratchFs::new();
    let mut spill = SpillWriter::create(&fs, layout).expect("SpillWriter::create");

    // `WasmConverter::feed`と同じ手順: 小さいバッチに分けて読み、spillへ書く。
    // バッチ境界をまたいでも点が欠けたり重複したりしないことを、後で
    // hierarchyの点数合計と突き合わせて確認する。
    const BATCH_SIZE: u64 = 256;
    let mut fed = 0u64;
    loop {
        let count = reader
            .fill_points(BATCH_SIZE, &mut point_data)
            .expect("fill_points");
        if count == 0 {
            break;
        }
        for result in point_data.points() {
            let point = result.expect("点の読み出しに失敗");
            spill
                .push(&LasPointRecord::from_las_point(&point))
                .expect("spill.push");
            fed += 1;
        }
    }
    assert_eq!(fed, u64::from(point_count), "全点がspillへ渡されたはず");

    // `WasmConverter::finish`と同じ手順。
    let spill_reader = spill.finalize().expect("spill.finalize");
    let output_path = std::path::Path::new("synthetic.copc.laz");
    write_copc_from_spill_with_fs(
        &fs,
        output_path,
        spill_reader,
        &CopcWriterParams::new(50),
        &NeverCancel,
        &CopcWriteMetadata::default(),
    )
    .expect("write_copc_from_spill_with_fs");

    let bytes = fs
        .take_output(output_path)
        .expect("MemoryScratchFsに出力が記録されているはず");

    // `pcv-core`(実際のビューアが使う読み込み側)で開けることを確認する
    // (M4-6bの受け入れ条件「OPFS上で変換し、そのまま開ける経路がある」の
    // うち、OPFS以外の部分をここで検証する)。
    let mut copc = pcv_core::CopcFile::from_reader(std::io::Cursor::new(bytes))
        .expect("pcv-coreで開けなかった");
    assert_eq!(copc.info().point_count, u64::from(point_count));

    let nodes: Vec<_> = copc.hierarchy().nodes().cloned().collect();
    assert!(!nodes.is_empty(), "hierarchyにノードが無い");
    let mut total_read = 0u32;
    for node in nodes {
        let result = copc.read_node(node.key).expect("ノード読み出しに失敗した");
        total_read += result.point_count;
    }
    assert_eq!(
        total_read, point_count,
        "hierarchyの申告点数と実際に読めた点数が一致するはず"
    );
}
