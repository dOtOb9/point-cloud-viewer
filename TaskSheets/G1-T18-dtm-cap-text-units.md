# G1-T18: DTM の上限の文の数値を表示単位（m / ft）で出す

- 日付: 2026-10-22
- 前提: `TaskSheets/G1-T15-dtm.md` の末尾「実施の記録（エラー文の修正）」。いまの文は「DTM のセルの大きさを 6（点群ファイルの単位）以上に…」で、
  数値がファイルの単位。画面の表示単位がフィートでファイルが m（またはその逆）だと、示した数をそのまま入れると単位がずれる
- 所有者の決定（2026-10-22）: **表示単位で出す**
- 注意: 上限そのもの（`DTM_MAX_*`）は別の作業（メモリの実測のあと）で決め直す。**この作業では上限の値を変えない**

## 1. 直す形

DTM のダイアログで利用者が入れる「DTM のセルの大きさ」「布の解像度」は表示単位（m か ft）で、`src/app/dtm.ts` の `dtmRequestFor` が
ファイルの単位に換算して Rust に渡している（確かめてから進めること）。上限を超えたときの「この大きさ以上にしてください」の数値も、
利用者が入れたのと同じ表示単位で、単位の記号つきで出す。

例（ファイルが m、表示が ft）: `DTM のセルの大きさを 20 ft 以上にするか、先にカットで範囲を切り出してください`

### 方針（いちばん小さい変更）

構造化したエラーを TS まで通す作りにはしない（Tauri と Worker の両方で文字列のエラーの経路を作り直すことになる）。代わりに:

- `DtmRequest`（Rust `crates/pcv-core/src/dtm.rs` と TS の型）に、表示単位を1つ足す。例:
  `displayUnit: { symbol: string, fileUnitsPerDisplayUnit: number | null }`（`null` = ファイルの単位が分からない）。
  Rust 側は `#[serde(default)]` にして、無いときは今の文（「点群ファイルの単位」）のまま
- `DtmJob::new` で、示す最小の大きさを **表示単位で有効数字2桁に切り上げ**、それをファイルの単位に戻した値で
  本物の検査（`grid_for` / `cloth_for`）が通ることを確かめる（今の `smallest_fitting` の「示した値で必ず通る」を保つ）。
  つまり探す変数を表示単位の値にし、検査のときだけファイルの単位に換算する
- 文の中の「（点群ファイルの単位）」を、単位の記号（`m` / `ft`）に置き換える。単位が分からない（`null`）ときは今の文のまま
- 布の解像度の文の「CSF の解像度 {res}」も、表示単位で出す（利用者が入れた値に戻す）
- 上限の個数（「上限は 40000000 セル」）は単位が無いので今のまま

## 2. 受け入れ基準

1. Rust の単体テスト（`crates/pcv-core/src/dtm/tests.rs`）:
   - ファイルが m・表示が ft のとき、文に `ft` が入り、示した数を ft → m に換算した大きさで `DtmJob::new` が成功すること（セル・布の両方）
   - ファイルと表示が同じ単位のとき、今と同じ数になること
   - 表示単位が無い（古いリクエスト）・単位不明のとき、今の文のままであること
2. TS の単体テスト: `dtmRequestFor` が表示単位を入れること（m・ft・単位不明）
3. `cargo test -p pcv-core -p pcv-convert`、`cargo test --manifest-path crates/pcv-wasm/Cargo.toml`、`cargo build -p pcv-core --target wasm32-unknown-unknown`、
   `cargo clippy --workspace --all-targets -- -D warnings`、`cargo fmt --check`（pcv-wasm も）、`npm test`・`npm run lint`・`npm run typecheck` が通る
4. Rust を変えたので、Web 用の wasm を `npm run build:wasm` で作り直し、**別のコミット**にする（前回の G1-T15 と同じ）
5. push 後の CI が success。run id を報告する
6. `TaskSheets/G1-T18-dtm-cap-text-units.md` の末尾に「実施の記録」を足す（日本語）: やったこと、実際に出る文の例（テストの出力から写す）、触ったファイル、実行したコマンドと出力、未確認のこと
7. 画面での表示は、できれば Web（preview サーバー）で、表示単位を ft にして小さいセルで DTM を押し、バナーの文を確かめる。できなければ「未確認」と書く

## 3. 作業の決まり

- `CLAUDE.md` に従う（コードのコメントは英語、TaskSheets・コミットは日本語、コミットの1行目は絵文字＋種類）
- 触った関数では `unwrap`・`expect` を `Result` に直す（テストは対象外）。pcv-core で `std::time` を使わない
- 始める前に `git fetch origin && git rebase origin/main`、push は `git push origin HEAD:main`、push 前に `git diff origin/main --stat` を確かめる
- `git stash` は使わない。`TaskSheets/HANDOFF.md` は触らない
- 別のエージェントが同時に `src/ui/section/`・`src/app/section-export.ts` を触っている。そこは触らない。push で衝突したら rebase して直す
- 10分以上かかりうるコマンドは `run_in_background` で走らせ、結果をファイルから読む

## 実施の記録

### やったこと
- `DtmRequest`（Rust・TS）に `displayUnit: { symbol: "m" | "ft", fileUnitsPerDisplayUnit: number | null }` を足した。Rust 側は `#[serde(default)]` の `Option<DisplayUnit>`（`DtmParams.display_unit` に通す）。無いリクエスト・`fileUnitsPerDisplayUnit` が `null` のときは、今までの文（「点群ファイルの単位」）のまま。
- `DtmJob::new`（`crates/pcv-core/src/dtm.rs`）で、最小の大きさを**表示単位の値**として `smallest_fitting` で探し、検査（`grid_for` / `cloth_for`）のときだけ `× fileUnitsPerDisplayUnit` でファイルの単位に戻す。示した数は、戻した値で本物の検査が通る。
- 布の文の「CSF の解像度 …」は、利用者が入れた値に戻して単位つきで出す（有効数字4桁。0.5 m → 1.64 ft）。
- `src/app/dtm.ts` の `dtmRequestFor` が表示単位を入れる。換算は既存の `displayLengthToFile(1, …)`。
- 途中で見つけた不具合: 有効数字の丸めが `71 * 0.1 = 7.1000000000000005` のように浮動小数のゴミを含んだ数を文に出していた（m でも起きうる）。`with_exponent`（`"71e-1"` を parse）で最近接の小数にした。
- 上限の値（`DTM_MAX_*`）は変えていない。上限の個数・セル数の文は今のまま。

### 他の案を採らなかった理由
構造化したエラーを TS まで通す案は、Tauri と Worker の両方でエラーの経路を作り直すことになるので採らなかった（タスクシートの方針どおり）。`DisplayUnit.symbol` を文字列でなく列挙にしたのは、`DtmRequest` の `Copy` を保つため。

### 実際に出る文（`cargo test -p pcv-core dtm -- --nocapture` の出力）
- セル、ファイル m・表示 ft: `DTM の範囲が大きすぎます（60 列 × 60 行、上限は 100 セル）。DTM のセルの大きさを 20 ft 以上にするか、先にカットで範囲を切り出してください`
- 布、ファイル m・表示 ft: `DTM の布（CSF の解像度 1.64 ft）の粒子数が上限の 1000 個を超えます。布の解像度を 7.1 ft 以上にするか、先にカットで範囲を切り出してください`
- セル、同じ単位（m）: `…DTM のセルの大きさを 6 m 以上にするか、…`
- 布、同じ単位（m）: `DTM の布（CSF の解像度 0.5 m）の粒子数が上限の 1000 個を超えます。布の解像度を 2.2 m 以上にするか、…`
- 表示単位なし・単位不明: 今までの文（`… 6（点群ファイルの単位）以上にするか、…`、`CSF の解像度 0.5）`）と文字列が一致（テストで確認）。

### 触ったファイル
`crates/pcv-core/src/dtm.rs`、`crates/pcv-core/src/dtm/tests.rs`、`crates/pcv-convert/src/dtm.rs`・`crates/pcv-convert/examples/dtm_bench.rs`（フィールドの追加のみ）、`src/datasource/dtm.ts`、`src/app/dtm.ts`、`src/app/dtm.test.ts`、`src/app/dtm-tools.test.ts`・`src/datasource/web-protocol.test.ts`（型を満たすための追加）、`src/wasm/pcv-wasm/pcv_wasm_bg.wasm`（`npm run build:wasm`、別コミット）。

### 新しいテスト
- Rust: `cell_message_in_feet_fits_when_converted_back`・`cloth_message_in_feet_fits_when_converted_back`（示した ft の数を m に戻して `DtmJob::new` が成功）、`same_unit_gives_the_same_number_as_before`、`unknown_file_unit_keeps_the_old_wording`、`a_request_without_a_display_unit_still_parses`。
- TS: `dtmRequestFor` の表示単位（m・ft・単位不明、ft ファイル）。

### 実行したコマンド
- `cargo test -p pcv-core -p pcv-convert`: すべて成功（pcv-core 192 passed / 1 ignored、pcv-convert 100 passed）。
- `cargo test --manifest-path crates/pcv-wasm/Cargo.toml`: 成功（57 passed / 1 ignored ほか）。
- `cargo build -p pcv-core --target wasm32-unknown-unknown`: 成功。`cargo clippy --workspace --all-targets -- -D warnings`: 警告なし。`cargo fmt --check`（pcv-wasm も）: 差分なし。
- `npm run typecheck`・`npm run lint`: エラーなし。`npm test`: 82 ファイル・809 テスト成功。

### 未確認
- 画面（Web の preview サーバーで表示単位を ft にして小さいセルで DTM を押し、バナーを見る）。**未確認**。
- 所有者の確認手順: 設定の表示単位を ft にし、広い点群で DTM のセルを小さく入れて実行。バナーの数が ft で、その数を入れ直すと通ること。ファイルの単位が不明な点群では「（点群ファイルの単位）」の文になること。
- Tauri（デスクトップ）側は、`DtmRequest` を serde でそのまま受けるので変更していない。実機では未確認。
