//! M4-7追記(2026-10-07緊急修正)の受け入れ条件: 展開Workerをバッチ単位で
//! 駆動するようにした結果、`crates/pcv-wasm/src/convert.rs`の
//! `push_serialized_records`(= `copc_core::deserialize_le`→
//! `SpillWriter::push`)が呼ばれる**順序**は、以前の「範囲の昇順で取り出す」
//! から「どのバッチが先に届いたか(到着順)」に変わった
//! (`src/datasource/copc.worker.ts`の`runParallelReadPhase`、各展開Workerが
//! 独立に`requestBatch`へ応答するpull型プロトコル参照)。
//!
//! `crates/pcv-wasm/src/convert.rs`のモジュールドキュメント「点の順序について」
//! (M4-7)が既に述べているとおり、`SpillWriter::push`に渡す順序が変わっても
//! `copc-writer`の検証(`validate_spill_record`)・統計(`PointStats`)は1点ごとに
//! 閉じた計算で順序に依存しない(ソースを読んで確認済み)。このテストは、
//! その結論を**実際に`write_copc_from_spill_with_fs`まで通して**確認する:
//! 同じ点の集合を(1)元の順序、(2)複数Workerへの分担を模した「ラウンドロビンで
//! 入れ替えた順序」でそれぞれ`SpillWriter`へpushし、別々のCOPCへ書き出した上で、
//! 両方を`las::Reader`で開き直して**点の集合が一致する**ことを確認する。
//!
//! (`las::Reader`でCOPC出力を開き直せること自体は`crates/pcv-convert/tests/
//! streaming_conversion.rs`で既に行われている。COPCはLAS 1.4 + 可変チャンクの
//! LASzipという、点データ部分だけ見れば通常のLAS/LAZ読み出し経路と同じ形に
//! なるように設計されているため)。

use std::collections::BTreeSet;
use std::io::Cursor;

use copc_core::{LasPointRecord, NeverCancel, StreamingLayout};
use copc_writer::{write_copc_from_spill_with_fs, CopcWriterParams, MemoryScratchFs, SpillWriter};

/// 整数演算で決まる、決定的な合成点群を作る(浮動小数点の誤差で集合比較が
/// 揺れないようにするため。`parallel_laz_decompression.rs`と同じ考え方)。
fn synthetic_records(point_count: u32) -> Vec<LasPointRecord> {
    (0..point_count)
        .map(|i| LasPointRecord {
            x: f64::from((i * 37) % 5_000) * 0.1,
            y: f64::from((i * 53) % 5_000) * 0.1,
            z: f64::from((i * 13) % 2_000) * 0.1,
            intensity: (i % 1000) as u16,
            ..LasPointRecord::default()
        })
        .collect()
}

/// `records`を`worker_count`個のグループに均等に分け、各グループの先頭から
/// 1個ずつ・ラウンドロビンで取り出す順序を返す。複数の展開Workerが
/// 独立に`requestBatch`へ応答し、到着順にpushされる(=各Workerの担当範囲内の
/// 順序は保たれるが、Worker間では入れ替わる)新しいpull型プロトコルの
/// 「最悪に近い」並び替えを模している。
fn round_robin_across_workers(
    records: &[LasPointRecord],
    worker_count: usize,
) -> Vec<LasPointRecord> {
    let total = records.len();
    let base = total / worker_count;
    let mut groups: Vec<&[LasPointRecord]> = Vec::with_capacity(worker_count);
    let mut start = 0;
    for i in 0..worker_count {
        let len = if i == worker_count - 1 {
            total - start
        } else {
            base
        };
        groups.push(&records[start..start + len]);
        start += len;
    }

    let mut out = Vec::with_capacity(total);
    let mut indices = vec![0usize; worker_count];
    loop {
        let mut advanced = false;
        for (g, group) in groups.iter().enumerate() {
            if indices[g] < group.len() {
                out.push(group[indices[g]].clone());
                indices[g] += 1;
                advanced = true;
            }
        }
        if !advanced {
            break;
        }
    }
    out
}

/// `records`を渡された順序でそのままSpillWriterへpushし、COPCへ書き出した上で
/// `las::Reader`で開き直し、(点数, 座標+intensityの集合)を返す。
fn push_order_and_reopen(records: &[LasPointRecord]) -> (u64, BTreeSet<(u64, u64, u64, u16)>) {
    let layout = StreamingLayout {
        point_format: 0,
        has_gps: false,
        has_color: false,
        has_nir: false,
        has_waveform: false,
        extra_bytes: 0,
        extra_bytes_descriptors: Vec::new(),
    };
    let fs = MemoryScratchFs::new();
    let mut spill = SpillWriter::create(&fs, layout).expect("SpillWriterを作れなかった");
    for record in records {
        spill.push(record).expect("pushに失敗した");
    }
    let reader = spill.finalize().expect("finalizeに失敗した");

    write_copc_from_spill_with_fs(
        &fs,
        std::path::Path::new("out.copc.laz"),
        reader,
        &CopcWriterParams::new(500),
        &NeverCancel,
        &Default::default(),
    )
    .expect("write_copc_from_spill_with_fsに失敗した");

    let bytes = fs
        .take_output(std::path::Path::new("out.copc.laz"))
        .expect("出力を読めなかった");

    let mut las_reader = las::Reader::new(Cursor::new(bytes)).expect("las::Readerで開けなかった");
    let mut point_data = las::PointDataBuilder::new()
        .for_header(las_reader.header())
        .build();

    let mut count = 0u64;
    let mut set = BTreeSet::new();
    loop {
        let n = las_reader
            .fill_points(65_536, &mut point_data)
            .expect("fill_pointsに失敗した");
        if n == 0 {
            break;
        }
        for result in point_data.points() {
            let point = result.expect("点のデコードに失敗した");
            set.insert((
                point.x.to_bits(),
                point.y.to_bits(),
                point.z.to_bits(),
                point.intensity,
            ));
            count += 1;
        }
    }
    (count, set)
}

#[test]
fn reordered_push_matches_sequential_push_point_set() {
    const POINT_COUNT: u32 = 20_000;
    const WORKER_COUNT: usize = 4;

    let records = synthetic_records(POINT_COUNT);
    let reordered = round_robin_across_workers(&records, WORKER_COUNT);
    assert_eq!(
        reordered.len(),
        records.len(),
        "並べ替え後も点数は変わらないはず"
    );

    let (sequential_count, sequential_set) = push_order_and_reopen(&records);
    let (reordered_count, reordered_set) = push_order_and_reopen(&reordered);

    assert_eq!(sequential_count, u64::from(POINT_COUNT));
    assert_eq!(
        sequential_count, reordered_count,
        "順序を変えてpushすると点数が変わった"
    );
    assert_eq!(
        sequential_set, reordered_set,
        "順序を変えてpushすると座標+intensityの集合が変わった \
         (SpillWriter::pushが順序に依存する処理をしている可能性がある)"
    );
}
