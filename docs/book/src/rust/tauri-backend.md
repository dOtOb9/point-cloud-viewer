# src-tauri: デスクトップ・Android の裏側

`src-tauri` はデスクトップ・Android 版の Rust 側です。[規約4](../conventions.md) により
薄く保たれており、重い処理（COPC のパース・octree 走査・変換）は `pcv-core`/
`pcv-convert` に任せ、ここは Tauri との橋渡し（`pcv://` の配信、制御コマンド）に
徹しています。主なファイルは [`copc_state.rs`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src-tauri/src/copc_state.rs)（763行）、
[`conversion.rs`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src-tauri/src/conversion.rs)（407行）、[`lib.rs`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src-tauri/src/lib.rs)（276行）の3つです。

## `copc_state.rs`: `CopcPool` と `pcv://` の配信

`CopcState`（`Mutex<Option<Arc<CopcPool>>>`）が「今開いている COPC ファイル」を
保持します。`CopcPool` は、同じファイルを独立に複数本開き、専用の `File`
ハンドルを持つ `CopcFile` をプールする構造です。読み出しはプールから1本借り、
使い終わったら返します（`Condvar` で空きを待つ）。

なぜこの形になっているかは[データの流れの章](../data-flow.md#pcv-プロトコルtauri)と
[ADR-0007](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0007-pcv-protocol-concurrency.md) に詳しく書かれていますが、要点は「`CopcFile::read_node` は
`&mut self` を取るため、1個の `Mutex` で共有する限り実際の読み出しは直列化する」
ことです。プールサイズは当初 `POOL_SIZE = 8` という決め打ちでしたが、実測の結果
フロント側の同時リクエスト数（4）が先に頭打ちになっていたと分かり、
`std::thread::available_parallelism()` から動的に決める `default_pool_size()`
に変わっています。

ファイルを開く経路は2つあります。

- `CopcPool::open_path` — デスクトップの通常のファイルシステムパス
- `CopcPool::open_uri` — Android の `content://` URI（`tauri-plugin-fs` 経由）

どちらも `File::try_clone()` は使わず、プールサイズ回ぶん独立に開き直します
（複製ハンドルはシーク位置を共有してしまい、並行読みの前提が壊れるため）。
Android の `content://` を開く経路は、`tauri-plugin-fs` のソースを実際に読んで
「ファイル全体をアプリのキャッシュにコピーしない」ことを確認した上で採用されました
（[`TaskSheets/M3-release-and-update.md`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/M3-release-and-update.md) M3-9参照）。

### panic からの復旧（`ADR-0013`）

`read_node_bytes` は、実際の LAZ 伸長を行う `file.read_node(key)` の呼び出しだけを
`std::panic::catch_unwind` で囲みます。panic を捕まえたリーダーはプールに戻さず
捨て、同じ開き方で新しいリーダーを1本開き直して補充します
（`replenish_after_panic`）。これは Android 実機で原因不明のクラッシュが
起きたことを受けた対処で、詳細は [ADR-0013](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0013-crash-visibility.md) を参照してください。

## `conversion.rs`: 変換コマンド

生の LAS/LAZ を COPC へ変換する Tauri コマンドです。重い処理は
[`pcv_convert::streaming`](./pcv-convert.md) に任せ、ここは次のことだけを担います。

- パス（デスクトップ）か `content://` URI（Android）かで開き方を振り分ける
- 既に COPC か、変換済みキャッシュがあるかを判定する（`copc_detect`/`cache`）
- 空き容量を事前にチェックする（`disk_space`）
- 変換を別スレッドで走らせ、進捗・完了・失敗を `invoke` ではなく**イベント**で
  通知する（[規約4](../conventions.md)。進捗の連打には `invoke` よりイベントが向く）
- キャンセル要求の受け口

Android の一時ディレクトリの扱いは少し込み入っています。`copc-writer` の LOD
構築が使う一時ファイルは、渡した `spill_dir` に関わらず常に
`std::env::temp_dir()` を経由します。Rust 標準ライブラリは `TMPDIR` 環境変数を
最優先するため、`redirect_os_temp_dir` が起動時に `TMPDIR`（Unix系）/`TMP`・`TEMP`
（Windows）を書き換えることで、`copc-writer` 側の一時ファイルもまとめて
アプリのキャッシュディレクトリへ誘導しています。

## `lib.rs`: プロトコルの振り分けとログ

`run()` が起動時に行う初期化を1箇所にまとめています。

- `init_logging()` — Android では `android_logger`（タグ `pcv`）、デスクトップでは
  `env_logger`（従来どおり stderr）。`tauri-plugin-log` ではなくこの最小構成を
  選んだ理由は [ADR-0013](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0013-crash-visibility.md) にあります
- `install_panic_hook()` — `std::panic::set_hook` で panic のメッセージを
  `log::error!` に流す。`catch_unwind` で囲んでいない場所の panic も、
  落ちる前に記録だけは残します
- `setup_android_temp_dir()` — Android でのみ、起動直後にキャッシュディレクトリへ
  `TMPDIR` を向け直します

`pcv://` の URL（1セグメント）を、M0 のベンチ用ダミーデータ（`/<size>`）か
M1 のノードデータ（`/<level>-<x>-<y>-<z>`）かで振り分ける処理もここにあります。
`#[tauri::command]` でフロントから呼べる関数（`report_diagnostic`・`bench_invoke`・
`default_bench_data_path`）は、どれも計測・診断用の小さな制御メッセージです。

## まず読むファイル

- [`src-tauri/src/copc_state.rs`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src-tauri/src/copc_state.rs) — `CopcPool` と `pcv://` ハンドラ
- [`src-tauri/src/conversion.rs`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src-tauri/src/conversion.rs) — 変換コマンドとイベント通知
- [`TaskSheets/ADR-0007-pcv-protocol-concurrency.md`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0007-pcv-protocol-concurrency.md) — `CopcPool` が今の形になった経緯
