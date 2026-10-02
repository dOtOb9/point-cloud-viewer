//! Pure-Rust COPC writer.
//!
//! M4-6a(`TaskSheets/M4-import-and-conversion.md`)で`scratch`モジュールを
//! 追加した。ファイルシステムに触れる操作(一時ファイルの作成・読み書き・
//! シーク・出力ファイルの確定)を`ScratchFs`/`ScratchWriter`/`ScratchReader`の
//! 3トレイトにまとめ、ネイティブ既定実装(`NativeScratchFs`。`native-fs`
//! フィーチャ、既定オン)とメモリ上の実装(`MemoryScratchFs`)を用意している。
//! 詳細は`src/scratch.rs`と`PATCH.md`を参照。
//!
//! M4-6b(`crates/pcv-wasm`)でOPFS向けの`ScratchFs`実装を追加した。それに
//! あわせて`write_copc_from_spill_with_fs`(`&dyn ScratchFs`を直接渡す入口)を
//! 公開した。

mod hierarchy_pages;
mod las_out;
mod lod;
mod metadata;
mod scratch;
mod source;
mod spill;
mod validate;
mod writer;

pub(crate) const CANCEL_POLL_STRIDE: usize = 4_096;

pub use metadata::CopcWriteMetadata;
#[cfg(feature = "native-fs")]
pub use scratch::NativeScratchFs;
pub use scratch::{MemoryScratchFs, ScratchFs, ScratchReader, ScratchWriter};
pub use source::{ColumnBatchSource, CopcPointFields, CopcPointSource};
pub use spill::{SpillReader, SpillWriter};
// M4-6b: `write_copc_from_spill_with_fs`は`&dyn ScratchFs`を直接渡す入口。
// `native-fs`フィーチャの有無に関わらず常にビルドされる(`writer.rs`のドキュメント参照)。
#[cfg(feature = "native-fs")]
pub use writer::{
    convert_las_to_copc_streaming, convert_las_to_copc_streaming_with_crs_wkt_override,
    write_source, write_source_with_cancel, write_streaming_with_cancel,
};
pub use writer::{write_copc_from_spill_with_fs, CopcWriterParams};
