# なぜこのクレートが vendor/ にあるのか(M4-6a調査、spike/m4-6ブランチ限定)

これは [`copc-writer` 0.9.0](https://crates.io/crates/copc-writer) の複製に、
**ファイルシステムに触れる箇所をトレイト越しに差し替える改修**を試したもの。

- 上流: https://github.com/roteiro-gis/copc-rust
- ライセンス: MIT OR Apache-2.0(本プロジェクトと同じ。改変して再配布できる)
- 取り込み元: crates.io の 0.9.0 パッケージそのまま

**このディレクトリは`spike/m4-6`ブランチだけに存在する調査用の改修であり、
`main`には入れない**(`TaskSheets/M4-import-and-conversion.md`のM4-6a参照)。

## 何をしたか

`copc-writer`本体は、ファイルシステムに3箇所で直接触れていた。

1. `spill.rs`: 点レコードを吐き出す一時ファイル(`tempfile::NamedTempFile`)。
   読み戻しは`memmap2::Mmap`でファイル全体をマップする
2. `lod.rs`: octree(LOD)構築が使う一時ファイル(root・partition・order索引。
   同じく`tempfile`)。`std::fs::File`で開き直し・`seek`で読む
3. `writer.rs`: 出力ファイル(COPC本体)。一時名(`tempfile::NamedTempFile`)で
   書き、成功時だけ本来の名前へアトミックに`rename`する(`PendingOutput`)

`wasm32-unknown-unknown`には`tempfile`(OS一時ファイル)も`memmap2`
(メモリマップ)も無いため、このままではブラウザで動かせない
(`TaskSheets/ADR-0006-conversion-strategy.md`の追記参照)。

この3箇所を、`src/scratch.rs`に新設した3つのトレイトにまとめた。

```rust
pub trait ScratchFs: Send + Sync {
    fn create_temp(&self, label: &str) -> Result<Box<dyn ScratchWriter>>;
    fn create_output(&self, final_path: &Path) -> Result<Box<dyn ScratchWriter>>;
}

pub trait ScratchWriter: Write + Seek + Send + Sync {
    fn finish_temp(self: Box<Self>) -> Result<Box<dyn ScratchReader>>;
    fn finish_output(self: Box<Self>) -> Result<()>;
}

pub trait ScratchReader: Send + Sync {
    fn open_at(&self, offset: u64) -> Result<Box<dyn Read + Send>>;
    fn as_bytes(&self) -> Result<Arc<dyn AsRef<[u8]> + Send + Sync>>;
}
```

- `ScratchFs::create_temp` / `create_output` が、今まで`tempfile::Builder`が
  直接呼ばれていた箇所を置き換える
- `ScratchWriter`(`Write + Seek`)が、今までの`NamedTempFile`/`BufWriter<File>`
  を置き換える。書き終えたら`finish_temp`(一時ファイル→読み出し用ハンドルへ)
  か`finish_output`(出力ファイル→最終確定)のどちらかを呼ぶ
- `ScratchReader::as_bytes`が、今までの`unsafe { Mmap::map(&file) }`を
  置き換える(spillのランダムアクセス読み出し)。`open_at`が、今までの
  「同じ一時ファイルを`File::open`で開き直して`seek`する」を置き換える
  (LOD索引の読み出し)

### 2つの実装

- `NativeScratchFs`(`native-fs`フィーチャ、既定オン): 今までどおり
  `tempfile::NamedTempFile`+`memmap2::Mmap`。**振る舞いは変えていない**
  (下記「改修前後で出力が変わっていないことの確認」参照)
- `MemoryScratchFs`: OS一時ファイルもmmapも使わない、`Vec<u8>`だけの実装。
  `wasm32-unknown-unknown`向けのビルド可否を確かめるために用意した

`native-fs`フィーチャを切ると、`tempfile`/`memmap2`への依存自体が外れる
(`Cargo.toml`で`optional = true`)。`NativeScratchFs`自身と、それを内部で
使う公開関数(`write_source`・`write_source_with_cancel`・
`write_streaming_with_cancel`・`convert_las_to_copc_streaming*`)も
`#[cfg(feature = "native-fs")]`で外れる。

**`write_copc_inner`・`write_copc_from_spill`・`build_lod_index`・
`SpillWriter`/`SpillReader`は`&dyn ScratchFs`を受け取る形にしただけで、
どちらのフィーチャでも常にコンパイルされる。** 公開APIの署名
(`write_streaming_with_cancel`等の引数)は変えていない。`pcv-convert`側は
無変更で動く(実際に`cargo test --workspace`で確認済み)。

### あえて単純化した点(元の実装との差)

出力ファイルの書き出し(`writer.rs`)は、元は`PendingOutput`が
`NamedTempFile`を保持しつつ、書き込みには`.reopen()`で別のファイル
ハンドルを使っていた(理由は元のコードには書かれていない)。この改修では
`ScratchWriter`が書き込みと確定(`finish_output`でのrename)を1つの
オブジェクトで担うようにし、別ハンドルへの`reopen`を無くした。
最終的にディスクに残るバイト列は同じ(下記の検証で確認済み)なので、
挙動を変える単純化と判断した。

## 改修の規模

`git diff --stat`(`spike/m4-6`と`main`の分岐点との比較。詳細は
`TaskSheets/M4-import-and-conversion.md`のM4-6a本文を参照)。

## 改修前後で出力が変わっていないことの確認

`crates/pcv-convert/examples/spike_make_las.rs`(このスパイクのための
使い捨てヘルパー)で200,000点の合成LASを作り、
`crates/pcv-convert/examples/convert_streaming.rs`で
(1)この改修を当てる前の`copc-writer`(crates.io版、無改造)、
(2)この改修を当てた`vendor/copc-writer`(`NativeScratchFs`使用)の
両方に通した。結果はタスクシートのM4-6aに記録した
(出力ファイルのSHA-256ハッシュが一致、hierarchyのノード構成
(`crates/pcv-convert/examples/spike_dump_hierarchy.rs`でダンプ)が一致)。

## wasm32-unknown-unknownでのビルド確認

```bash
cargo build --manifest-path vendor/copc-writer/Cargo.toml \
  --no-default-features --target wasm32-unknown-unknown
```

結果はタスクシートのM4-6aに記録した。

## いつ削除するか

このディレクトリは調査用であり、`main`にマージしない
(`TaskSheets/M4-import-and-conversion.md`のM4-6a「約束」参照)。
M4-6bで実装に進む場合は、この改修を土台に育てるか、書き直すかを
コーディネーターが判断する。見送る場合はこのディレクトリごと削除してよい。
