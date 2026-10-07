//! M4-12(`TaskSheets/M4-import-and-conversion.md`): 変換全体の段階ごとの
//! 所要時間。所有者が「Web版の変換はどこで時間を使っているか」をそのまま
//! 報告できるようにする、画面表示用の内訳(`src-tauri/src/conversion.rs`の
//! `ConversionDoneEvent`、`crates/pcv-wasm/src/dto.rs`の`FinishResultDto`が
//! これと同じ形をJSONへ運ぶ)。
//!
//! `copc_writer::IngestStageTimings`(入力の読み込み+spill書き込み)と
//! `copc_writer::PostProcessStageTimings`(octree分割・ノード圧縮・書き出し)は
//! どちらも`vendor/copc-writer`が計測する(LAS/LAZ経路、`streaming.rs`参照)。
//! E57/PLY/PCD経路(`import::convert`)は読み込みループ自体がこのクレート側
//! (`vendor/copc-writer`の外)にあるため、同じ2フィールドをこのクレートが
//! 直接測って埋める(`import/convert.rs`参照)。どちらの経路でも最終的に
//! この1つの構造体に集約することで、呼び出し側(`src-tauri`)は経路を
//! 意識せず同じ形で画面に出せる。
//!
//! すべて`std::time::Duration`で持つ(`web_time::Duration`は`std::time::Duration`
//! の再エクスポートで同じ型。`pcv-convert`・`src-tauri`はネイティブ専用の
//! クレートなので、計測自体は`std::time::Instant`で行ってよい
//! (`crates/pcv-convert/clippy.toml`に`disallowed-methods`の制約が無いことの
//! とおり。`CLAUDE.md`の「wasmで使われるクレートでは…」はこのクレートには
//! 適用されない)。

use std::time::Duration;

use copc_writer::{IngestStageTimings, PostProcessStageTimings};

/// 変換1回ぶんの、段階ごとの所要時間。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ConversionStageTimings {
    /// 入力の読み込み+展開(ディスクI/O・LAZ展開・パース)。
    pub source_read_and_decode: Duration,
    /// 一時ファイル(spill)への書き込み。
    pub spill_write: Duration,
    /// octreeの分割(LODの索引作り、点のノードへの振り分け)。
    pub lod_index_build: Duration,
    /// ノードごとのLAZ圧縮(出力ストリームへの書き込みを含む)。
    pub node_compression: Duration,
    /// 書き出し(ヘッダー・VLR・hierarchy。圧縮以外)。
    pub header_and_hierarchy_write: Duration,
}

impl ConversionStageTimings {
    /// `copc_writer`が返す2つの内訳を1つにまとめる。
    pub fn from_parts(ingest: IngestStageTimings, post: PostProcessStageTimings) -> Self {
        Self {
            source_read_and_decode: ingest.source_read_and_decode,
            spill_write: ingest.spill_write,
            lod_index_build: post.lod_index_build,
            node_compression: post.node_compression,
            header_and_hierarchy_write: post.header_and_hierarchy_write,
        }
    }

    /// 5段階の合計。画面側の「合計」表示・内訳との食い違いの目安に使う
    /// (呼び出し全体の壁時計時間とは、計測区間の前後に残るごく軽い処理の分だけ
    /// わずかにずれうる。`post_process_stage_bench.rs`と同じ注意)。
    pub fn total(&self) -> Duration {
        self.source_read_and_decode
            + self.spill_write
            + self.lod_index_build
            + self.node_compression
            + self.header_and_hierarchy_write
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn from_parts_copies_each_field_independently() {
        let ingest = IngestStageTimings {
            source_read_and_decode: Duration::from_millis(10),
            spill_write: Duration::from_millis(20),
        };
        let post = PostProcessStageTimings {
            lod_index_build: Duration::from_millis(30),
            node_compression: Duration::from_millis(40),
            header_and_hierarchy_write: Duration::from_millis(5),
        };
        let combined = ConversionStageTimings::from_parts(ingest, post);
        assert_eq!(combined.source_read_and_decode, Duration::from_millis(10));
        assert_eq!(combined.spill_write, Duration::from_millis(20));
        assert_eq!(combined.lod_index_build, Duration::from_millis(30));
        assert_eq!(combined.node_compression, Duration::from_millis(40));
        assert_eq!(
            combined.header_and_hierarchy_write,
            Duration::from_millis(5)
        );
        assert_eq!(combined.total(), Duration::from_millis(105));
    }

    #[test]
    fn default_is_all_zero() {
        assert_eq!(ConversionStageTimings::default().total(), Duration::ZERO);
    }
}
