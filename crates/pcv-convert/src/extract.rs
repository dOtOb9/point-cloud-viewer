//! L2-C: 「COPCを読み、条件に合う点だけを新しいCOPCに書く」(デスクトップ・Android)。
//!
//! 点群ツール(点の選択・断面)の本体。選んだレイヤーから新しいレイヤーを作る
//! (`TaskSheets/ADR-0018-layer-centric-operations.md`)ため、**元のファイルは
//! 書き換えない**。
//!
//! # 設計: 新しいoctree/writerを書かない
//!
//! 結合(`merge.rs`)と同じ流し方にした。条件に合う点を1点ずつ返すイテレータ
//! (`pcv_core::extract::ExtractPoints`。条件と交わるノードだけを読む)を、
//! `vendor/copc-writer`の `write_streaming_with_cancel_and_timings` に渡すだけで、
//! octree分割・LAZ圧縮・COPC階層の組み立てを全部やってくれる。
//! 読む側が抱えるのは常に1ノード分の点だけ、書く側(copc-writer)は一時ファイル
//! (spill)に書き出すので、**メモリは点数に比例しない**(`ExtractPoints`の
//! ドキュメントとテスト`buffer_is_bounded_by_largest_node`参照)。
//!
//! 採らなかった案: 条件に合う点を一度`Vec`に集めてから書く。選んだ範囲が数億点
//! になりうる(広い範囲を選ぶ)ので、メモリが点数に比例してしまう。
//!
//! # 0点のとき
//!
//! 条件に合う点が1つも無ければ、出力は作らずエラー(`ExtractError::EmptySelection`、
//! 本文「選んだ範囲に点がありません」)にする。最初の1点を先に取り出して
//! (`peek`)から書き出しを始めるので、0点のときは一時ファイルも作らない。
//!
//! # 属性
//!
//! `read_node`が返す`las::Point`を`LasPointRecord::from_las_point`に通すだけなので、
//! RGB・強度・分類・GPS時刻・戻り番号などは書き出し先にそのまま引き継がれる。
//! レイアウト(point format・色・extra bytes)と出力のメタデータ(scale/offset・CRS)は
//! 元のCOPCのヘッダーから`merge.rs`と同じ関数で作る。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use copc_core::{CancelCheck, StreamingLayout};
use copc_reader::CopcReader;
use copc_writer::{write_streaming_with_cancel_and_timings, CopcWriterParams};
use pcv_core::extract::{ExtractFilter, ExtractPoints, ExtractStats};

use crate::stage_timings::ConversionStageTimings;
use crate::streaming::ReadProgress;
use crate::write_metadata::copc_write_metadata_from_source_header;

#[derive(Debug, thiserror::Error)]
pub enum ExtractError {
    /// 利用者向けの本文。画面にそのまま出す。
    #[error("選んだ範囲に点がありません")]
    EmptySelection,
    #[error("抽出の条件が正しくありません: {0}")]
    Filter(String),
    #[error("{path}: 点群(COPC)として開けませんでした: {source}")]
    Open {
        path: PathBuf,
        #[source]
        source: copc_core::Error,
    },
    #[error("{path}: ヘッダーを読めませんでした: {source}")]
    OpenHeader {
        path: PathBuf,
        #[source]
        source: las::Error,
    },
    #[error("点を読めませんでした: {0}")]
    Read(#[source] copc_core::Error),
    #[error("COPCの書き出しに失敗しました: {0}")]
    Write(#[source] copc_core::Error),
}

impl ExtractError {
    /// キャンセルで止まったか(画面では「キャンセルされた」として扱う)。
    pub fn is_cancelled(&self) -> bool {
        matches!(
            self,
            ExtractError::Read(copc_core::Error::Cancelled)
                | ExtractError::Write(copc_core::Error::Cancelled)
        )
    }
}

/// 抽出の結果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExtractSummary {
    /// 出力した点数。
    pub point_count: u64,
    pub stats: ExtractStats,
}

/// `source`(COPC)から`filter`に合う点だけを`output`(COPC)へ書く。
///
/// - `on_progress`: ノードを1つ読むたびに呼ぶ。`points_read`=ここまでに読んだ点数、
///   `total_points`=読む予定のノードの点数の合計(条件と交わるノードだけの合計なので、
///   元のファイルの総点数より小さい)。読み終えたあとの後処理(書き出し)の間は呼ばれない。
/// - `cancel`: 読む側(ノードごと)と書く側の両方で確認する。
#[allow(clippy::too_many_arguments)]
pub fn extract_path_and_timings<F>(
    source: &Path,
    filter: ExtractFilter,
    output: &Path,
    spill_dir: &Path,
    params: &CopcWriterParams,
    cancel: &(dyn CancelCheck + Sync),
    mut on_progress: F,
    timings: &mut ConversionStageTimings,
) -> Result<ExtractSummary, ExtractError>
where
    F: FnMut(ReadProgress) + Send,
{
    filter.validate().map_err(ExtractError::Filter)?;

    // レイアウトと出力のメタデータは、`las`でヘッダーだけ読んで作る
    // (`merge.rs`の`summarize_headers`と同じ。点データはここでは読まない)。
    let header_reader =
        las::Reader::from_path(source).map_err(|source_err| ExtractError::OpenHeader {
            path: source.to_path_buf(),
            source: source_err,
        })?;
    let layout = StreamingLayout::from_las_header(header_reader.header());
    let metadata = copc_write_metadata_from_source_header(header_reader.header());
    drop(header_reader);

    let copc_reader = CopcReader::from_path(source).map_err(|e| ExtractError::Open {
        path: source.to_path_buf(),
        source: e,
    })?;
    let mut points = ExtractPoints::new(copc_reader, filter).map_err(ExtractError::Read)?;

    // コールバックは書き出しにイテレータを渡したあとも動くので、最後の統計は
    // 共有の入れ物(`last_stats`)に書き残す。
    let last_stats = Arc::new(Mutex::new(points.stats()));
    let last_stats_in_callback = Arc::clone(&last_stats);
    points.set_node_callback(Box::new(move |stats: &ExtractStats| {
        if let Ok(mut guard) = last_stats_in_callback.lock() {
            *guard = *stats;
        }
        cancel.check()?;
        on_progress(ReadProgress {
            points_read: stats.points_scanned,
            total_points: stats.candidate_points,
        });
        Ok(())
    }));

    // 最初の1点を先に取り出す。無ければ書き出しを始めずにエラーにする。
    let first = match points.next() {
        None => return Err(ExtractError::EmptySelection),
        Some(Err(e)) => return Err(ExtractError::Read(e)),
        Some(Ok(record)) => record,
    };
    // 書き出しに渡した点を数える(`ExtractStats::points_matched`は、イテレータが
    // 点を返すたびに増えるので、書き出しにイテレータを渡したあとは取り出せない)。
    let written = Arc::new(AtomicU64::new(0));
    let written_in_iter = Arc::clone(&written);
    let all_points = std::iter::once(Ok(first))
        .chain(points)
        .inspect(move |item| {
            if item.is_ok() {
                written_in_iter.fetch_add(1, Ordering::Relaxed);
            }
        });

    let mut ingest = copc_writer::IngestStageTimings::default();
    let mut post = copc_writer::PostProcessStageTimings::default();
    write_streaming_with_cancel_and_timings(
        output,
        layout,
        all_points,
        params,
        &metadata,
        spill_dir,
        cancel,
        Some(&mut ingest),
        Some(&mut post),
    )
    .map_err(ExtractError::Write)?;
    *timings = ConversionStageTimings::from_parts(ingest, post);

    // ノードを読み終えた時点の統計(最後のノードの分まで入っている)に、数えた点数を足す。
    let mut stats = last_stats
        .lock()
        .map(|guard| *guard)
        .map_err(|_| ExtractError::Read(copc_core::Error::InvalidInput("統計の取得に失敗".into())))?;
    let point_count = written.load(Ordering::Relaxed);
    stats.points_matched = point_count;
    Ok(ExtractSummary { point_count, stats })
}

#[cfg(test)]
mod tests {
    use super::*;

    use copc_core::NeverCancel;
    use pcv_core::extract::OrientedBox;
    use pcv_core::CopcFile;

    /// 一辺`side`点の立方体格子(間隔1m、原点(1000,2000,30))のLAS(PDRF7、色あり)を書く。
    /// 強度=通し番号(下位16bit)、分類=通し番号%5、色は座標から決める。
    fn write_grid_las(path: &Path, side: u32) {
        let mut builder = las::Builder::from((1, 4));
        builder.point_format = las::point::Format::new(7).expect("PDRF7");
        builder.transforms = las::Vector {
            x: las::Transform {
                scale: 0.001,
                offset: 0.0,
            },
            y: las::Transform {
                scale: 0.001,
                offset: 0.0,
            },
            z: las::Transform {
                scale: 0.001,
                offset: 0.0,
            },
        };
        let header = builder.into_header().expect("header");
        let file = std::fs::File::create(path).expect("create las");
        let mut writer = las::Writer::new(std::io::BufWriter::new(file), header).expect("writer");
        let mut n: u32 = 0;
        for ix in 0..side {
            for iy in 0..side {
                for iz in 0..side {
                    let point = las::Point {
                        x: 1000.0 + f64::from(ix),
                        y: 2000.0 + f64::from(iy),
                        z: 30.0 + f64::from(iz),
                        intensity: (n & 0xFFFF) as u16,
                        classification: las::point::Classification::new((n % 5) as u8)
                            .expect("classification"),
                        gps_time: Some(f64::from(n)),
                        color: Some(las::Color {
                            red: (ix * 100) as u16,
                            green: (iy * 100) as u16,
                            blue: (iz * 100) as u16,
                        }),
                        ..Default::default()
                    };
                    writer.write_point(point).expect("write point");
                    n += 1;
                }
            }
        }
        writer.close().expect("close");
    }

    /// 格子のLASをCOPC(1ノード最大`max_points_per_node`点)にして返す。
    fn make_copc(dir: &Path, side: u32, max_points_per_node: u32) -> PathBuf {
        let las_path = dir.join("grid.las");
        write_grid_las(&las_path, side);
        let copc_path = dir.join("grid.copc.laz");
        let spill = tempfile::tempdir().expect("spill");
        crate::streaming::convert_path(
            &las_path,
            &copc_path,
            spill.path(),
            &CopcWriterParams::new(max_points_per_node),
            &NeverCancel,
            |_| {},
        )
        .expect("convert");
        copc_path
    }

    fn box_filter(min: [f64; 3], max: [f64; 3]) -> ExtractFilter {
        ExtractFilter::OrientedBox(OrientedBox {
            center: [
                (min[0] + max[0]) / 2.0,
                (min[1] + max[1]) / 2.0,
                (min[2] + max[2]) / 2.0,
            ],
            axes: [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]],
            half_extents: [
                (max[0] - min[0]) / 2.0,
                (max[1] - min[1]) / 2.0,
                (max[2] - min[2]) / 2.0,
            ],
        })
    }

    fn run(
        source: &Path,
        filter: ExtractFilter,
        output: &Path,
    ) -> Result<ExtractSummary, ExtractError> {
        let spill = tempfile::tempdir().expect("spill");
        let mut timings = ConversionStageTimings::default();
        extract_path_and_timings(
            source,
            filter,
            output,
            spill.path(),
            &CopcWriterParams::new(500),
            &NeverCancel,
            |_| {},
            &mut timings,
        )
    }

    /// 箱で切り出すと、箱の中の点だけが、座標・強度・分類・色を保ったまま出る。
    #[test]
    fn extracts_points_in_box_and_keeps_attributes() {
        let dir = tempfile::tempdir().expect("tempdir");
        let source = make_copc(dir.path(), 20, 500); // 8000点
        // x:1005..1009, y:2002..2004, z:30..39(全高) → 5*3*10=150点
        let filter = box_filter([1004.5, 2001.5, 29.5], [1009.5, 2004.5, 39.5]);
        let output = dir.path().join("out.copc.laz");
        let summary = run(&source, filter, &output).expect("extract");
        assert_eq!(summary.point_count, 150);

        // 出力をcopc-readerで全点読み、座標と属性を元の格子の規則と突き合わせる。
        let mut reader = CopcReader::from_path(&output).expect("open output");
        assert_eq!(reader.header().number_of_points(), 150);
        let keys: Vec<_> = reader
            .file()
            .hierarchy_entries()
            .filter(|e| e.has_point_data())
            .map(|e| e.key)
            .collect();
        let mut seen = 0usize;
        for key in keys {
            for p in reader.read_node(key).expect("read node") {
                let (ix, iy, iz) = (p.x - 1000.0, p.y - 2000.0, p.z - 30.0);
                assert!((5.0..=9.0).contains(&ix) && (2.0..=4.0).contains(&iy));
                assert!((0.0..=9.0).contains(&iz));
                let color = p.color.expect("色が引き継がれる");
                assert_eq!(f64::from(color.red), ix * 100.0);
                assert_eq!(f64::from(color.green), iy * 100.0);
                assert_eq!(f64::from(color.blue), iz * 100.0);
                // 強度=通し番号(ix*400+iy*20+iz)の下位16bit、分類=通し番号%5。
                let n = (ix as u32) * 400 + (iy as u32) * 20 + iz as u32;
                assert_eq!(u32::from(p.intensity), n & 0xFFFF);
                assert_eq!(u8::from(p.classification), (n % 5) as u8);
                seen += 1;
            }
        }
        assert_eq!(seen, 150);

        // 範囲(ヘッダーのbounds)は切り出した点に縮んでいる。
        let file = CopcFile::open(&output).expect("pcv-core open");
        assert_eq!(file.info().min[0], 1005.0);
        assert_eq!(file.info().max[0], 1009.0);
    }

    /// 画面の多角形でも切り出せる(奥行き=zは全部入る)。
    #[test]
    fn extracts_points_inside_screen_polygon_for_all_depths() {
        let dir = tempfile::tempdir().expect("tempdir");
        let source = make_copc(dir.path(), 20, 500);
        // 真上から見た正射影風: ndc.x = 0.1*(x-1000), ndc.y = 0.1*(y-2000), w=1。
        let mut m = [0.0; 16];
        m[0] = 0.1;
        m[12] = -100.0;
        m[5] = 0.1;
        m[13] = -200.0;
        m[10] = 1.0;
        m[15] = 1.0;
        let filter = ExtractFilter::ScreenPolygon(pcv_core::extract::ScreenPolygon {
            view_proj: m,
            polygon_ndc: vec![[0.25, 0.25], [0.75, 0.25], [0.75, 0.75], [0.25, 0.75]],
        });
        let output = dir.path().join("out.copc.laz");
        let summary = run(&source, filter, &output).expect("extract");
        // x:1002.5..1007.5 → 3..=7の5個、yも5個、zは20個すべて。
        assert_eq!(summary.point_count, 5 * 5 * 20);
        assert!(summary.stats.nodes_read < summary.stats.nodes_total);
    }

    /// 条件が元の一部にしか重ならないとき、重ならないノードは読まない。
    #[test]
    fn skips_nodes_that_do_not_intersect() {
        let dir = tempfile::tempdir().expect("tempdir");
        let source = make_copc(dir.path(), 20, 500);
        let filter = box_filter([1000.0, 2000.0, 30.0], [1002.0, 2002.0, 32.0]);
        let output = dir.path().join("out.copc.laz");
        let summary = run(&source, filter, &output).expect("extract");
        assert_eq!(summary.point_count, 27); // 0..=2 の3x3x3
        let s = summary.stats;
        assert!(s.nodes_total > 4, "ノードが複数に分かれている前提: {s:?}");
        assert!(
            s.nodes_read < s.nodes_total,
            "全ノードを読んでいる: {s:?}"
        );
        assert_eq!(s.nodes_read, s.nodes_selected);
        assert!(s.points_scanned < 8000);
    }

    /// 0点のときはエラーで、出力ファイルを作らない。
    #[test]
    fn empty_selection_is_an_error_and_writes_nothing() {
        let dir = tempfile::tempdir().expect("tempdir");
        let source = make_copc(dir.path(), 10, 500);
        let filter = box_filter([5000.0, 5000.0, 5000.0], [5001.0, 5001.0, 5001.0]);
        let output = dir.path().join("out.copc.laz");
        let err = run(&source, filter, &output).expect_err("0点はエラー");
        assert!(matches!(err, ExtractError::EmptySelection));
        assert_eq!(err.to_string(), "選んだ範囲に点がありません");
        assert!(!output.exists());
    }

    /// ノードには交わるが、点は1つも条件に入らない場合も0点エラー(ノードの絞り込みは粗いので)。
    #[test]
    fn empty_selection_inside_a_node_is_also_an_error() {
        let dir = tempfile::tempdir().expect("tempdir");
        let source = make_copc(dir.path(), 10, 500);
        // 格子点(整数座標)の間に入る小さな箱。
        let filter = box_filter([1000.2, 2000.2, 30.2], [1000.4, 2000.4, 30.4]);
        let output = dir.path().join("out.copc.laz");
        let err = run(&source, filter, &output).expect_err("0点はエラー");
        assert!(matches!(err, ExtractError::EmptySelection));
    }

    /// 抱える量の上限: 読む側が同時に持つ点は、最大のノード1つ分を超えない。
    /// 8000点・1ノード最大500点(→ノードは複数)の元から、全点を選んでも
    /// 同時に抱えた点数は1ノードの点数(≒500)以下で、総点数(8000)には近づかない。
    #[test]
    fn buffer_is_bounded_by_largest_node() {
        let dir = tempfile::tempdir().expect("tempdir");
        let source = make_copc(dir.path(), 20, 500);
        let filter = box_filter([0.0, 0.0, 0.0], [10_000.0, 10_000.0, 10_000.0]);
        let output = dir.path().join("out.copc.laz");
        let summary = run(&source, filter, &output).expect("extract");
        assert_eq!(summary.point_count, 8000);

        let reader = CopcReader::from_path(&source).expect("open source");
        let largest_node = reader
            .file()
            .hierarchy_entries()
            .filter(|e| e.has_point_data())
            .map(|e| e.point_count)
            .max()
            .expect("nodes") as usize;
        let s = summary.stats;
        assert!(s.nodes_read > 8, "ノードが十分に分かれている: {s:?}");
        assert_eq!(s.max_buffered_points, largest_node);
        assert!(s.max_buffered_points <= 500, "{s:?}");
        assert!(s.max_buffered_points * 10 < 8000);
    }

    /// 進捗: ノードごとに呼ばれ、最後は読む予定の点数に届く。
    #[test]
    fn reports_progress_per_node() {
        let dir = tempfile::tempdir().expect("tempdir");
        let source = make_copc(dir.path(), 10, 200);
        let filter = box_filter([0.0, 0.0, 0.0], [10_000.0, 10_000.0, 10_000.0]);
        let output = dir.path().join("out.copc.laz");
        let spill = tempfile::tempdir().expect("spill");
        let calls = Arc::new(Mutex::new(Vec::<ReadProgress>::new()));
        let calls_in = Arc::clone(&calls);
        let mut timings = ConversionStageTimings::default();
        extract_path_and_timings(
            &source,
            filter,
            &output,
            spill.path(),
            &CopcWriterParams::new(200),
            &NeverCancel,
            move |p| calls_in.lock().expect("lock").push(p),
            &mut timings,
        )
        .expect("extract");
        let calls = calls.lock().expect("lock");
        assert!(calls.len() > 1);
        let last = calls.last().expect("last");
        assert_eq!(last.points_read, 1000);
        assert_eq!(last.total_points, 1000);
    }

    /// キャンセルは読んでいる途中でも効く(書き出しの確認を待たない)。
    #[test]
    fn cancel_stops_during_scan() {
        struct CancelNow;
        impl CancelCheck for CancelNow {
            fn check(&self) -> copc_core::Result<()> {
                Err(copc_core::Error::Cancelled)
            }
        }
        let dir = tempfile::tempdir().expect("tempdir");
        let source = make_copc(dir.path(), 10, 200);
        let filter = box_filter([0.0, 0.0, 0.0], [10_000.0, 10_000.0, 10_000.0]);
        let output = dir.path().join("out.copc.laz");
        let spill = tempfile::tempdir().expect("spill");
        let mut timings = ConversionStageTimings::default();
        let err = extract_path_and_timings(
            &source,
            filter,
            &output,
            spill.path(),
            &CopcWriterParams::new(200),
            &CancelNow,
            |_| {},
            &mut timings,
        )
        .expect_err("キャンセル");
        assert!(err.is_cancelled(), "{err}");
        assert!(!output.exists());
    }

    /// COPCでないファイルは、わかる日本語で失敗する。
    #[test]
    fn non_copc_input_fails_with_clear_message() {
        let dir = tempfile::tempdir().expect("tempdir");
        let las_path = dir.path().join("plain.las");
        write_grid_las(&las_path, 3);
        let filter = box_filter([0.0, 0.0, 0.0], [1.0, 1.0, 1.0]);
        let output = dir.path().join("out.copc.laz");
        let err = run(&las_path, filter, &output).expect_err("COPCではない");
        assert!(matches!(err, ExtractError::Open { .. }), "{err}");
    }

    /// 結合(merge.rs)は、COPCを入力にしてもそのまま動き、点数と範囲が合う。
    #[test]
    fn merge_accepts_copc_inputs() {
        let dir = tempfile::tempdir().expect("tempdir");
        let a_dir = dir.path().join("a");
        let b_dir = dir.path().join("b");
        std::fs::create_dir_all(&a_dir).expect("mkdir");
        std::fs::create_dir_all(&b_dir).expect("mkdir");
        let a = make_copc(&a_dir, 6, 100);
        // bは同じ格子をそのまま別ファイルにしたもの(座標は重なるが、点は別々に数える)。
        let b = make_copc(&b_dir, 5, 100);
        let output = dir.path().join("merged.copc.laz");
        let spill = tempfile::tempdir().expect("spill");
        let mut timings = ConversionStageTimings::default();
        let summary = crate::merge::merge_paths_and_timings(
            vec![a, b],
            &output,
            spill.path(),
            &CopcWriterParams::new(100),
            &NeverCancel,
            |_| {},
            &mut timings,
        )
        .expect("COPC同士の結合");
        assert_eq!(summary.declared_points_total, 216 + 125);
        let file = CopcFile::open(&output).expect("open merged");
        assert_eq!(file.info().point_count, 216 + 125);
    }
}
