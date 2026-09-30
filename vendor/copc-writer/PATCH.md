# なぜこのクレートが vendor/ にあるのか

これは [`copc-writer` 0.9.0](https://crates.io/crates/copc-writer) の複製に、
**ファイルシステムに触れる箇所をトレイト越しに差し替える改修**を当てたもの。

- 上流: https://github.com/roteiro-gis/copc-rust
- ライセンス: MIT OR Apache-2.0(本プロジェクトと同じ。改変して再配布できる)
- 取り込み元: crates.io の 0.9.0 パッケージそのまま

## 経緯

M4-6a(`TaskSheets/M4-import-and-conversion.md`)で、この改修が

- 改修が `copc-writer` の約500行(純増分556行/変更行数合計1,128行。
  数え方で解釈が分かれる)に収まり
- ネイティブのテストが通り(振る舞いが変わっていないこと。バイト同一性で確認)
- `wasm32-unknown-unknown` でビルドできる(メモリ実装のみ)

ことをスパイクブランチ(`spike/m4-6`)で確かめた。**所有者が2026-09-30に
「実装する」と決定**し、`main` に取り込んだ(M4-6b)。詳細な調査結果・
判断表への当てはめはタスクシートのM4-6a節を参照。

## 何をしたか

`copc-writer`本体は、ファイルシステムに3箇所で直接触れていた。

1. `spill.rs`: 点レコードを吐き出す一時ファイル(`tempfile::NamedTempFile`)。
   読み戻しは`memmap2::Mmap`でファイル全体をマップする
2. `lod.rs`: octree(LOD)構築が使う一時ファイル(root・partition・order索引。
   同じく`tempfile`)。`std::fs::File`で開き直し・`seek`で読む
3. `writer.rs`: 出力ファイル(COPC本体)。一時名(`tempfile::NamedTempFile`)で
   書き、成功時だけ本来の名前へアトミックに`rename`する(`PendingOutput`)

`wasm32-unknown-unknown`には`tempfile`(OS一時ファイル)も`memmap2`
(メモリマップ)も実行時には使えない(コンパイル自体は通る。M4-6aで確認した
`memmap2`の`stub.rs`の話は下記「wasm32でのビルドについて」参照)ため、
このままではブラウザで動かせない(`TaskSheets/ADR-0006-conversion-strategy.md`
の追記参照)。

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

### 3つの実装

- **`NativeScratchFs`**(`native-fs`フィーチャ、既定オン): 今までどおり
  `tempfile::NamedTempFile`+`memmap2::Mmap`。**振る舞いは変えていない**
  (下記「改修前後で出力が変わっていないことの確認」参照)。デスクトップ・
  Androidの変換経路(`crates/pcv-convert`)が使う
- **`MemoryScratchFs`**: OS一時ファイルもmmapも使わない、`Vec<u8>`だけの
  実装。単体テスト・`wasm32-unknown-unknown`向けのビルド可否確認に使う
- **`OpfsScratchFs`**(`crates/pcv-wasm/src/opfs.rs`。このクレートの外、
  M4-6b で追加): Web版がOPFS(`FileSystemSyncAccessHandle`)の上で動かす実装。
  `copc-writer`本体はこの実装を知らない(`&dyn ScratchFs`だけに依存する)

`native-fs`フィーチャを切ると、`tempfile`/`memmap2`への依存自体が外れる
(`Cargo.toml`で`optional = true`)。`NativeScratchFs`自身と、それを内部で
使う公開関数(`write_source`・`write_source_with_cancel`・
`write_streaming_with_cancel`・`convert_las_to_copc_streaming*`)も
`#[cfg(feature = "native-fs")]`で外れる。

**`write_copc_inner`・`write_copc_from_spill`・`build_lod_index`・
`SpillWriter`/`SpillReader`は`&dyn ScratchFs`を受け取る形にしただけで、
どちらのフィーチャでも常にコンパイルされる。** 公開APIの署名
(`write_streaming_with_cancel`等の引数)は変えていない。`pcv-convert`側は
無変更で動く(`cargo test --workspace`で確認済み)。

### M4-6b で追加した公開関数

`write_copc_from_spill_with_fs(fs: &dyn ScratchFs, path: &Path, reader:
SpillReader, params, cancel, metadata: &CopcWriteMetadata) -> Result<()>`。

M4-6aのスパイクは`NativeScratchFs`/`MemoryScratchFs`をクレート内部の
テストから使っただけで、外部の呼び出し側(`pcv-wasm`)へ`&dyn ScratchFs`を
直接渡せる公開の入口が無かった。`write_copc_from_spill`自体は最初から
`&dyn ScratchFs`を受け取る形(M4-6aの改修)だったので、薄い公開ラッパーを
1つ足すだけで済んだ。`native-fs`フィーチャの有無に関わらず常にビルドされる。

Web版(`crates/pcv-wasm`)は、点の読み込みをTypeScript側からバッチ単位で
駆動する設計にしたため(理由は`crates/pcv-wasm/src/convert.rs`のドキュメント
参照。要点: ブラウザのメインスレッド→Workerへのキャンセル通知は
`postMessage`のイベントループ経由でしか届かず、Rustの1回の長い同期呼び出しの
「途中」では受け取れないため、読み込みフェーズをJS側のループから
バッチごとに呼び出し可能にして、バッチの合間にキャンセル要求を反映できる
ようにしている)、`SpillWriter::create`/`push`/`finalize`(すべて元から公開
済み)を直接呼び、最後にこの関数で書き出しを終える。

### あえて単純化した点(元の実装との差)

出力ファイルの書き出し(`writer.rs`)は、元は`PendingOutput`が
`NamedTempFile`を保持しつつ、書き込みには`.reopen()`で別のファイル
ハンドルを使っていた(理由は元のコードには書かれていない)。この改修では
`ScratchWriter`が書き込みと確定(`finish_output`でのrename)を1つの
オブジェクトで担うようにし、別ハンドルへの`reopen`を無くした。
最終的にディスクに残るバイト列は同じ(下記の検証で確認済み)なので、
挙動を変える単純化と判断した。

## 改修前後で出力が変わっていないことの確認(M4-6a)

`crates/pcv-convert/examples/spike_make_las.rs`(M4-6aで使った、200,000点の
合成LASを作る使い捨てヘルパー。**`main`には入れていない**、スパイク限定)で
合成LASを作り、`crates/pcv-convert/examples/convert_streaming.rs`で
(1)この改修を当てる前の`copc-writer`(crates.io版、無改造)、
(2)この改修を当てた`vendor/copc-writer`(`NativeScratchFs`使用)の
両方に通した。結果はタスクシートのM4-6a節に記録した
(出力ファイルのSHA-256ハッシュが一致、hierarchyのノード構成が一致)。

**M4-6bでは、この確認を`crates/pcv-convert`の自動テストとして残した**
(`crates/pcv-convert/tests/streaming_conversion.rs`の
`native_output_hash_matches_recorded_value`)。小さな合成LAS(決定的な
座標・複数ノードに分かれる程度の点数)を変換し、出力バイト列のハッシュを
固定値と比較する回帰テスト。ハッシュが変わったら、`NativeScratchFs`の
挙動が変わった(意図した変更か、退行か)ことを意味する。

## wasm32-unknown-unknownでのビルドについて(M4-6a)

無改造の`copc-writer` 0.9.0も含め、`tempfile`・`memmap2`は
**コンパイル自体は`wasm32-unknown-unknown`で通る**(`memmap2`は
`unix`/`windows`以外で`src/stub.rs`という「全メソッドが
`Err(Unsupported)`を返すダミー実装」に切り替わるため)。「ビルドできるか」は
判定基準として機能しなかった。実質的な価値は、`MemoryScratchFs`が
OS依存のAPIを一切使わない(`Vec<u8>`・`HashMap`・`Mutex`のみ)ため、
実行時にも動く見込みがあるパスを`native-fs`頼みのパスから切り離せたこと
にある。詳細はタスクシートのM4-6a節5節を参照。

## いつ削除するか

`main`に一度取り込んだ後は、Web版の変換経路(`crates/pcv-wasm`)が
`OpfsScratchFs`経由でこの改修に依存する。upstream(`roteiro-gis/copc-rust`)が
同等のScratchFs抽象を取り込んだら、そちらに乗り換えてこの`vendor/`を
削除できる。**上流への提案はしない**(コーディネーター指示)。
