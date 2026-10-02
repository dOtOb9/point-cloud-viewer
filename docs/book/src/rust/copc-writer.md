# vendor/copc-writer: ScratchFs の改修

[`vendor/copc-writer`](https://github.com/dOtOb9/point-cloud-viewer/tree/main/vendor/copc-writer) は crates.io の `copc-writer` 0.9.0
（`copc-core`/`copc-reader` と同じ `roteiro-gis/copc-rust` の姉妹クレート、MIT OR Apache-2.0）
に、**ファイルシステムに触れる箇所をトレイト越しに差し替える改修**を当てたものです。

経緯の全文は [`vendor/copc-writer/PATCH.md`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/vendor/copc-writer/PATCH.md) にあります。

## 何をしたか

`copc-writer` はファイルシステムに3箇所で直接触れていました。

1. 点レコードを吐き出す一時ファイル（`tempfile`、読み戻しは `memmap2` でファイル
   全体をマップ）
2. octree（LOD）構築が使う一時ファイル（root・partition・order の索引）
3. 出力ファイル（COPC 本体。一時名で書き、成功時だけアトミックに `rename`）

`tempfile`（OS 一時ファイル）も `memmap2`（メモリマップ）も `wasm32-unknown-unknown`
では実行時に使えないため、このままでは Web 版の変換が成立しません
（[ADR-0006 の追記](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0006-conversion-strategy.md#追記-androidとwebでも変換する2026-09-24)）。

この3箇所を、新設した3つのトレイトにまとめました。

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

実装は3つあります。

| 実装 | 用途 |
|---|---|
| `NativeScratchFs`（`native-fs` フィーチャ、既定オン） | `tempfile` + `memmap2`。**振る舞いは変えていない**（下記参照）。デスクトップ・Android の変換経路が使う |
| `MemoryScratchFs` | `Vec<u8>` だけの実装。単体テストと wasm32 ビルド可否の確認に使う |
| `OpfsScratchFs`（[`crates/pcv-wasm/src/opfs.rs`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/crates/pcv-wasm/src/opfs.rs)） | OPFS（Origin Private File System）上の実装。Web 版が使う |

ネイティブの出力がバイト単位で変わっていないことは、既存の回帰テスト
（`native_output_hash_matches_recorded_value`）で確認されています。
アルゴリズム本体（octree の分割・間引き・書き出しの順序）は変更していません。

## `read_at` に変えた理由（実機不具合からの学び）

当初、`ScratchReader` は `as_bytes()`（`Result<Arc<dyn AsRef<[u8]>>>`、ファイル
全体をスライスとして返す）という API でした。ネイティブでは `mmap` なので
OS が必要な部分だけをページインしますが、**OPFS にはメモリマップ相当の API が
無い**ため、Web 版はこれを `Vec<u8>` へ丸ごと読み込む実装にせざるを得ませんでした。

数千万点規模の入力を Web 版で変換すると、一時ファイルが数 GB になり、
wasm32 のメモリ上限（実務上 4GiB 未満）を超えてメモリ確保が失敗し、
`unreachable` で変換全体が止まる不具合が実機で見つかりました。
これは [ADR-0006](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0006-conversion-strategy.md) が M4-1 で退けたはずの「メモリが点数に比例する」問題が、
Web 版という別の形で戻ってきたものです。**出力ファイルのバイト同一性だけを
確認基準にしていたため、読み込み中のメモリの使い方という別の軸の問題が
M4-6a/M4-6b の検証ではすり抜けていました。**

対処として `as_bytes` を廃止し、`read_at(offset, buf)`（範囲読み）と `len()` に
変更しました。`NativeScratchFs` は mmap 上のスライスを範囲ぶんだけコピーする形に、
`OpfsScratchFs` は `FileSystemSyncAccessHandle::read`（`at` 指定）で範囲だけを
読む形に直し、小さい読み出しが頻発する性能面の懸念には 64KiB ブロック×最大64個
（固定4MiB）の LRU ブロックキャッシュで対処しています。詳細は
[`vendor/copc-writer/PATCH.md`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/vendor/copc-writer/PATCH.md) の「M4-6 追記」節を参照してください。

## いつ削除するか

`PATCH.md` の「いつ削除するか」節を参照してください。この改修は上流に
取り込まれる見込みのある一般的な抽象化ではなく、本プロジェクト固有の
事情（Web 版での利用）によるものなので、当面維持する前提です。

## まず読むファイル

- [`vendor/copc-writer/PATCH.md`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/vendor/copc-writer/PATCH.md) — 改修の全文と実機不具合の調査記録
- [`crates/pcv-wasm/src/opfs.rs`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/crates/pcv-wasm/src/opfs.rs) — `OpfsScratchFs` の実装
