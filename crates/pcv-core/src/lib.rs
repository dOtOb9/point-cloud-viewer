//! pcv-core: COPC読込・octree走査・解析アルゴリズムを担う crate。
//!
//! この crate は tauri に依存しない。ネイティブ (x86_64-pc-windows-msvc など) と
//! wasm32-unknown-unknown の両方でビルドできることが Web 版バックエンドを成立させる条件
//! (ADR-0001 参照)。
//!
//! M1-1でCOPCリーダーを実装した。採用クレートの選定理由は
//! `TaskSheets/ADR-0003-copc-crate.md` を参照。

mod copc;
pub mod crs;
mod node_format;

pub use copc::{CloudInfo, CopcError, CopcFile, Hierarchy, HierarchyNode, NodeKey, Result};
pub use node_format::{
    encode_node, NodeBuffer, NodePoint, FLAG_CLASSIFICATION, FLAG_COLOR, FLAG_INTENSITY,
    HEADER_BYTES, MAGIC, POINT_STRIDE, VERSION,
};
