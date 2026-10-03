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

use copc_core::{CancelCheck, LasPointRecord, StreamingLayout};
use copc_writer::{
    write_copc_from_spill_with_fs, CopcWriteMetadata, CopcWriterParams, NativeScratchFs,
    SpillWriter,
};

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

    let mut points_read: u64 = 0;
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
        spill.push(&record).map_err(ImportError::Copc)?;
        points_read += 1;
        if points_read.is_multiple_of(PROGRESS_REPORT_STRIDE) || points_read == total_points {
            on_progress(ReadProgress {
                points_read,
                total_points,
            });
        }
        Ok(())
    })?;
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
    write_copc_from_spill_with_fs(&lod_fs, output, reader, params, cancel, &metadata)
        .map_err(ImportError::Copc)?;

    Ok(ImportSummary {
        point_count: points_read,
        crs_known,
    })
}
