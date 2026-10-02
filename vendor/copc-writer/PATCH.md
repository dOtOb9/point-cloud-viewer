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
    fn read_at(&self, offset: u64, buf: &mut [u8]) -> Result<()>;
    fn len(&self) -> Result<u64>;
}
```

- `ScratchFs::create_temp` / `create_output` が、今まで`tempfile::Builder`が
  直接呼ばれていた箇所を置き換える
- `ScratchWriter`(`Write + Seek`)が、今までの`NamedTempFile`/`BufWriter<File>`
  を置き換える。書き終えたら`finish_temp`(一時ファイル→読み出し用ハンドルへ)
  か`finish_output`(出力ファイル→最終確定)のどちらかを呼ぶ
- `ScratchReader::read_at`(範囲読み)が、今までの`unsafe { Mmap::map(&file) }`を
  置き換える(spillのランダムアクセス読み出し)。`open_at`が、今までの
  「同じ一時ファイルを`File::open`で開き直して`seek`する」を置き換える
  (LOD索引の読み出し)。**この`read_at`は当初`as_bytes`
  (`Result<Arc<dyn AsRef<[u8]>>>`、ファイル全体をランダムアクセス領域として
  返す)という形だったが、M4-6の実機不具合を受けて範囲読みに変えた
  (下記「M4-6 追記」参照)

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

## M4-6 追記: 実機不具合「数千万点でunreachable」とas_bytesの廃止(2026-10-01〜02、Sonnet)

### 症状(所有者の実機、Chrome、数千万点の入力)

```
変換に失敗しました: unreachable
```

### 原因

`crates/pcv-wasm/src/opfs.rs`の`OpfsTempReader::as_bytes`(当時)は、
一時ファイル(spill。1点あたり50〜60バイト)の中身を`vec![0u8; len]`へ
**丸ごと**読み込んでいた。`ScratchReader::as_bytes`はM4-6aの時点で
「`copc-writer`本体が元々mmapでファイル全体を1つのスライスとして扱う
作りだったので、その形を引き継いだ」API(上記「3つのトレイト」節の
コメント参照)で、ネイティブ実装(`NativeScratchFs`、mmap)はOSがページ
単位で必要な部分だけを載せるため問題にならなかったが、**OPFSには
mmap相当のAPIが無い**ため、OPFS実装はこの「ファイル全体を1つのスライス
として扱う」契約を、丸ごとメモリへ読み込むことでしか満たせなかった。

数千万点の入力ではspillが数GBになり、wasm32-unknown-unknownのアドレス
空間(実務上4GiB未満)を超えて`vec![0u8; len]`の確保が失敗し、
`std::alloc::handle_alloc_error`→`unreachable`でwasmごと即座に停止した
(メモリ確保の失敗はRustのpanic機構を通らないため、`init_panic_hook`が
あってもメッセージが出なかった)。

これはM4-1で退けた「メモリが点数に比例する」問題が、Web版で形を変えて
戻ってきたものである。

### M4-6aの調査が見落としていたこと

M4-6aは「改修前後で出力ファイルがバイト同一である」ことを検証基準にし、
これは満たされていた(アルゴリズム本体は変えていないため)。**しかし
出力の一致は、読み込み中にどれだけのメモリを同時に保持するかについては
何も保証しない。** `as_bytes`というAPI自体が「ファイル全体をメモリ上の
1つのスライスとして返す」契約である以上、ネイティブ(mmap)なら無害でも、
mmap相当の手段を持たない実装(OPFS)に対しては原理的に「全体を読み込む」
以外の実装のしようがなかった。M4-6aのスパイクは`MemoryScratchFs`
(`Vec<u8>`だけの実装。これも全体保持が前提)でしか動作確認しておらず、
OPFS実装はM4-6bで初めて書かれたため、この構造的な問題はM4-6bの時点でも
見過ごされた。**「出力が一致する」ことと「メモリの使い方が妥当である」
ことは別の軸であり、前者だけを確認基準にしたことが、この不具合を
最後まで見つけられなかった理由である。**

### 直したこと

1. **`ScratchReader`から`as_bytes`を廃止し、`read_at(offset, buf)`
   (範囲読み)と`len()`を追加した。** `spill.rs`(`as_bytes`の唯一の
   呼び出し元だった)は、`xyz_at`が24バイト(x/y/z)、`record_into`が
   レコード幅ぶんだけを、その都度`read_at`で読む形に変えた。
   `record_into`用に小さな再利用バッファ(`RefCell<Vec<u8>>`)を1つ
   `SpillReader`に持たせ、呼び出しのたびにアロケートしないようにした。
   `lod.rs`は元々`open_at`(逐次読み出し)しか使っておらず、無変更
2. **ネイティブ実装(`SharedBytesReader`、`NativeScratchFs`/
   `MemoryScratchFs`が共有)は、`read_at`をmmap(またはVec)上の
   スライスを範囲ぶんだけコピーするだけで実装した。** mmapは今までどおり
   OSがページ管理するので、性能特性は変えていない。ネイティブの出力が
   バイト単位で変わらないことは、既存の回帰テスト
   (`crates/pcv-convert/tests/streaming_conversion.rs`の
   `native_output_hash_matches_recorded_value`)で確認した(引き続き成功)
3. **OPFS実装(`crates/pcv-wasm/src/opfs.rs`)は、`read_at`を
   `FileSystemSyncAccessHandle::read`に`at`オプションを渡して必要な範囲
   だけ読む形にした。ファイル全体を一度もメモリに載せない。**
   頻繁な小さい読み(1レコード=数十バイトごとのJS往復)を抑えるため、
   64KiBブロック×最大64個(合計4MiB固定。点数・ファイルサイズによらず
   一定)のLRUブロックキャッシュ(`ReadCache`)を追加した
4. **`init_panic_hook`が変換用のWorkerで呼ばれているかを確認した。**
   `#[wasm_bindgen(start)]`により、`init()`解決時にwasm-bindgenの生成
   コードが既に自動で1回呼んでいた(`src/datasource/copc.worker.ts`の
   `ensureWasmReady`は変換・COPC読込どちらの前にも`init()`を待つため)。
   この自動呼び出しは実装を追う上で見えにくいため、`ensureWasmReady`で
   明示的にもう一度呼ぶようにした(副作用なし)
5. **メモリ確保の失敗を検知する`#[global_allocator]`を追加した**
   (`crates/pcv-wasm/src/alloc_guard.rs`)。`std::alloc::System`を薄く
   ラップし、確保失敗(null)を検知した瞬間に`web_sys::console::error_1`で
   メッセージを出す。メモリ確保の失敗はRustのpanic機構を通らないため、
   `init_panic_hook`だけでは捕まえられない(`#[alloc_error_handler]`は
   nightly限定の不安定機能で使えない)。これにより、同種の不具合が
   将来再発しても「メモリ不足を疑う」ための手がかりがconsoleに残る

### 新規テスト

`vendor/copc-writer/tests/scratch_read_is_bounded.rs`(ネイティブで実行)。
`MemoryScratchFs`/`ScratchReader`を薄くラップし、`read_at`・`open_at`
(`Read::read`)に渡された1回あたりの読み取りバッファの最大サイズを記録する
トラッキング層を用意した。200万点の合成入力を
`write_copc_from_spill_with_fs`で最後まで変換し、記録された最大値が
固定の上限(2MiB)に収まる(= 点数に比例しない)ことを確認する。
`as_bytes`相当の全体読み込みが復活すれば、200万点では数千万バイト規模に
なり、このテストが落ちる。

### 確認したコマンドと結果

```
$ cargo test --manifest-path vendor/copc-writer/Cargo.toml
20 passed; 0 failed(既存19件+新規の scratch_read_is_bounded 1件)

$ cargo test --workspace
native_output_hash_matches_recorded_valueを含め、全テスト成功
(本文書の「改修前後で出力が変わっていないことの確認」節の回帰テスト)

$ cargo test --manifest-path crates/pcv-wasm/Cargo.toml
ユニット15件(新規のReadCache単体テスト3件含む)+統合2件、すべて成功

$ cargo clippy --workspace --all-targets -- -D warnings
警告・エラー無し

$ cargo clippy --manifest-path crates/pcv-wasm/Cargo.toml --all-targets -p pcv-wasm -- -D warnings
pcv-wasm自身は警告0件(wasm32ターゲットでも確認)

$ cargo build --manifest-path crates/pcv-wasm/Cargo.toml --target wasm32-unknown-unknown
成功

$ cargo fmt --all -- --check / cargo fmt --manifest-path vendor/copc-writer/Cargo.toml -- --check /
  cargo fmt --manifest-path crates/pcv-wasm/Cargo.toml -- --check
いずれも差分無し

$ npm run build:wasm / typecheck / lint / test / build
いずれも成功(testは27ファイル231件)
```

### 所有者が確かめる手順

**ブラウザでの確認はできない環境で直したため、以下は所有者に確認して
もらう必要がある。**

1. **数千万点のLAS/LAZをWeb版で変換する**(今回の不具合の再現条件)。
   「変換に失敗しました: unreachable」が出ずに変換が完了することを確認する
2. もし依然として`unreachable`が出る場合は、devtoolsのconsoleに
   「pcv-wasm: メモリの確保に失敗しました。入力が大きすぎて、ブラウザの
   メモリ上限(wasm32は最大4GiB)を超えた可能性があります。」という
   メッセージが出ているか確認する(出ていれば、別の箇所でまだ点数に
   比例する確保が残っている可能性がある。出ていなければ、
   メモリ以外の原因を疑う)
3. 変換が完了したCOPCファイルが、今までどおり正しく表示されることを確認する
   (M4-6b節の「所有者が確かめる手順」と同じ)

## いつ削除するか

`main`に一度取り込んだ後は、Web版の変換経路(`crates/pcv-wasm`)が
`OpfsScratchFs`経由でこの改修に依存する。upstream(`roteiro-gis/copc-rust`)が
同等のScratchFs抽象を取り込んだら、そちらに乗り換えてこの`vendor/`を
削除できる。**上流への提案はしない**(コーディネーター指示)。
