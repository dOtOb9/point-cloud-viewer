//! `pcv_core`の型をJS側に渡すためのserde構造体。
//!
//! フィールド名はわざと`src-tauri`の`open_copc`が返すJSON(serdeのデフォルト
//! snake_case)と揃えてある。こうすると、TypeScript側で`TauriSource`と
//! `WebSource`が同じDTO変換関数(`src/datasource/copc-dto.ts`)を共有でき、
//! 変換ロジックの二重管理を避けられる。

use std::time::Duration;

use copc_writer::PostProcessStageTimings;
use serde::Serialize;

use crate::opfs::{OpfsReadStats, OpfsSeqReadStats};

#[derive(Serialize)]
pub struct CloudInfoDto {
    pub point_count: u64,
    pub min: [f64; 3],
    pub max: [f64; 3],
    pub scale: [f64; 3],
    pub offset: [f64; 3],
    pub has_color: bool,
}

impl From<&pcv_core::CloudInfo> for CloudInfoDto {
    fn from(info: &pcv_core::CloudInfo) -> Self {
        Self {
            point_count: info.point_count,
            min: info.min,
            max: info.max,
            scale: info.scale,
            offset: info.offset,
            has_color: info.has_color,
        }
    }
}

#[derive(Serialize)]
pub struct HierarchyNodeDto {
    pub key: String,
    pub point_count: u32,
    pub bounds_min: [f64; 3],
    pub bounds_max: [f64; 3],
}

impl From<&pcv_core::HierarchyNode> for HierarchyNodeDto {
    fn from(node: &pcv_core::HierarchyNode) -> Self {
        Self {
            key: node.key.to_string(),
            point_count: node.point_count,
            bounds_min: node.bounds_min,
            bounds_max: node.bounds_max,
        }
    }
}

/// M4-14: `inspectLasHeaderSummary`が返す、1ファイルのヘッダーだけの要約。
/// `src/datasource/copc.worker.ts`の`handleConvertMultiStart`が、複数ファイル
/// 選択時の事前確認(point format・CRSの一致、合計点数)に使う
/// (デスクトップ/Android版`pcv_convert::merge::summarize_headers`と同じ目的。
/// ただしWeb版はTypeScript側で比較する。`layout_key`/`crs_label`は
/// `StreamingLayout`/`pcv_core::crs::Crs`の`Debug`表示そのままで、
/// JS側は文字列の`===`比較にしか使わない=中身の構造を解釈しない)。
#[derive(Serialize)]
pub struct HeaderSummaryDto {
    pub declared_points: f64,
    pub layout_key: String,
    pub crs_label: String,
    pub file_size_bytes: f64,
}

/// M4-6b: `WasmConverter::feed`が返す、読み込み段階の進捗。
/// `src/datasource/conversion-dto.ts`の`ConversionProgressDto`(`phase:
/// "reading"`)と対応させる(デスクトップ版・M4-3と同じ見せ方にそろえる)。
#[derive(Serialize)]
pub struct FeedResultDto {
    pub points_read: u64,
    pub total_points: u64,
    /// 読み込みが尽きた(このファイルの点をすべて読み終えた)かどうか。
    /// `true`になったら、呼び出し側は`feed`を呼ぶのをやめ`finish`へ進む。
    pub done: bool,
}

/// M4-6b: `WasmConverter::finish`が返す、変換完了の要約。
/// M4-12(`TaskSheets/M4-import-and-conversion.md`)で`stage_timings`を追加した。
#[derive(Serialize)]
pub struct FinishResultDto {
    pub point_count: u64,
    pub stage_timings: ConversionStageBreakdownDto,
}

/// M4-12: 変換完了後、所有者に「どこで時間を使っているか」をそのまま
/// 報告してもらえるようにするための段階別の内訳。デスクトップ・Android
/// (`src-tauri/src/conversion.rs`の`ConversionStageBreakdownDto`)と同じ
/// 形のJSONを作る(フィールド名を合わせ、`src/datasource/
/// conversion-breakdown.ts`の1つの整形関数をどちらの経路でも使えるようにする)。
///
/// `opfs_io_secs`はWeb版だけが持つOPFSの読み書き時間
/// (`crates/pcv-wasm/src/opfs.rs`の`OpfsIoTimer`)。計測できなかった場合
/// (理論上は無いはずだが、将来`ScratchFs`実装を切り替える可能性に備えて)
/// `None`(JSONでは`null`)を許す。
///
/// `opfs_read_at_calls`以下の4つ(M4-13、`TaskSheets/M4-import-and-conversion.md`)は
/// `opfs.rs`の`OpfsReadStats`(`read_at`の呼び出し回数・ブロックキャッシュの
/// ヒット/ミス・OPFSから実際に読んだバイト数・読み時間)をそのまま運ぶ。
/// `opfs_io_secs`と同じ理由で`Option`(デスクトップは常に`None`)。
///
/// `opfs_seq_read_calls`/`opfs_seq_read_secs`(M4-13追記)は`opfs.rs`の
/// `OpfsSeqReadStats`(`ScratchReader::open_at`が返す無バッファの逐次読み出し
/// [`OpfsSeqReader`]の呼び出し回数・時間)を運ぶ。所有者の実機相当の規模での
/// BEFORE計測で、`read_at`側(`opfs_read_secs`)はほぼ無視できる時間なのに対し、
/// こちらが「ノードの圧縮」のほぼ全てを占めていた(`vendor/copc-writer`の
/// `encode_node_points`がノードのLOD順インデックスをこの経路で1点ずつ無バッファに
/// 読むため)。同じ理由で`Option`。
#[derive(Serialize)]
pub struct ConversionStageBreakdownDto {
    pub source_read_and_decode_secs: f64,
    pub spill_write_secs: f64,
    pub lod_index_build_secs: f64,
    pub node_compression_secs: f64,
    pub header_and_hierarchy_write_secs: f64,
    pub total_secs: f64,
    pub opfs_io_secs: Option<f64>,
    pub opfs_read_at_calls: Option<u64>,
    pub opfs_cache_hits: Option<u64>,
    pub opfs_cache_misses: Option<u64>,
    pub opfs_bytes_read_from_opfs: Option<u64>,
    pub opfs_read_secs: Option<f64>,
    pub opfs_seq_read_calls: Option<u64>,
    pub opfs_seq_read_secs: Option<f64>,
    pub point_count: u64,
    pub file_size_bytes: u64,
    /// M4-14: 入力ファイル数。単一ファイルの変換では常に1。複数ファイルの
    /// マージ変換(`WasmConverter`を複数ファイルで使う経路)では選択した
    /// ファイル数になる(デスクトップ版`src-tauri/src/conversion.rs`の
    /// 同名フィールドと対応)。
    pub input_file_count: u64,
}

impl ConversionStageBreakdownDto {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        source_read_and_decode: Duration,
        spill_write: Duration,
        post: PostProcessStageTimings,
        point_count: u64,
        file_size_bytes: u64,
        opfs_io: Option<Duration>,
        opfs_read_stats: Option<OpfsReadStats>,
        opfs_seq_read_stats: Option<OpfsSeqReadStats>,
        input_file_count: u64,
    ) -> Self {
        let total = source_read_and_decode
            + spill_write
            + post.lod_index_build
            + post.node_compression
            + post.header_and_hierarchy_write;
        Self {
            source_read_and_decode_secs: source_read_and_decode.as_secs_f64(),
            spill_write_secs: spill_write.as_secs_f64(),
            lod_index_build_secs: post.lod_index_build.as_secs_f64(),
            node_compression_secs: post.node_compression.as_secs_f64(),
            header_and_hierarchy_write_secs: post.header_and_hierarchy_write.as_secs_f64(),
            total_secs: total.as_secs_f64(),
            opfs_io_secs: opfs_io.map(|d| d.as_secs_f64()),
            opfs_read_at_calls: opfs_read_stats.map(|s| s.read_at_calls),
            opfs_cache_hits: opfs_read_stats.map(|s| s.cache_hits),
            opfs_cache_misses: opfs_read_stats.map(|s| s.cache_misses),
            opfs_bytes_read_from_opfs: opfs_read_stats.map(|s| s.bytes_read_from_opfs),
            opfs_read_secs: opfs_read_stats.map(|s| s.read_time.as_secs_f64()),
            opfs_seq_read_calls: opfs_seq_read_stats.map(|s| s.seq_read_calls),
            opfs_seq_read_secs: opfs_seq_read_stats.map(|s| s.seq_read_time.as_secs_f64()),
            point_count,
            file_size_bytes,
            input_file_count,
        }
    }
}
