//! M4-6/M4-9追記(`TaskSheets/M4-import-and-conversion.md`): Web版のPCD→COPC
//! 変換(`crates/pcv-wasm/src/pcd_import.rs`の`WasmPcdConverter`)が使う部品を、
//! `MemoryScratchFs`に対してネイティブで検証する統合テスト。
//!
//! `WasmPcdConverter`自体は`web_sys::File`・`FileSystemSyncAccessHandle`という
//! ブラウザ専用の型を引数に取るためネイティブからは直接呼べない
//! (`memory_scratch_conversion.rs`と同じ事情)。代わりに、`WasmPcdConverter`が
//! 内部で使うのと同じ部品(`pcd_rs::DynReader`でフィールドを読み取り、
//! `SpillWriter::create`/`push`/`finalize`→`write_copc_from_spill_with_fs`)を
//! `MemoryScratchFs`に対して直接呼ぶことで、「PCDのバッチ読み込み→spill→COPC」
//! という設計が正しく動くことを検証する。
//!
//! x/y/z・rgb(パック済み)・intensityを持つ、複数ノードに分かれる程度に
//! 散らした合成PCD(binary形式)を`pcd-rs`自身の`DynWriter`で作る
//! (`crates/pcv-convert/tests/import_pcd.rs`と同じ考え方)。

use std::io::BufReader;

use copc_core::{LasPointRecord, NeverCancel, StreamingLayout};
use copc_writer::{
    write_copc_from_spill_with_fs, CopcWriteMetadata, CopcWriterParams, MemoryScratchFs,
    SpillWriter,
};
use pcd_rs::{DataKind, DynReader, DynRecord, DynWriter, Field, Schema, ValueKind, WriterInit};

fn xyz_rgb_intensity_schema() -> Schema {
    Schema::from_iter([
        ("x", ValueKind::F32, 1),
        ("y", ValueKind::F32, 1),
        ("z", ValueKind::F32, 1),
        ("rgb", ValueKind::F32, 1),
        ("intensity", ValueKind::F32, 1),
    ])
}

/// x/y/z全軸に散らした、複数ノードに分かれる程度の合成PCD(binary)を書く。
fn write_synthetic_pcd(path: &std::path::Path, point_count: u32) {
    let mut writer: DynWriter<_> = WriterInit {
        width: u64::from(point_count),
        height: 1,
        viewpoint: Default::default(),
        data_kind: DataKind::Binary,
        schema: Some(xyz_rgb_intensity_schema()),
        version: None,
    }
    .create(path)
    .expect("create pcd writer");

    for i in 0..point_count {
        let x = f32::from((i * 37 % 500) as u16) * 0.1;
        let y = f32::from((i * 53 % 500) as u16) * 0.1;
        let z = f32::from((i * 13 % 200) as u16) * 0.1;
        let rgb = pcd_rs::rgb_to_float(
            (i % 256) as u8,
            ((i * 3) % 256) as u8,
            ((i * 7) % 256) as u8,
        );
        let record = DynRecord(vec![
            Field::F32(vec![x]),
            Field::F32(vec![y]),
            Field::F32(vec![z]),
            Field::F32(vec![rgb]),
            Field::F32(vec![(i % 1000) as f32]),
        ]);
        writer.push(&record).expect("push point");
    }
    writer.finish().expect("finish pcd writer");
}

#[test]
fn batched_pcd_feed_via_memory_scratch_fs_produces_openable_copc() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("synthetic.pcd");
    let point_count = 2_000u32;
    write_synthetic_pcd(&source, point_count);

    // `WasmPcdConverter::new`と同じ手順: フィールドの位置を名前で探す。
    let file = std::fs::File::open(&source).unwrap();
    let reader = DynReader::from_reader(BufReader::new(file)).expect("DynReader::from_reader");
    let meta = reader.meta().clone();
    let field_index = |name: &str| meta.field_defs.iter().position(|f| f.name == name);
    let ix = field_index("x").expect("xフィールドが無い");
    let iy = field_index("y").expect("yフィールドが無い");
    let iz = field_index("z").expect("zフィールドが無い");
    let i_rgb = field_index("rgb");
    let i_intensity = field_index("intensity");
    assert_eq!(meta.num_points, u64::from(point_count));

    let layout = StreamingLayout {
        point_format: 0,
        has_gps: false,
        has_color: i_rgb.is_some(),
        has_nir: false,
        has_waveform: false,
        extra_bytes: 0,
        extra_bytes_descriptors: Vec::new(),
    };
    let fs = MemoryScratchFs::new();
    let mut spill = SpillWriter::create(&fs, layout).expect("SpillWriter::create");

    // `WasmPcdConverter::feed`と同じ手順: バッチに分けて読み、spillへ書く。
    const BATCH_SIZE: usize = 256;
    let mut fed = 0u64;
    let mut iter = reader.into_iter();
    loop {
        let mut read_in_batch = 0;
        while read_in_batch < BATCH_SIZE {
            match iter.next() {
                Some(Ok(record)) => {
                    let field_to_f64 = |f: &Field| match f {
                        Field::F32(v) => f64::from(v.first().copied().unwrap_or(0.0)),
                        _ => 0.0,
                    };
                    let x = field_to_f64(&record.0[ix]);
                    let y = field_to_f64(&record.0[iy]);
                    let z = field_to_f64(&record.0[iz]);
                    let intensity = i_intensity
                        .map(|i| {
                            field_to_f64(&record.0[i])
                                .round()
                                .clamp(0.0, u16::MAX as f64) as u16
                        })
                        .unwrap_or(0);
                    spill
                        .push(&LasPointRecord {
                            x,
                            y,
                            z,
                            intensity,
                            ..LasPointRecord::default()
                        })
                        .expect("spill.push");
                    fed += 1;
                    read_in_batch += 1;
                }
                Some(Err(e)) => panic!("PCDレコードの読み出しに失敗: {e}"),
                None => break,
            }
        }
        if read_in_batch == 0 {
            break;
        }
    }
    assert_eq!(fed, u64::from(point_count), "全点がspillへ渡されたはず");

    // `WasmPcdConverter::finish`と同じ手順。スケール・オフセットは
    // (`pcd_import.rs`の`choose_scale_offset`に専用の単体テストがあるため)
    // このテストでは`CopcWriteMetadata::default()`の既定値をそのまま使う
    // (`memory_scratch_conversion.rs`と同じ簡略化)。
    let spill_reader = spill.finalize().expect("spill.finalize");
    let output_path = std::path::Path::new("synthetic_pcd.copc.laz");
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
