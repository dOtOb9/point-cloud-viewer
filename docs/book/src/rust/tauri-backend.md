# src-tauri: デスクトップ・Android の裏側

`src-tauri` はデスクトップ・Android 版の Rust 側です。[規約4](../conventions.md) により
薄く保たれており、重い処理（COPC のパース・octree 走査・変換）は `pcv-core`/
`pcv-convert` に任せ、ここは Tauri との橋渡し（`pcv://` の配信、制御コマンド）に
徹しています。主なファイルは [`copc_state.rs`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src-tauri/src/copc_state.rs)（965行）、
[`conversion.rs`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src-tauri/src/conversion.rs)（942行）、[`lib.rs`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src-tauri/src/lib.rs)（504行）の3つです。

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

ファイルを開く経路は2つあります(`open_copc` が振り分ける)。

- `CopcPool::open_path` — デスクトップの通常のファイルシステムパス
- `CopcPool::open_uri` — Android の `content://` URI（`tauri-plugin-fs` 経由）

どちらも `File::try_clone()` は使わず、プールサイズ回ぶん独立に開き直します
（複製ハンドルはシーク位置を共有してしまい、並行読みの前提が壊れるため）。
Android の `content://` を開く経路は、`tauri-plugin-fs` のソースを実際に読んで
「ファイル全体をアプリのキャッシュにコピーしない」ことを確認した上で採用されました
（[`TaskSheets/M3-release-and-update.md`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/M3-release-and-update.md) M3-9参照）。

### 複数ファイルを同時に開く: `CopcState` と `generation`(`cloudId`)

`CopcState` は、以前の「今開いている1つのファイル」ではなく、**`generation`(u64)からプールを引く表**(`HashMap<u64, Arc<CopcPool>>`)を持ちます(L1-B)。

- `open_copc`(Tauri コマンド) — パスか `content://` かを `FilePath::from_str` で判別してプールを作り、`open_copc_impl` が info と hierarchy を返す。`next_generation` を1つ進めて表に**足す**(他のファイルは閉じない)。返す `generation` がフロントの `cloudId`。
- `close_copc(generation)` — 表から外すだけ(冪等。知らない世代でもエラーにしない)。読み出し中のリクエストは `Arc` を持っているので、終わるまでハンドルは生きる。
- `read_node_bytes(state, generation, key)` — 表に無い世代(閉じた・知らない・切り替え前の古いリクエスト)は `ReadNodeError::Stale`。`lib.rs` の `handle_pcv_protocol` は HTTP 409 で返し、フロントはエラーに出さず黙って捨てる。

`pcv://` の URL は `"<generation>/<level>-<x>-<y>-<z>"` です(`lib.rs` の `parse_pcv_path`)。`convertFileSrc` が全体を1セグメントとしてパーセントエンコードするので、
`parse_pcv_path` は**解析の前に必ずデコードします**(v0.1.3 で、これを忘れて全ノードが失敗した)。流れは[ノードの読み込み](../flows/node-loading.md)の章を見てください。

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

コマンドは次のとおりです(`lib.rs` の `invoke_handler` に登録)。

| コマンド | 内容 |
|---|---|
| `start_las_conversion` | 単一ファイルの変換を始める。`AlreadyCopc`・`Cached`・`InsufficientSpace`・`Converting` のどれかを返し、`Converting` のときだけ別スレッド(`run_conversion_thread`)で変換する。LAS/LAZ と E57/PLY/PCD の両方を扱う |
| `start_multi_las_conversion` | 複数の LAS/LAZ を1つの COPC にまとめる(M4-14)。`run_merge_conversion_thread` が `pcv_convert::merge::merge_paths_and_timings` を呼ぶ。1つだけなら `start_las_conversion` に委譲。`content://` は未対応 |
| `cancel_las_conversion` | `ConversionState` のキャンセルフラグを立てる(変換とツールで共通) |
| `supports_custom_temp_dir` | 一時フォルダの場所を設定できる環境か |
| `extract_copc` | 点の選択・断面(L2-C)。`pcv_convert::extract::extract_path_and_timings` を呼び、結果の COPC のパスを返す |
| `merge_copcs` | 開いている複数レイヤーの結合(L2-C)。`merge_paths_and_timings` を呼ぶ |

`extract_copc`・`merge_copcs` は `async` で、`run_tool` が `spawn_blocking` に出します。同時に動かすのは1つだけ(`ConversionState` のフラグを共有するので、変換中はツールを動かせない)。
panic は `catch_unwind` で文字列のエラーにします(ADR-0015)。進捗は変換と同じ `conversion-progress` イベントを使い、完了・失敗のイベントは出さず、結果は戻り値(`ToolOutput`)で返します。
出力先は一時フォルダ配下の `pcv-tools/`(`tool_output_path`)です。流れは[点の選択・断面・結合](../flows/point-cloud-tools.md)の章を見てください。

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
M1 のノードデータ（`/<generation>/<level>-<x>-<y>-<z>`）かで振り分ける処理もここにあります。
`#[tauri::command]` でフロントから呼べる関数（`report_diagnostic`・`bench_invoke`・
`default_bench_data_path`）は、どれも計測・診断用の小さな制御メッセージです。

## まず読むファイル

- [`src-tauri/src/copc_state.rs`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src-tauri/src/copc_state.rs) — `CopcPool` と `pcv://` ハンドラ
- [`src-tauri/src/conversion.rs`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src-tauri/src/conversion.rs) — 変換コマンドとイベント通知
- [`TaskSheets/ADR-0007-pcv-protocol-concurrency.md`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0007-pcv-protocol-concurrency.md) — `CopcPool` が今の形になった経緯
