# ADR-0013: Androidの実機クラッシュで原因が見えるようにする

- 状態: 採択
- 日付: 2026-09-24
- 前提: [ADR-0007](./ADR-0007-pcv-protocol-concurrency.md)（`pcv://`とリーダープール
  `CopcPool`）、[ADR-0011](./ADR-0011-gpu-error-visibility.md)（WebGPUエラーを
  バナーに出す仕組み。今回はその延長でノード読み出しエラーも同じバナーに乗せる）、
  [M3-release-and-update.md](./M3-release-and-update.md) M3-3（Androidビルド）・
  M3-9（Androidのファイルアクセス）

## 決定

1. ルートの`Cargo.toml`の`[profile.release]`を`panic = "abort"`から
   `panic = "unwind"`に変えた。
2. `src-tauri/src/copc_state.rs`の`read_node_bytes`で、実際のLAZ伸長を行う
   `file.read_node(key)`の呼び出しだけを`std::panic::catch_unwind`で囲んだ。
   panicを捕まえたら、そのリーダーは`CopcPool`に返さず捨て、同じ開き方で
   新しいリーダーを1本開き直してプールに補充する（`replenish_after_panic`）。
   `src-tauri/src/lib.rs`の`handle_pcv_protocol`は、これがpanic由来か
   （`ReadNodeError::Panicked`）通常のエラーか（`ReadNodeError::Normal`）で
   HTTPステータスを分け、panic由来はHTTP 500 + panicメッセージ・ノードキーを
   本文で返す。
3. `log`クレート＋`android_logger`（Android）／`env_logger`（デスクトップ）を導入し、
   `run()`の最初で初期化する。あわせて`std::panic::set_hook`でpanicのメッセージ・
   発生位置を`log::error!`に流す（`catch_unwind`で囲んでいない場所のpanicも、
   落ちる前にログだけは残す）。Androidのログタグは**`pcv`**。
4. フロントエンドで、ノード読み出しの失敗を[ADR-0011](./ADR-0011-gpu-error-visibility.md)の
   エラーバナー（`GpuErrorLog`/`GpuErrorBanner`）に統合した。`GpuErrorEntry`に
   `source: "gpu" | "node-read"`を追加し、バナーの見出しを出し分ける。クラス名・
   ファイル名は変えていない（理由は後述）。
5. `.github/workflows/release.yml`の`android`ジョブに`actions/upload-artifact`の
   stepを足し、`workflow_dispatch`の手動実行でもAPKをワークフロー実行の成果物として
   残すようにした。タグ・Releaseは相変わらず作らない。

## 背景: `panic = "abort"`だと原因が一切残らなかった

所有者がOPPO Pad Air（Snapdragon 680 / Adreno 610 / RAM 4GB / Android 13）で
Release `v0.1.0`のAPKを試したところ、次の報告があった。

- 点予算を手動で20,000点程度に下げないと落ちる。sofi・autzenとも同じ
- 20,000点はノード1〜2個分（ノードあたり約25,000点）で、メモリの量が原因とは
  考えにくい。**複数ノードを扱うこと自体**が引き金になっている疑いがある

原因はRust側かGPU側かまだ分かっていない（GPU側の切り分けは並行して別作業が
進めている。上の「M3-8」参照）。**このADRの目的は原因を直すことではなく、
次に所有者が試したときに原因が見える状態を作ることである。**

調べたところ、次の事実が分かった。

- ルートの`Cargo.toml`の`[profile.release]`が`panic = "abort"`だった。
  Rustのどこかで1回でもpanicが起きると、`abort`はスタックを巻き戻さず**その場で
  プロセスを即終了させる**。ログを書き出す猶予すら無い。
- `src-tauri/src/copc_state.rs`の`CopcPool`には`.expect("... poisoned")`が
  複数あり、`Mutex`がpoisonされる経路がある（通常は起きないが、境界ケースで
  panicの引き金になりうる）。
- Androidでは、Rustの`stderr`は通常`logcat`に出ない。したがって、たとえ
  `eprintln!`でエラーメッセージを出していても、Android実機ではその情報が
  **どこにも残らない**。

つまり、所有者が実機で見たのは「アプリが突然終了する」という現象だけで、
**Rust側で何が起きたのかを示す手がかりが一切残らない状態**だった。これでは
次に何を試しても、結果から原因を絞り込めない。

## 決定1: `panic = "unwind"`にした理由と影響

`catch_unwind`でpanicを捕まえて処理を続行するには、そもそもRustの
unwind（スタック巻き戻し）機構が有効でなければならない。`panic = "abort"`の
ままでは、`catch_unwind`を書いてもコンパイルは通るが実行時には効かない
（panicが起きた瞬間にプロセスごと終了するため、`catch_unwind`のクロージャに
制御が戻ってくる前にプロセスが消える）。そのため`panic = "unwind"`に変えた。

### 影響（実測・未実測を分ける）

- **バイナリサイズ（デスクトップ、実測）**: Windows向け`pcv-tauri.exe`
  （`[profile.release]`: `codegen-units=1`, `lto=true`, `opt-level=3`,
  `strip=true`は変更前後で共通）。
  - 変更前（`panic="abort"`、2026-09-23時点のビルド）: **4,328,448 バイト**
  - 変更後（`panic="unwind"`、`catch_unwind`まわりのコード・`log`/`env_logger`/
    `android_logger`の追加を含む。`cargo build --release --manifest-path
    src-tauri/Cargo.toml`で実測）: **11,416,576 バイト**
  - **差分: +7,088,128 バイト（約+163.8%、約2.6倍）。** 想定より大きい増加
    だった。`log`/`env_logger`の追加だけでこれほど増えるとは考えにくく、
    `panic = "unwind"`にしたことで、`tauri`/`wry`/`tao`など依存関係全体の
    unwindテーブル・ランディングパッドが有効になったことが主因と推測している
    （panic=abortはコンパイラがこれらを丸ごと省略できるため、依存が大きい
    アプリほど効果が大きく出るという一般的な傾向と整合する）。
    **ただし「`panic`設定単独の効果」と「ロギング用クレート追加の効果」を
    切り分ける計測（例: unwindのままlog/env_loggerを外したビルド）は
    時間の都合で行っていない。** 追加のリリースビルド1回に約11分かかり
    （実測: 11m12s）、切り分けにはさらに複数回のフルビルドが要るため、
    今回は「両方をまとめて変更した場合の実測値」に留めた。
    次にこの値を追う場合は、`CARGO_TARGET_DIR`を固定してから
    `git stash`等でlog/env_logger関連の変更だけを外し、
    `cargo build --release --manifest-path src-tauri/Cargo.toml`を
    実行して`target/release/pcv-tauri.exe`のサイズを比較すればよい。
- **Androidの実機での性能影響**: **未計測**。所有者の実機で確認していない。
  unwindテーブルの分だけ実行時のコード量がわずかに増えるとされるが、
  このアプリのホットパス（LAZ伸長）自体はpanicしない前提のコードであり、
  通常経路の速度に影響するとは考えにくい。ただし断定はしない。
- **APKサイズ（実測）**: `workflow_dispatch`の手動実行（run 35943648697）で
  生成されたAPKは**9,056,793バイト（約8.6MB）**。M3-3が記録した直前の値
  （7.6MB、`android_logger`等の追加前）より約1MB大きい。詳細は下記
  「実行結果」参照。

## 決定2: panicを捕まえる場所とプールの復旧設計

### なぜ`file.read_node(key)`だけを囲んだか

`read_node_bytes`は次の順で処理する。

1. `CopcState`のMutexを一瞬だけロックし、`Arc<CopcPool>`を複製する
2. `pool.checkout()`でリーダー(`CopcFile`)を1本借りる
3. `file.read_node(key)`でLAZ伸長を行う（**ここだけ`catch_unwind`で囲む**）
4. 成功したら`pool.checkin(file)`でリーダーを返す

catch_unwindの対象を(3)だけに絞ったのは、`CopcPool`自身の`idle`Mutexを
panicの間じゅう持たないようにするためである。`checkout()`/`checkin()`は
リーダーを取り出す・戻すだけの一瞬だけロックを持ち、実際の読み出しは
ロックの外で行う（`ADR-0007`で決めた設計をそのまま活かしている）。この
おかげで、`read_node`がpanicしても`CopcPool`のMutex自体がpoisonされることは
無い（poisonされるのは、ロックを保持したままpanicした場合だけ）。

### panicしたリーダーを捨てて開き直す理由

`CopcFile::read_node`は`&mut self`を取る。途中で異常終了した場合、内部の
シーク位置や状態が正しいままである保証は無い。次のリクエストにそのまま
使い回すと、位置がずれたまま読んで一見成功したように見えるが中身が違う、
といった二次的な不具合を招きかねない。そこで、panicしたリーダーは
`checkin`せずに捨てる。

ただし捨てるだけだと、panicが起きるたびに`CopcPool`が1本ずつ縮んでいって
しまう。そこで`CopcPool`は開き方（`open_one`。`open_path`/`open_uri`が
それぞれ自分のクロージャを渡す）を覚えておき、panicのたびに同じ開き方で
新しいリーダーを1本開き直してプールに補充する（`replenish_after_panic`）。

補充自体が失敗した場合（ディスクエラー等）は、プールが1本減ったままに
なることを許容する。ここでリトライを重ねると設計が複雑になるうえ、
失敗の原因がリトライで直る見込みは薄い。**「プールが痩せてもアプリは
生き続ける」ことを、二次的な失敗への完全な対処より優先した。**

### HTTPステータスの使い分け

`ReadNodeError`を`Normal`（400）と`Panicked`（500）の2種類に分けた。
「ファイル未オープン」のようなクライアント（フロント）の呼び方の問題と、
「サーバ側の処理が予期せず異常終了した」という問題は性質が違うため、
異なるステータスコードを割り当てた。フロントは`ReadNodeError`の種類を
見分ける必要が無く、HTTPのステータスとボディの文字列だけを見ればよい。

### 検討したが採らなかった案

| 案 | 却下理由 |
|---|---|
| `checkout`/`checkin`も含めて丸ごと`catch_unwind`で囲む | `CopcPool`自身のMutexをpanicの間じゅう持つことになりかねず、poisonのリスクを増やす。実際の読み出し（panicしうる箇所）だけを絞って囲む方が安全 |
| panicしたリーダーもそのままプールに戻す | `&mut self`の処理が途中で終わった後の内部状態を信用できない。次のリクエストで誤ったデータを返す可能性がある二次的な不具合の方が、プールが1本減ることより悪いと判断した |
| 補充が失敗したらリトライし続ける | 失敗の原因（ディスクエラー等）がリトライで直るとは限らず、設計が複雑になる。プールが痩せた状態で動き続けられるなら十分と判断した |
| `CopcPool`ごと丸ごと開き直す | 影響範囲が過大（他のリクエストが借りている分も巻き添えにする）。1本だけの補充で足りる |

## 決定3: panicとログをAndroidのlogcatに出す

### `android_logger`を選んだ理由（`tauri-plugin-log`との比較）

今回必要なのは「Rustのpanic・エラーメッセージをネイティブ側のログ経路
（logcat/stderr）に残す」ことだけである。フロントのJS側からログを出す・
webviewのdevtoolsに出す・ログファイルをローテーションする、といった機能は
要らない。`tauri-plugin-log`はそれら全部を持つ大きめのプラグインで、
`invoke`ハンドラの登録やJS側API（`@tauri-apps/plugin-log`）まで付いてくる。
今回の要件に対して依存が増えすぎると判断し、`log`ファサード＋プラットフォーム
ごとの薄いバックエンド（Android: `android_logger`、デスクトップ: `env_logger`）
という最小構成にした。所有者が実装を追えることを優先する方針
（`ARCHITECTURE.md`）にも沿う。

### 経路

- `src-tauri/src/lib.rs`の`init_logging()`を`run()`の最初で呼ぶ。
  - Android: `android_logger::init_once`。タグは**`pcv`**（`ANDROID_LOG_TAG`定数）。
  - デスクトップ: `env_logger`。既定の出力先はstderrで、これまでの
    `eprintln!`と同じ場所に出る（**デスクトップでは今までどおりstderrに出る**
    という要件を満たす）。
- `install_panic_hook()`で`std::panic::set_hook`を設定し、panicのメッセージ・
  発生位置を`log::error!`に流す。`copc_state::read_node_bytes`のように
  明示的に`catch_unwind`で囲んでいない場所でpanicが起きても、少なくとも
  「何が・どこで」起きたかはlogcat/stderrに残る（`panic = "unwind"`にした
  今も、捕まえていないpanicはunwindが最後まで届けばプロセスは終了する。
  ここでの目的は「落とさない」ことではなく「落ちる前に記録を残す」こと）。
- `handle_pcv_protocol`のエラー分岐（`ReadNodeError::Normal`/`Panicked`）も
  `eprintln!`から`log::warn!`/`log::error!`に変えた。

### 所有者が見る場所

**Androidのlogcatをタグ`pcv`で絞り込む:**

```
adb logcat -s pcv:*
```

（`-s`は指定したタグ以外を黙らせるオプション。`android_logger`は
Rustの`log::error!`/`warn!`/`info!`をそれぞれAndroidのE/W/Iレベルに
対応付けて出す。）

デスクトップでは`npm run tauri dev`のターミナルにこれまでどおり出る
（`env_logger`の既定出力先はstderr）。

### スコープを絞ったこと（正直に）

既存の`println!`によるフロント診断メッセージの転送（`report_diagnostic`）や
統計情報の出力は、今回`log`クレート経由に変えていない。これらは
panicやエラーではなく通常の診断出力であり、今回の「実機クラッシュの原因を
見えるようにする」という目的には直接関係しない。範囲を広げるとレビューが
難しくなるため、panic・エラーメッセージ（`log::error!`/`warn!`を使う箇所）に
絞った。

## 決定4: フロントのエラーバナーにノード読み出し失敗を統合した

[ADR-0011](./ADR-0011-gpu-error-visibility.md)で作った`GpuErrorLog`/
`GpuErrorBanner`は、蓄積・重複抑制・表示（本文そのまま・複数保持・不透明・
閉じられる）の要件をすでに満たしている。ノード読み出し失敗にも同じ要件が
そのまま当てはまる（Rust側がpanicから復旧して返すメッセージも、panicの内容と
ノードキーを含む具体的な文字列であり、要約せずそのまま見せることに価値がある）。
そのため専用の仕組みを新設せず、既存の仕組みに`source: "gpu" | "node-read"`を
足して統合した。

### 名前を変えなかった理由

`GpuErrorLog`/`GpuErrorBanner`という名前は、もはや「WebGPU専用」ではなくなった。
名前を変える判断も検討したが、次の理由で見送った。

1. 中身（`gpu-error-log.ts`）は元々WebGPUに一切依存しない汎用のロジックで、
   ADR-0011の時点でも「GPUDeviceのモックを一切必要としない」ことが明記されて
   いた。名前と実装の依存関係の不一致は今回新しく生まれたものではない。
2. 名前を変えると`point-cloud-renderer.ts`・`useCopcViewer.ts`・
   `AppShell.tsx`など複数ファイルに影響する。ちょうど並行して別の作業
   （M3-8のモバイル向けGPU最適化）が`point-cloud-renderer.ts`・
   `useCopcViewer.ts`を触っていたため、変更対象ファイルを不必要に
   増やしたくなかった。
3. バナーの見出しは`source`で「WebGPU エラー」/「ノード読み出しエラー」に
   出し分けるため、所有者が画面を見て混乱することは無い。

### 実装

- `src/datasource/tauri.ts`の`readNode`: 失敗時にレスポンス本文を読み、
  そのまま`Error`の`message`に含める（以前はHTTPステータスコードしか
  含めておらず、Rust側が残したpanicメッセージが失われていた）。
- `src/renderer/node-load-error.ts`: ノードキー＋エラー本文から表示用の
  1行を組み立てる純粋関数（`formatNodeLoadErrorMessage`）。本文は
  要約・切り詰めしない。GPUにもReactにも依存しないため、単体テストが
  素朴に書ける（`node-load-error.test.ts`）。
- `src/renderer/point-cloud-renderer.ts`: `NodeLoader`の`onFailed`を
  `reportNodeLoadError()`で受け、`onGpuErrorReported`と対になる形の
  `onNodeLoadErrorReported`で外へ渡す（規約3: このファイルはReactを
  知らないので、コールバックで外へ渡すだけ）。
- `src/renderer/gpu-error-log.ts`: `GpuErrorEntry`に`source`を追加。
  連投抑制の判定はメッセージ**と**`source`の両方が一致するかで行う
  （たまたま同じ文言のGPUエラーとノード読み出しエラーが連続しても、
  互いの発生元ラベルの下に紛れ込まない）。`source`省略時の既定値は
  `"gpu"`なので、既存の呼び出し元（GPUエラーの報告）は無変更で動く。
- `src/state/useCopcViewer.ts`: `onNodeLoadErrorReported`を同じ
  `GpuErrorLog`に`source="node-read"`で流す。
- `src/ui/shell/GpuErrorBanner.tsx`: 見出しを`SOURCE_LABEL`で出し分ける。

## 決定5: `workflow_dispatch`でAPKを成果物として残す

`.github/workflows/release.yml`の`android`ジョブに`actions/upload-artifact@v4`の
stepを、`if`条件無し（常に実行）で足した。既存の`Upload APK to GitHub Release`
（タグpush時だけ実行）とは独立した経路であり、タグ・Releaseの作成には
一切影響しない。保持期間は14日（試験用の一時的な成果物であり、Releaseのように
長期保管する対象ではないため、既定の90日より短くした）。

これにより、所有者はタグを打たずに`gh workflow run release.yml --ref main`→
`gh run download <run-id>`で、本ADRの変更（panic=unwind・catch_unwind・
logcat出力・エラーバナー統合）を含む試験用APKを取れる。

## 検証について（正直に）

**GUIを持たないため、実機での動作（実際に複数ノードを扱ったときに落ちなく
なるか、logcatに実際にpanicメッセージが出るか、バナーが実際に表示されるか）は
確認していない。** 確認済み・未確認を以下に分ける。

**確認済み（機械的に）:**

- 新規テスト`read_node_bytes_recovers_pool_after_panic_during_read`
  （`src-tauri/src/copc_state.rs`）: `#[cfg(test)]`限定の差し込み
  （`PANIC_ON_NEXT_READ`スレッドローカルフラグ）で`file.read_node`の直前に
  意図的にpanicを起こし、(a) `ReadNodeError::Panicked`になり、
  (b) その後も同じ`CopcState`（同じプール）で全ノードを問題なく読める
  ことを確認した。本番コードにテスト用の分岐を残す場合は`#[cfg(test)]`に
  閉じ込める、という受け入れ条件を満たしている。
- `cargo fmt --check` / `cargo clippy --workspace --all-targets -- -D warnings` /
  `cargo test --workspace`がすべて成功することを確認した（下記「実行結果」）。
- `npm run typecheck` / `npm run lint` / `npm test`（177件、新規追加分含む）/
  `npm run build`がすべて成功することを確認した。
- CI（`ci.yml`）が緑であることを確認した（下記「実行結果」の run id）。
- `workflow_dispatch`での手動実行で、Android APKがビルドされ
  `actions/upload-artifact`の成果物として残ることを確認した
  （下記「実行結果」の run id・成果物名）。

**未確認（GUIを持たないエージェントの限界。所有者の実機確認が必要）:**

- 実際にOPPO Pad Airで複数ノードを扱っても落ちなくなったか
  （そもそも原因がRust側のpanicだったのかどうか自体、まだ確定していない。
  GPU側の切り分けは並行して別作業が進めている）
- `adb logcat -s pcv:*`で実際にpanic・エラーメッセージが見えるか
- ノード読み出し失敗時に、実際に画面のバナーに「ノード読み出しエラー」の
  見出しと本文が表示されるか
- panicから復旧した後、実際にアプリの操作を続けられるか（プールの補充が
  実機の環境でも機能するか）

## 所有者が次に実機で試す手順

1. 試験用APKを取得する（タグ・Releaseは作らない）。
   ```
   gh workflow run release.yml --ref main
   gh run list --workflow=release.yml --limit 1   # run idを控える
   gh run download <run-id> -n android-apk
   ```
2. 既存のAPKをアンインストールしてから新しいAPKをインストールする
   （debug鍵の署名は変わらないはずだが、万一署名が変わっていた場合は
   上書きインストールが拒否されるため）。
3. `adb logcat -c`でログをクリアしてから`adb logcat -s pcv:*`を実行し、
   ログを表示したままアプリを操作する。
4. これまで落ちていた操作（複数ノードにまたがる点群の表示）を試す。
   - 落ちなくなった場合: 画面にエラーバナーが出ていないか確認する。
     「ノード読み出しエラー」のバナーが出ていれば、panicから復旧できている
     ことの証拠になる。
   - それでも落ちる場合: `adb logcat -s pcv:*`の出力（特に`panic:`で
     始まる行）を確認する。何かログが出ていれば、少なくとも原因の手がかりが
     得られる。**何も出ない場合は、今回の仕組みがカバーしていない場所
     （例えばGPU側、またはRustのpanic以外の異常終了）が原因である可能性が
     高いという情報になる。**

## 実行結果

```
$ cargo fmt --check
（出力無し、終了コード0）

$ cargo clippy --workspace --all-targets -- -D warnings
    Finished `dev` profile [unoptimized + debuginfo] target(s)
（警告・エラー無し）

$ cargo test --workspace
test copc_state::tests::read_node_bytes_fails_before_any_file_is_open ... ok
test copc_state::tests::independently_opened_file_handles_have_independent_seek_positions ... ok
test copc_state::tests::open_copc_impl_populates_state_and_reports_summary ... ok
test copc_state::tests::copc_pool_open_path_builds_pool_with_requested_size ... ok
test copc_state::tests::read_node_bytes_matches_m1_2_wire_format ... ok
test copc_state::tests::read_node_bytes_recovers_pool_after_panic_during_read ... ok
test result: ok. 6 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
（pcv-core側の既存10件も含め、ワークスペース全体で成功）

$ npx tsc --noEmit
（出力無し、終了コード0）

$ npx eslint .
（出力無し、終了コード0）

$ npx vitest run
 Test Files  21 passed (21)
      Tests  177 passed (177)

$ npm run build
✓ 71 modules transformed.
✓ built in 684ms
```

CI（`ci.yml`）: 本ADRの変更を含む一連のpush（run 35942928386、35943517848、
35943632081、35944149624など）がすべて成功したことを`gh run list`で確認した。

`workflow_dispatch`での手動実行（タグ・Releaseは作らない経路）:
**run 35943648697**（`gh workflow run release.yml --ref main`で自分で実行した）。
`gh run view 35943648697`で`windows`・`android`両ジョブがsuccessになり、
`ARTIFACTS`欄に`android-apk`が1件あることを確認した。実際に
`gh run download 35943648697 -n android-apk`でダウンロードし、中身が
`universal/release/app-universal-release-debug-signed.apk`（**9,056,793バイト、
約8.6MB**）1件であることを確認した。M3-3が記録した直前の値（7.6MB、
`android_logger`追加前）より約1MB大きいが、`android_logger`の追加分・
`catch_unwind`まわりのコード追加分として妥当な範囲と考えられる（詳しい
内訳の切り分けはしていない）。タグ・Releaseは作られていないことも
`gh api repos/.../releases`相当の確認は行っていないが、このワークフロー
自体がタグpush時にしか`softprops/action-gh-release`のstepを実行しない設計
であり、今回`github.ref`はブランチ（`refs/heads/main`）だったため
該当stepはすべて`skipped`だった（`gh run view`のジョブ詳細で確認済み）。
