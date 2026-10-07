//! M4-9: `PointSource`からCOPCへ、中間LASを経ずに直接書き出す。
//!
//! # なぜ「2パス」ではなく「1パス」で書けるのか
//!
//! タスクシートの当初の設計は「1回目で点数と範囲(bounds)だけを数え、2回目で
//! 点を流す」という2パス方式だった。`copc_core::StreamingLayout`が点を渡す前に
//! bounds・スケール・オフセットを要求する、という前提に基づいていたが、
//! `vendor/copc-writer/src/writer.rs`・`spill.rs`を読むと、この前提は誤りだった:
//!
//! - `StreamingLayout`はGPS時刻・色・NIR・波形・extra bytesの有無(本モジュールでは
//!   色の有無だけが変わりうる)しか持たない。boundsもスケール・オフセットも
//!   含まない
//! - `SpillWriter::push`は`LasPointRecord`の生のf64座標をそのまま一時ファイルへ
//!   書きつつ、**bounds(min/max)を副作用として自動的に積算する**
//!   (`spill.rs`の`push`実装参照)。スケール・オフセットはこの時点では一切
//!   関係しない(量子化は後段の`write_copc_inner`まで行われない)
//! - 公開関数`write_copc_from_spill_with_fs`は「スパイル済みの`SpillReader`
//!   (=bounds確定済み)」と「`CopcWriteMetadata`(スケール・オフセットを含む)」を
//!   **別々の引数**として受け取る。つまり「スパイルを終えてboundsを得てから、
//!   それを使ってスケール・オフセットを選び、そのあとで初めてmetadataを
//!   組み立てて書き出しを呼ぶ」という順序がAPI上そのまま可能
//!
//! したがって本モジュールは、`SpillWriter::create`→`push`を1回のループで
//! 回し(これが入力を読む唯一のパス)、`finalize()`で得たboundsから
//! `super::scale::choose_scale_offset`(M4-4から流用、mm以下の精度)でスケール・
//! オフセットを選び、`write_copc_from_spill_with_fs`を呼ぶ。入力を2回読まない
//! ぶん、当初案より速く、コードも1本の流れで追いやすい。
//!
//! この設計は目新しいものではなく、Web版(`crates/pcv-wasm/src/convert.rs`の
//! `WasmConverter`)が**既に同じ部品(`SpillWriter`→`finalize`→
//! `write_copc_from_spill_with_fs`)を使って**LAS/LAZ→COPCを行っている
//! (Web版はヘッダーから読んだスケール・オフセットを最初から知っているので
//! finalizeを待たずにmetadataを組み立てている、という違いだけ)。本モジュールは
//! 「入力にスケール・オフセットの手がかりが無い形式」向けに、同じ部品を
//! 「finalizeしてから選ぶ」順序で組み合わせ直しただけである。
//!
//! # 進捗・キャンセル
//!
//! `write_streaming_with_cancel`(LAS/LAZ経路、`crate::streaming`)は
//! `copc-writer`内部で4096点ごとに`cancel.check()`する。ここでは
//! `SpillWriter::push`を自分のループで呼んでいるので、同じ間隔
//! (`PROGRESS_REPORT_STRIDE`)で自前チェックする。進捗も同じ間隔で
//! `on_progress`に報告する(`crate::streaming::ReadProgress`をそのまま使い、
//! 呼び出し側`src-tauri`がLAS/LAZ経路と同じイベント型で扱えるようにする)。

use std::path::Path;
use std::time::{Duration, Instant};

use copc_core::{CancelCheck, LasPointRecord, StreamingLayout};
use copc_writer::{
    write_copc_from_spill_with_fs_and_timings, CopcWriteMetadata, CopcWriterParams,
    NativeScratchFs, SpillWriter,
};

use crate::stage_timings::ConversionStageTimings;
use crate::streaming::ReadProgress;

use super::point::{PointSource, RawPoint};
use super::{ImportError, ImportSummary};

/// `crate::streaming::PROGRESS_REPORT_STRIDE`(非公開)と同じ値・同じ理由
/// (`copc-writer`内部のキャンセル確認間隔`CANCEL_POLL_STRIDE`=4096と同じ桁)。
const PROGRESS_REPORT_STRIDE: u64 = 4096;

/// `source`を1点ずつ読み、`output`へCOPCとして直接書き出す(中間LASを作らない)。
///
/// - `spill_dir`: 点レコードの一時ファイルの置き場所(呼び出し側が選ぶ。
///   LAS/LAZ経路の`crate::streaming::convert`と同じ扱い)
/// - LOD索引の一時ファイルは`crate::streaming`と同じく常にOS既定の一時
///   ディレクトリに作る(`copc-writer`の既知の仕様。`crate::streaming`の
///   モジュールドキュメント参照)
/// - `crs_wkt`: 呼び出し側が分かっているCRSのWKT文字列を渡す口。`None`なら
///   「不明」のままにする(推測で補わない。`super::mod`のドキュメント参照)
#[allow(clippy::too_many_arguments)]
pub(crate) fn run_import<S: PointSource>(
    source: S,
    output: &Path,
    spill_dir: &Path,
    params: &CopcWriterParams,
    cancel: &(dyn CancelCheck + Sync),
    crs_wkt: Option<String>,
    mut on_progress: impl FnMut(ReadProgress),
    timings: &mut ConversionStageTimings,
) -> Result<ImportSummary, ImportError> {
    let has_color = source.has_color();
    let total_points = source.declared_point_count();

    let layout = StreamingLayout {
        // E57/PLY/PCDはGPS時刻・NIR・波形・extra bytesを運ばない
        // (`crate::point`のM4-1と同じ方針。モジュール冒頭コメント参照)。
        // `point_format`の値自体は`copc-writer`の検証・書き出しでは使われない
        // (`vendor/copc-writer/src/validate.rs`の`validate_streaming_layout_supported`、
        // `writer.rs`の`write_copc_inner`で確認済み。色の有無から出力フォーマット
        // 6/7を直接決めるため)ので、未使用であることが分かる値(0)を置く。
        point_format: 0,
        has_gps: false,
        has_color,
        has_nir: false,
        has_waveform: false,
        extra_bytes: 0,
        extra_bytes_descriptors: Vec::new(),
    };

    let spill_fs = NativeScratchFs::new(spill_dir);
    let mut spill = SpillWriter::create(&spill_fs, layout).map_err(ImportError::Copc)?;

    // M4-12(`TaskSheets/M4-import-and-conversion.md`):
    // `source.for_each_point`はE57/PLY/PCDの読み込み(パース)と、このクレートの
    // コールバック呼び出しを1点ずつ交互に行う。コールバックの外側
    // (呼び出しの合間)で読み込みが行われるため、「読み込み」区間を直接
    // 計測するフックが無い。代わりに、コールバック内の`spill.push`だけを
    // 直接計測し(`spill_write_total`)、`for_each_point`呼び出し全体の
    // 壁時計時間から差し引くことで「読み込み+パース」の時間を求める
    // (`vendor/copc-writer`の`write_streaming_with_cancel_and_timings`と
    // 同じ考え方。キャンセル確認・進捗報告のごく軽い処理もこの差分に残るが、
    // 無視できる大きさ)。
    let mut points_read: u64 = 0;
    let mut spill_write_total = Duration::ZERO;
    let for_each_point_start = Instant::now();
    source.for_each_point(&mut |point: RawPoint| -> Result<(), ImportError> {
        if points_read.is_multiple_of(PROGRESS_REPORT_STRIDE) {
            cancel.check().map_err(ImportError::Copc)?;
        }
        let record = LasPointRecord {
            x: point.x,
            y: point.y,
            z: point.z,
            intensity: point.intensity,
            red: point.color[0],
            green: point.color[1],
            blue: point.color[2],
            ..LasPointRecord::default()
        };
        let push_start = Instant::now();
        spill.push(&record).map_err(ImportError::Copc)?;
        spill_write_total += push_start.elapsed();
        points_read += 1;
        if points_read.is_multiple_of(PROGRESS_REPORT_STRIDE) || points_read == total_points {
            on_progress(ReadProgress {
                points_read,
                total_points,
            });
        }
        Ok(())
    })?;
    let for_each_point_elapsed = for_each_point_start.elapsed();
    timings.spill_write = spill_write_total;
    // 差分が理論上マイナスにならない保証は無い(`Instant`の精度・OSスケジューラの
    // 揺れ)ため、`saturating_sub`で0未満にならないようにする。
    timings.source_read_and_decode = for_each_point_elapsed.saturating_sub(spill_write_total);
    cancel.check().map_err(ImportError::Copc)?;

    let reader = spill.finalize().map_err(ImportError::Copc)?;
    let bounds = reader.bounds();
    let (scale, offset) = super::scale::choose_scale_offset(bounds.min, bounds.max);

    let crs_known = crs_wkt.is_some();
    // `CopcWriteMetadata`は`#[non_exhaustive]`なのでリテラルを書けない
    // (`crate::write_metadata`と同じ事情)。
    let mut metadata = CopcWriteMetadata::default();
    metadata.wkt_crs = crs_wkt;
    metadata.scale = Some(scale);
    metadata.offset = Some(offset);

    let lod_fs = NativeScratchFs::new(std::env::temp_dir());
    let post = write_copc_from_spill_with_fs_and_timings(
        &lod_fs, output, reader, params, cancel, &metadata,
    )
    .map_err(ImportError::Copc)?;
    timings.lod_index_build = post.lod_index_build;
    timings.node_compression = post.node_compression;
    timings.header_and_hierarchy_write = post.header_and_hierarchy_write;

    Ok(ImportSummary {
        point_count: points_read,
        crs_known,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::import::point::RawPoint;

    /// 形式に依存しない、テスト専用の合成`PointSource`。
    struct SyntheticSource {
        count: u32,
    }

    impl PointSource for SyntheticSource {
        fn has_color(&self) -> bool {
            false
        }

        fn declared_point_count(&self) -> u64 {
            u64::from(self.count)
        }

        fn for_each_point(
            self,
            visit: &mut dyn FnMut(RawPoint) -> Result<(), ImportError>,
        ) -> Result<(), ImportError> {
            for i in 0..self.count {
                let f = f64::from(i);
                visit(RawPoint {
                    x: f,
                    y: f * 2.0,
                    z: f * 3.0,
                    color: [0, 0, 0],
                    intensity: 0,
                })?;
            }
            Ok(())
        }
    }

    /// M4-12(`TaskSheets/M4-import-and-conversion.md`): `run_import`が
    /// `timings`の5フィールドすべてを埋めること(0のまま=計測が素通りして
    /// いないこと)を確認する。値そのものの大小は環境依存なので検証しない。
    #[test]
    fn run_import_fills_all_five_stage_timings() {
        let dir = tempfile::tempdir().expect("tempdir");
        let output = dir.path().join("out.copc.laz");
        let spill_dir = dir.path().join("spill");
        std::fs::create_dir_all(&spill_dir).expect("create spill dir");

        let mut timings = ConversionStageTimings::default();
        run_import(
            SyntheticSource { count: 5_000 },
            &output,
            &spill_dir,
            &CopcWriterParams::new(500),
            &copc_core::NeverCancel,
            None,
            |_progress| {},
            &mut timings,
        )
        .expect("run_import");

        assert!(
            timings.source_read_and_decode > Duration::ZERO,
            "読み込み時間が0のまま: {timings:?}"
        );
        assert!(
            timings.spill_write > Duration::ZERO,
            "spill書き込み時間が0のまま: {timings:?}"
        );
        assert!(
            timings.lod_index_build > Duration::ZERO,
            "octree分割時間が0のまま: {timings:?}"
        );
        assert!(
            timings.node_compression > Duration::ZERO,
            "ノード圧縮時間が0のまま: {timings:?}"
        );
    }
}
