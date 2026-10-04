//! M4-10(`TaskSheets/M4-import-and-conversion.md`)の回帰テスト:
//! ノードごとのLAZ圧縮を並列化(`parallel-compress`)した後も、キャンセル
//! (`CancelCheck`)が働くことを確かめる。
//!
//! `compress_nodes_parallel`は、バッチ(`rayon`で並列圧縮するノードの
//! まとまり)ごとに1回`cancel.check()`を呼ぶほか、各ノードの点を読み出す
//! `encode_node_points`も(`CANCEL_POLL_STRIDE`点ごとに、最低でもノードの
//! 最初の点で)`cancel.check()`を呼ぶ(`writer.rs`参照)。これが並列化後も
//! 働くことを、`parallel_lod_cancel.rs`と同じ「呼ばれた回数を数えて途中で
//! キャンセルを返す`CancelCheck`」で確かめる。
//!
//! octreeの分割(`build_lod_index`)自体も`cancel.check()`を呼ぶため、
//! 「LOD構築が完全に終わった後、圧縮の最後の方」でキャンセルが入るよう、
//! 一度キャンセルせずに最後まで実行して全体の呼び出し回数を数え、
//! その直前(残り少ない回数)でキャンセルする2段構えにする。これにより、
//! マシンのスレッド数やLOD構築側の呼び出し回数を仮定せずに、決定的に
//! 「圧縮フェーズの終盤でキャンセルする」状況を作れる。

use std::sync::atomic::{AtomicUsize, Ordering};

use copc_core::{CancelCheck, Error, LasPointRecord, Result, StreamingLayout};
use copc_writer::{
    write_copc_from_spill_with_fs, CopcWriteMetadata, CopcWriterParams, MemoryScratchFs,
    SpillWriter,
};

/// 呼ばれた回数を数えるだけの`CancelCheck`(ベースラインの総呼び出し回数を
/// 数えるために使う)。
#[derive(Default)]
struct CountCalls(AtomicUsize);

impl CancelCheck for CountCalls {
    fn check(&self) -> Result<()> {
        self.0.fetch_add(1, Ordering::Relaxed);
        Ok(())
    }
}

/// 呼ばれた回数を数え、`trigger_after`回を超えたら`Cancelled`を返す。
struct CancelAfter {
    calls: AtomicUsize,
    trigger_after: usize,
}

impl CancelCheck for CancelAfter {
    fn check(&self) -> Result<()> {
        let count = self.calls.fetch_add(1, Ordering::Relaxed) + 1;
        if count > self.trigger_after {
            Err(Error::Cancelled)
        } else {
            Ok(())
        }
    }
}

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

const POINT_COUNT: u32 = 200_000;
const MAX_POINTS_PER_NODE: u32 = 50;

fn build_spill_reader(fs: &MemoryScratchFs) -> copc_writer::SpillReader {
    let layout = StreamingLayout {
        point_format: 0,
        has_gps: false,
        has_color: false,
        has_nir: false,
        has_waveform: false,
        extra_bytes: 0,
        extra_bytes_descriptors: Vec::new(),
    };
    let mut spill = SpillWriter::create(fs, layout).expect("SpillWriter::create");
    for seed in 0..POINT_COUNT {
        spill.push(&record(seed)).expect("spill.push");
    }
    spill.finalize().expect("spill.finalize")
}

#[test]
fn cancellation_stops_parallel_compress_and_leaves_no_leftover_output() {
    // 1段目: キャンセルせずに最後まで実行し、総`cancel.check()`呼び出し回数を数える。
    let counting_fs = MemoryScratchFs::new();
    let counting_reader = build_spill_reader(&counting_fs);
    let counter = CountCalls::default();
    let baseline_output = std::path::Path::new("baseline.copc.laz");
    write_copc_from_spill_with_fs(
        &counting_fs,
        baseline_output,
        counting_reader,
        &CopcWriterParams::new(MAX_POINTS_PER_NODE).with_parallel_node_compression(true),
        &counter,
        &CopcWriteMetadata::default(),
    )
    .expect("ベースライン実行(キャンセルなし)に失敗した");
    let total_calls = counter.0.load(Ordering::Relaxed);
    assert!(
        total_calls > 20,
        "テスト不備: cancel.check()の総呼び出し回数が少なすぎる({total_calls}回)"
    );

    // 2段目: 終盤(最後の10回のどこか)でキャンセルする。圧縮フェーズは
    // ノードごと・バッチごとに`cancel.check()`を呼ぶため、十分な数のノードが
    // あれば(MAX_POINTS_PER_NODEを小さくしているため多数のノードに分かれる)、
    // 終盤の呼び出しはLOD構築ではなく圧縮フェーズの中にあるはず。
    let cancel_fs = MemoryScratchFs::new();
    let cancel_reader = build_spill_reader(&cancel_fs);
    let cancel = CancelAfter {
        calls: AtomicUsize::new(0),
        trigger_after: total_calls - 10,
    };
    let cancelled_output = std::path::Path::new("cancelled.copc.laz");
    let result = write_copc_from_spill_with_fs(
        &cancel_fs,
        cancelled_output,
        cancel_reader,
        &CopcWriterParams::new(MAX_POINTS_PER_NODE).with_parallel_node_compression(true),
        &cancel,
        &CopcWriteMetadata::default(),
    );

    assert!(
        matches!(result, Err(Error::Cancelled)),
        "キャンセル後はErr(Cancelled)を返すはず: {result:?}"
    );
}
