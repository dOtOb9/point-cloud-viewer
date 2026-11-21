# CM-F2: wasm にビルドした場所のパスを入れない／変換済みキャッシュの削除も変換のロックの中で（F2・F9・F10）

- 元: `PLAN-2026-11.md` の「CM で見つかった後のタスク」F2・F9・F10
- 方針: 3つは別の関心事なので、コミットを分ける（F2 で1つ以上、F9 で1つ以上、F10 で1つ以上）。コードにコメントを書かない。push しない
- 並行: PL-1 と同時に走る。PL-1 が触るファイル（`src/plugin-api/`・`src/core/plugin-host.ts`・`src/ui/plugins/`・`src/plugins/`・`src/app/tea.ts`・`src/app/view.ts`・`src/ui/shell/`・`src/ui/toolbar/`・`src/ui/status/`・`src/ui/tools/`・ADR-0022・ADR-0023）は触らない

## いまの形（メインが読んで確かめたこと、2026-11-21 の `23c51a7`）

- **F2**: コミットしてある `src/wasm/pcv-wasm/pcv_wasm_bg.wasm` に、`grep -aoE "[A-Za-z]:[\\/][A-Za-z0-9_./\\-]{3,60}"` で `C:\Users\Masa1\.cargo\registry\src\index.crates.io-…`（40 か所）・`C:\Users\Masa1\.rustup\toolchains\stable-x86_64-pc-windows-msvc`（28 か所）・`C:\workspace\pcv-wt-CM-4\vendor\laz\src\…`（3 か所）が出る。
  ビルドした PC・場所ごとに中身が変わり、ユーザー名が公開のリポジトリと Pages に出る。`npm run build:wasm`（`package.json` 16 行）は `cargo build … --release` と `wasm-bindgen` だけで、パスを付け替える指定が無い。
  CI の `pages.yml` は wasm を作り直して `npm run check:wasm-glue`（JS と型だけを `git diff`。`.wasm` 本体は比べない）で古さを見る
- **F9**: 設定の「保存領域」の変換済みキャッシュの「消す」「すべて消す」（`src/state/useOpfsStorage.ts` の `removeOpfsCachedConversion`・`clearOpfsCachedConversions`、`useCallback` の手順）は、変換のロック（`withConversionLock`）を取らずに消す。一時ファイルの削除は CM-F1 で `src/app/scratch-cleanup.ts` の `removeScratchDirsUnlessConverting` に移してロックの中にした
- **F10**: `scratch-cleanup.ts` の `removeScratchDirsUnlessConverting` は、消すのに失敗したエラーを `reportError(…, "conversion")` に流すので、エラーの見出しが「変換エラー」になる

## 範囲

触ってよい: `package.json` の `build:wasm`（と、要るなら新しいスクリプト・`crates/pcv-wasm/` のビルドの設定）、`src/wasm/pcv-wasm/`（作り直した生成物）、CI の wasm の検査（`.github/workflows/pages.yml`・`ci.yml` の該当の段）、
`src/state/useOpfsStorage.ts`、`src/app/scratch-cleanup.ts` とテスト（または新しい `src/app/` の関数とテスト）、`src/ui/settings/` の保存領域の部品、`src/renderer/gpu-error-log.ts` の `GpuErrorSource` とその見出しの表（使い手を数えて全部直す）、このシートの記録

## 受け入れ基準

- **AC-1（F2）** `npm run build:wasm` で作った `pcv_wasm_bg.wasm` に、ビルドした PC の絶対パス（ユーザー名・`.cargo`・`.rustup`・作業フォルダ）が入らない。`Masa1`・`.rustup`・`.cargo`・`/Users/`・`/home/` が 0 件で、ドライブ名で始まるパス（前の文字が英字でない `X:\` か `X:/`。`http://` の末尾は数えない）も 0 件であることを、作り直してコミットした wasm で示す。
  Pages に出す wasm（`pages.yml` が作る物）も同じ作り方にする。作業フォルダが違っても同じ wasm になること（再現できるビルド）は求めない（下の「メインの決定」）。wasm が動くこと（`npx vitest run` の wasm を使うテスト、E2E の `web-conversion.spec.ts` を手元で）も確かめる
- **AC-2（F2 の再発防止の芽）** コミットした wasm に絶対パスが入っていたら落ちる検査を、手元（`npm run check:all` に入るもの）か CI に置く
- **AC-3（F9）** 変換済みキャッシュの「消す」「すべて消す」も、変換と同じロック（`withConversionLock`）を取れたときだけ消し、取れなかったら何も消さず、押した場所の近くに一時ファイルと同じ「実行中なので消せません」の文を出す。
  手順は `src/app/` の普通の関数（ADR-0021。フックに手順を残さない）。文がいつ消えるかは CM-F1 と同じ（AGENTS.md の「案内・警告の表示」: 画面を開き直した・一覧を読み直した・対象が無くなった・次に消せた）で、消える時ごとにテストを置く
- **AC-4（F10）** 保存領域の削除の失敗は「変換エラー」でない見出し（保存領域の失敗と分かる日本語）で出る。`GpuErrorSource` を広げたら、使い手（`grep -rn "GpuErrorSource" src`）を数えて記録に書く
- **AC-5** `npm run check:all` が全部 OK。`node scripts/check-task-sheet.mjs <base>` の出力を作業報告に貼る。画面（AC-3 の文）は CM-F1 と同じやり方で 375px・1280px で撮り、見た所見を書く（撮れなければ「未確認」）

## メインの決定（R1 の途中、2026-11-21）

- 最初の AC-1 には「同じソースなら作業フォルダが違っても同じ wasm」があった。作業役が調べた結果、パスを付け替えても wasm は同じにならなかった。`crates/pcv-wasm` の独立したワークスペースの外にある path 依存（`../pcv-core`・`../../vendor/*`）では、Cargo がクレートの識別の値を絶対パスから作る。そのため関数の名前とまとめ方が変わる（作業役の実測: 2 つの作業フォルダで sha256 と関数の数が違い、codegen-units=1 でも同じだった）
- 同じにする案は2つあった。`pcv-wasm` をルートのワークスペースに入れる案は、ADR-0012 の「wasm 用の依存をネイティブの `--workspace` に巻き込まない」に反する。決まった場所に写してビルドする案は、並行するビルドがぶつかる。
  どちらも、F2 の元の問題（ユーザー名とパスが公開物に出る）を直すのには要らない。そのため、この条件を外した（ADR を覆さない側）。再現できるビルドが要るようになったら、ADR-0012 の改訂として所有者に上げる

## 確かめ方

- 上のテストの名前、`npm run check:all` の一覧、`grep` の件数
- 所有者の確認手順: Web 版で大きな LAS の変換を始め、別のタブで 設定 → 保存領域 → 変換済みの「すべて消す」を押し、消せない旨が出て、変換が最後まで終わること

## 記録

（作業役が足す）
