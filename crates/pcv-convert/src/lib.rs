//! M4-1のスパイク実装の中身。`src/main.rs`(CLI)と`tests/`・`examples/`の
//! 両方から使えるよう、ライブラリとしても公開する。
//!
//! モジュール構成(各ファイルの冒頭コメントに詳細):
//! - [`point`][]: 入力LAS/LAZの読み込みと、メモリ上で持つ点の表現
//! - [`octree`][]: 素朴なoctree分割
//! - [`writer`][]: COPCファイルの組み立て
//! - [`import`][]: M4-4。E57/PLY/PCD → LAS のインポータ(上記3つとは独立した経路)

pub mod import;
pub mod octree;
pub mod point;
pub mod writer;
