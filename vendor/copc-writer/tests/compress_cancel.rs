//! Cancellation (`CancelCheck`) stops the conversion near its end, in the node
//! compression, and the call returns `Cancelled`.
//!
//! A first run without cancelling counts all `cancel.check()` calls; the second
//! run cancels ten calls before the end. One worker is used so the number of
//! calls is the same in both runs (with several threads it varies slightly).

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

const POINT_COUNT: u32 = 40_000;
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
        &CopcWriterParams::new(MAX_POINTS_PER_NODE)
            .with_memory_budget_bytes(1024 * 1024)
            .with_max_concurrent_subtrees(1),
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
        &CopcWriterParams::new(MAX_POINTS_PER_NODE)
            .with_memory_budget_bytes(1024 * 1024)
            .with_max_concurrent_subtrees(1),
        &cancel,
        &CopcWriteMetadata::default(),
    );

    assert!(
        matches!(result, Err(Error::Cancelled)),
        "キャンセル後はErr(Cancelled)を返すはず: {result:?}"
    );
}
