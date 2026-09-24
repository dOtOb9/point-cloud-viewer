//! M4-1のスパイク実装(素朴な全点メモリ実装)と、M4-3の本番変換経路の両方を
//! 持つ。`src/main.rs`(CLI)と`tests/`・`examples/`から使えるよう、
//! ライブラリとしても公開する。
//!
//! モジュール構成(各ファイルの冒頭コメントに詳細):
//!
//! ## M4-1(スパイク。本番経路には使わない。ADR-0006「素朴な実装の扱い」参照)
//! - [`point`][]: 入力LAS/LAZの読み込みと、メモリ上で持つ点の表現
//! - [`octree`][]: 素朴なoctree分割
//! - [`writer`][]: COPCファイルの組み立て
//! - [`import`][]: M4-4。E57/PLY/PCD → LAS のインポータ(上記3つとは独立した経路)
//!
//! ## M4-3(本番の変換経路。ADR-0006で採用した`copc-writer`を使う)
//! - [`streaming`][]: `copc-writer`を呼ぶ本体。キャンセル対応(`AtomicCancel`)・
//!   読み込み段階の進捗(`ReadProgress`)を含む
//! - [`write_metadata`][]: 元のLASヘッダーから`copc_writer::CopcWriteMetadata`を組み立てる
//! - [`crs_override`][]: 元ヘッダーのCRS(WKTまたはGeoTIFF)からWKT文字列を解決する
//! - [`copc_detect`][]: 拡張子ではなくヘッダーでCOPCかどうかを判定する
//! - [`cache`][]: 「同じファイルを二度変換しない」の判定(指紋・サイドカー)
//! - [`output_path`][]: 変換結果(`<元ファイル名>.copc.laz`)の置き場所を決める
//! - [`disk_space`][]: 変換前の空き容量チェック(現時点ではWindowsのみ実装)

pub mod import;
pub mod octree;
pub mod point;
pub mod writer;

pub mod cache;
pub mod copc_detect;
pub mod crs_override;
pub mod disk_space;
pub mod output_path;
pub mod streaming;
pub mod write_metadata;
