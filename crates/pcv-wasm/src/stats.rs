//! 「ファイル全体を読んでいないこと」を確かめるための、読み取りバイト数の集計。
//!
//! `FileRangeReader`/`HttpRangeReader`はどちらもこの`Stats`を共有して、実際に
//! JSへ渡した(=ネットワーク越しか`FileReaderSync`経由で取得した)バイト数だけを
//! 積算する。ファイルサイズと突き合わせれば「合計が全体よりずっと小さい」ことを
//! 確認できる(受け入れ条件)。`WasmCopcFile::bytes_read()`で読み出せる。

use std::cell::Cell;
use std::rc::Rc;

/// wasm32-unknown-unknown はスレッドを使わない前提なので`Rc<Cell<_>>`で足りる
/// (`Arc<Mutex<_>>`にする理由がない。ADR-0012「シングルスレッド前提」参照)。
#[derive(Clone, Default)]
pub struct Stats(Rc<Cell<u64>>);

impl Stats {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn add(&self, bytes: u64) {
        self.0.set(self.0.get() + bytes);
    }

    pub fn total(&self) -> u64 {
        self.0.get()
    }
}
