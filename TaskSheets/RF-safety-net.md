# RF-safety-net: 安全網（RF-0 文書、RF-1 層の規約の検査、RF-15 wasm の鮮度）

- 元: [REVIEW-architecture-2026-11.md](./REVIEW-architecture-2026-11.md) の A-3・A-6・A-9 と、RF-0・RF-1・RF-15
- 作業: 作業エージェント（ブランチ `trendpoint-parity`、開始時の HEAD `9a312db`）
- 方針: 振る舞いは変えない。push しない。CI は手元で動かせないので、`ci.yml`・`pages.yml` の変更は「同じコマンドを手元で実行して確かめた」ことと「CI では未確認」を分けて書く

---

## RF-0 文書を現状に合わせる

### やったこと

- `TaskSheets/ARCHITECTURE.md`
  - ディレクトリの図を実際に合わせた: `src/app/`・`crates/pcv-convert/`・`vendor/`・`e2e/`・`scripts/`・`docs/book/`・`src/ui/toolbar/`・`src/ui/section/` を足し、
    無い `ribbon/` を消した。`src/ui/tools/` の説明を、いまある物（抽出・間引き・フィルタ・DTM・視点・ラスタの窓）に直した
  - 規約の数: 「この4つが崩れると」→「この5つ」。規約 1・2・3・5 が `invariants` ジョブの検査で、4 は検査の対象外と明記（CLAUDE.md の書き方に合わせた）
  - 規約 3 の後半（`src/ui/` はレンダラを直接触らない）は、検査されておらず実際には破られていると書いた（A-3）。決め直しは RF-1 で行う
  - 「WebGPU の API を直接叩くのは `gpu-resources.ts` だけ」を取り消した。`edl.ts`・`sky.ts`・`ground-grid.ts`・`depth-pick.ts` も `device.create*` を呼ぶ（`grep` で 5 ファイルを確かめた）
  - 状態の表: I-1（`Dock.ui`・ui-forge。削除済み）の行を消した。M4-9 の「Web版へは未配線」を「R7 で配線済み」に直した。
    ピック・計測・抽出・結合、断面、ラスタ・DTM・間引き・フィルタ、視点（TP-1）の行を足した
  - 末尾に「これから」の節を足した。ADR-0022（TEA）・ADR-0023（プラグイン）で**決まっただけで、まだコードに無い**形を短く書き、無いものを「ある」と読まないよう明記した
- `TaskSheets/ROADMAP.md`: マイルストーン表の「状態」を実装に合わせた（M2 実装済み、M3 は M3-1〜6 実装済み、M4 実装済み、M5 は一部、G1〜G3・TP の行を追加）。
  土台の表のうち、空間クエリ層・ピッキング・カメラのナビゲーション・2D プロファイル描画は「ある」に直した（メッシュ描画パイプラインだけ「無い」のまま）
- 古いコメント: `Cargo.toml` の `pcv-convert`（「M4-1 のスパイク」→ 本番の変換器）、`eslint.config.js`（ui-forge の生成物の説明）、
  `src/datasource/DataSource.ts` の見出し（「HttpSource を差し替える想定」→ `TauriSource`・`WebSource` が実装している。ツールはまだ入っていない）、
  `ci.yml` の「この2つが崩れると」。コードのコメントは CLAUDE.md に従い英語にした（`ci.yml` の既存の日本語のコメントは日本語のまま）
- `HANDOFF.md` には触っていない（コーディネーターの担当）

### 採らなかった案

- ARCHITECTURE.md の「現在の状態」の長い表の書き直し: 行ごとの文が長く（1 行 1,000 字級）、全面的に直すと差分が読めない。事実と食い違う行（I-1・M4-9・WebGPU の注記）だけを直し、足りない領域は行を足した
- 規約 4（`pcv://` で運ぶ）の検査を足す案: RF-0 の範囲（文書）を超える。必要なら別タスク

### 触ったファイル

`TaskSheets/ARCHITECTURE.md`、`TaskSheets/ROADMAP.md`、`TaskSheets/RF-safety-net.md`（新規）、`Cargo.toml`、`eslint.config.js`、`.github/workflows/ci.yml`、`src/datasource/DataSource.ts`

### 確かめ方（AC）

- AC-1（ARCHITECTURE.md のパスがすべて存在する）。リポジトリのルートで次を実行する。「これから」の節の前までを見る（その後ろは、まだ無い物を書いているため）。何も出なければ合格:

  ```sh
  sed '/^## これから/,$d' TaskSheets/ARCHITECTURE.md \
    | grep -oE '(src|crates|src-tauri|TaskSheets|docs|e2e|scripts|vendor)/[A-Za-z0-9_./*-]+' \
    | sed 's/[.,]*$//' | sort -u \
    | while read -r p; do case "$p" in *'*'*) continue;; esac; [ -e "$p" ] || echo "MISSING: $p"; done
  ```

  実行結果: 出力なし（RF-0 のコミット時点）。同じ検査をリンク（`./ADR-*.md` など）にも行い、欠けは無かった
- AC-2（ROADMAP の状態が実装と一致）: 表の各行を、実在するコード（`crates/pcv-core/src/{extract,section_line,profile,raster,dtm,thin,outlier}*`、`src/renderer/depth-pick.ts`・`raycast.ts`・`projection.ts`、`src/ui/section/`、`.github/workflows/release.yml`、`src/datasource/update-check.ts`）の存在と突き合わせた。
  動くかどうかの確認ではなく、「あるものを無いと書いていない」ことの確認
- AC-3（規約の番号と数）: CLAUDE.md（規約 1・2・3・5、4 は対象外）、ARCHITECTURE.md（5 つ、検査は 1・2・3・5）、`ci.yml`（`invariants` の 3 段: 規約 1、2、3・5）で一致。
  RF-1 の後は検査の中身が変わるので、そこで改めて合わせる（RF-1 の節）

---

## RF-1 層の規約を ESLint と madge で検査し、循環をなくす

### やったこと

1. **規約 2・3・5 を ESLint に移した**（`eslint.config.js`）。`no-restricted-imports` の `regex` パターンで、import 文の文字列だけを見る。
   - 全 `src/` で `^@tauri-apps/` を禁止（`src/datasource/tauri.ts` だけ除く）。`plugin-opener` など `api` 以外も止まる（A-3 の抜け穴）
   - `src/renderer/`: さらに `react`・`react-dom`。`src/app/`: さらに `react*` と `state/use*`（`import type` も止まる）
   - `src/renderer/**/*.tsx`・`src/app/**/*.tsx` には JSX を禁止する `no-restricted-syntax`（旧 CI の「`.tsx` ファイルがあれば落ちる」の代わり。JSX は React を暗黙に import するため）
   - **規約 3 の後半を決め直した**: 「`src/ui/` は `PointCloudRenderer` クラス（`renderer/point-cloud-renderer`）を import しない。純粋な関数・定数・型はよい」。
     ESLint は `src/ui/` でこのクラスの import を禁止する
   - **ADR-0023 の `src/plugins/**`**: 今はフォルダが無いが、あとから作っても効く形で入れた。`src/plugins/<…>/` の深さ（0〜6）ごとに設定を作り、
     (a) 相対でも `react`/`lucide-react`（テストでは `vitest` も）でもない import を禁止、(b) 相対 import は「`../` を何回登るか」で見て、
     自分のフォルダの外に出る登り方は、`src/plugin-api`・`src/ui/kit` に着く場合だけ許す。他のプラグイン・コア（`app`・`renderer`・`ui` の `kit` 以外など）は禁止
2. **CI**（`ci.yml`）: `invariants` ジョブの grep 2 段（規約 2、規約 3・5）を外し、規約 1 の検査だけ残した。規約 2・3・5 は `frontend` ジョブの `npm run lint` が検査する。
   `frontend` ジョブに `npm run check:circular`（madge）を足した
3. **madge**: `devDependencies` に `madge@^8`、`scripts` に `check:circular`（`madge --circular --extensions ts,tsx src`）。型だけの import も数える（既定）。
   `package.json` に `"overrides": { "typescript": "$typescript" }` を足した（下の「採らなかった案」）。`package-lock.json` を更新した
4. **循環 3 件を消した**（A-3）: `ToolProgressState` を `src/app/point-cloud-tools.ts` へ、`OpfsStorageInfo` を `src/state/useOpfsStorage.ts` へ移した（作るモジュール側）。
   `src/app/` は `viewer-types.ts` を import しなくなり、`app → state/use*`（型経由）の依存も消えた
5. **`viewer-types.ts` の型の再 export を消した**（`PointShape`・`GpuErrorEntry`・`BackgroundMode`・`ColorMode`・`ViewerLayer`・`ConversionProgress`、同じ 2 行のコメント 5 回分）。
   `useCopcViewer.ts` の再 export は `CopcViewerState` だけにした。使っていた 4 つの UI（`AppearanceDialog`・`ColorModeDialog`・`ErrorDialog`・`BackgroundDialog`）は、型を元のモジュールから直接 import する
6. **`update-check.ts` の `openUrl` を `src/datasource/tauri.ts` の `openReleasePage` へ移した**（コーディネーターの決定。規約に例外を作らない）。
   `useUpdateCheck.ts` は `tauri.ts` から `getAppVersion` と一緒に import する。`update-check.ts` は Tauri を import しない
7. **テスト**: `src/layer-rules.test.ts`（38 ケース）。ESLint の API で、作り話のパスにソースを与えて lint し、規約 2・3・5 と `src/plugins/**` の許す・許さないを確かめる。コメントにパッケージ名を書いても落ちないこともここで確かめる
8. 文書: `CLAUDE.md` の規約の節（検査の方法、規約 3 の後半、規約 2 に例外が無いこと、`src/plugins/**`）、`ARCHITECTURE.md` の規約 2・3・5（RF-0 で「RF-1 で決め直す」と書いた所を直した）

### 採らなかった案

- **`eslint-plugin-import` の `no-restricted-paths`（解決したパスで禁止する）**: 依存が増え、TS のパス解決の設定も要る。`regex` パターンで、plugins の相対 import を「登る段数」で見れば足りた。
  限界: 別名（alias）の import は見られない。このリポジトリは alias を使っていない（使うなら裸の import として禁止される）
- **ファイルごとに `no-restricted-imports` を重ねる**: ESLint は同じルールの設定を後勝ちで置き換えるので、重ねると前の禁止が消える。ゾーンごとに完全な一覧を持たせ、ゾーンが重ならないようにした
- **`madge` を `npx madge@8` で CI から呼ぶ（devDependency を足さない）**: 版がずれる・毎回取得する。コーディネーターの判断で devDependency にした
- **`overrides` を madge だけに限る**（`"madge": { "typescript": "$typescript" }`）: 試したが、`npm ci` が `typescript@5.9.3` が lock に無いと落ちた
  （madge の依存の `filing-cabinet` などが `typescript@^5.9.3` を本物の依存として要求し、root は `~6.0.3`）。全体の `typescript` を root の指定に揃える形にしたら `npm ci` が通った。
  実際に入る `typescript` は変わらず 6.0.3 のまま（`npm ls typescript` に `invalid` が 0）
- **`src/app/` が `src/ui/` を import することの禁止**（ADR-0021 の「React を import する物を import しない」の一部）: 今の違反は 0 件だが、依頼の範囲を超えるので足していない。
  `src/app/` が React を import するモジュールを経由して推移的に React に届くこと全体は、ESLint でも madge でも見ていない
- **`src/ui/` から `src/datasource/` への import の禁止**: REVIEW は規約 3 を「`PointCloudRenderer` クラスだけ」と決めた。`pickFilesToOpen` などは許したまま
- **旧 CI の「`.tsx` があれば落ちる」を `find` で残す**: JSX を書いたら React が要るので、構文の禁止で同じ意味になる。ファイル名だけで落ちるより正確

### R2（監査 R1 への対応）

- **F-1 直した**: `no-restricted-imports` は動的な `import("x")` を見ない。各ゾーンの禁止パターンを、`no-restricted-syntax` の
  `ImportExpression[source.value=/…/]` にも同じ正規表現で書く（`layerRules()`）。ESLint は同じルールの設定を後勝ちで置き換えるので、
  JSX の禁止もゾーンの一覧にまとめた。esquery の正規表現は `/` を含められないので、文字クラスの外の `/` は `[/]` に変換する（`selectorRegex()`）。
  限界: 引数が文字列リテラルでない `import(name)` やテンプレートリテラルは見えない
- **F-2 直した**: 型の位置の `import("x").Y`（`TSImportType`）も同じ正規表現で止める
- **F-3 直した**: `RENDERER_CLASS` の末尾に拡張子（`.ts`・`.js` など）を許した
- **F-4 直した**: パターンに `caseSensitive: true`（`../state/user-settings` は許される）
- **F-5 直した**: 正規化していないパス（`./..`・`x/../y`・`a/./b`）を `src/app` と `src/plugins/**` で禁止した。`"../.."`（末尾に `/` が無い）も数える。
  プラグインの深さの上限を 8 にし、それより深いファイルは「裸の import と正規化」の検査だけ（限界）。
  限界: `src/state` の `index`（`../state`）への import は止めない（そのファイルが今は無い）
- **F-6 直した**: 層のルールを `src/**/*.{ts,tsx,js,mjs,cjs}` に広げ、生成物の `src/wasm/**` は除いた
- **F-7 直した**: ROADMAP の 2D プロファイルの説明（Canvas 2D と SVG）、`crates/pcv-convert/Cargo.toml` の description、上の版の一覧
- **F-8**: madge の代わりに `dpdm` や `eslint-plugin-import` の `import/no-cycle` を**比べていない**。madge にしたのは、REVIEW の計測が madge で、
  `npx madge` で動かせたため。依存の重さ（+1,530 行の lock）が気になるなら、`import/no-cycle` への置き換えを検討する余地がある（未検討）。
  **TypeScript をメジャーで上げるとき**は、madge 側の依存（`filing-cabinet`・`detective-typescript`）が新しい版に対応しているか確かめる
  （今は `overrides` で 6.0.3 を無理に使わせている。`npm run check:circular` が動くことで確かめる）
- テスト: `src/layer-rules.test.ts` に監査役の赤のテスト 9 件（そのまま緑になった）と、F-4・F-5・F-6 の 8 件を足した。計 55 ケース

### 触ったファイル

`eslint.config.js`、`.github/workflows/ci.yml`、`package.json`、`package-lock.json`、`CLAUDE.md`、`TaskSheets/ARCHITECTURE.md`、`TaskSheets/RF-safety-net.md`、
`src/layer-rules.test.ts`（新規）、`src/datasource/tauri.ts`、`src/datasource/update-check.ts`、`src/state/useUpdateCheck.ts`、`src/state/viewer-types.ts`、`src/state/useCopcViewer.ts`、
`src/state/useOpfsStorage.ts`、`src/state/usePointCloudTools.ts`、`src/app/point-cloud-tools.ts`、`src/app/point-cloud-tools.test.ts`、`src/app/raster-window.test.ts`、
`src/ui/dialogs/{AppearanceDialog,ColorModeDialog,ErrorDialog}.tsx`、`src/ui/settings/pages/BackgroundDialog.tsx`

### 確かめ方と結果

- **既存のコードで違反が出るか**: 新しいルールで `npm run lint` を通した結果は、違反 0 件（RF-1 の「危険」の項: 大量に落ちるなら先に一覧を出す、は発生しなかった）
- **AC-1 `madge --circular` が 0 件**: `npm run check:circular` → `✔ No circular dependency found!`（281 ファイル）。変更前は `npx madge@8` で 3 件だった。
  わざと循環（`src/app/zz-a.ts` ⇄ `zz-b.ts`）を作ると `✖ Found 1 circular dependency! 1) app/zz-a.ts > app/zz-b.ts` と出て検出される（確かめたあと削除した）
- **AC-2 わざと違反すると `npm run lint` が落ちる**（コミットしていない）。`src/app/zz-violation.ts` に `import { useState } from "react";`、`src/ui/shell/zz-violation.ts` に
  `import { open } from "@tauri-apps/plugin-dialog";` を置いた出力:

  ```
  c:\workspace\point-cloud-viewer\src\app\zz-violation.ts
    1:1  error  'react' import is restricted from being used by a pattern. src/renderer と src/app は React を import できない（規約3・5、ADR-0021）。  no-restricted-imports

  c:\workspace\point-cloud-viewer\src\ui\shell\zz-violation.ts
    1:1  error  '@tauri-apps/plugin-dialog' import is restricted from being used by a pattern. Tauri の npm パッケージを import してよいのは src/datasource/tauri.ts だけ（規約2、ADR-0001）。  no-restricted-imports

  ✖ 2 problems (2 errors, 0 warnings)
  ```

  同じ内容を `src/layer-rules.test.ts` が常に確かめる
- **AC-3 コメントに `@tauri-apps/api` と書いても落ちない**: `src/app/zz-comment.ts` に `// @tauri-apps/api is imported only by tauri.ts` だけを書いて lint → エラー 0（確かめたあと削除）。`layer-rules.test.ts` にも同じケースがある
- `npm ci`（lock との整合）: 作業ツリーとは別の空のフォルダに `package.json`・`package-lock.json` だけをコピーして `npm ci --ignore-scripts` を実行し、成功して `node_modules/.bin/madge` ができることを確かめた
- 副作用: `package-lock.json` の更新で、既存の依存のうち `@babel/helper-string-parser`・`@babel/parser`・`@babel/types`・`nanoid`・`postcss`・`source-map-js` の patch 版 6 つが動いた（R2 で、`git diff package-lock.json` の `version` の行から数え直した）（madge が連れてきた依存との兼ね合い）。差分は +1,530 行。
  アプリのコードの検証は typecheck・lint・vitest で行った。`vite build`・`tauri build` はこの変更では実行していない
- コマンド: `npm run typecheck` OK、`npm run lint` OK、`npm run check:circular` OK、`npx vitest run`（`C:\` から）89 files・928 tests passed

### 確かめていないこと

- **CI では未確認**（push しない決まり）。`ci.yml` の変更は、同じコマンド（`npm ci`・`npm run typecheck`・`npm run lint`・`npm run check:circular`・`npx vitest run`）を手元で実行して確かめた。
  Ubuntu の Node 22 での `npm ci` は未実行（手元は Windows）。`ci.yml` の YAML の構文は目で確かめたのみで、`actionlint` は使っていない
- `src/plugins/` の実物が無いので、プラグインのルールは `layer-rules.test.ts` の作り話のパスでのみ確かめた
- デスクトップでの更新通知の「開く」ボタン（`openReleasePage`）の動作は未確認（`openUrl` の呼び出しを関数ごと `tauri.ts` へ移しただけで、中身は同じ）

---

## RF-15 コミットした wasm が古いことを CI で検出する

### 先に測ったこと: `npm run build:wasm` は再現するか

手元（Windows、`rustc 1.99.0`、`wasm-bindgen 0.2.128` = `crates/pcv-wasm/Cargo.lock` の版）で、`npm run build:wasm` を実際に 3 通り行い、`sha256sum` で比べた。
`crates/pcv-wasm/target` を消してからの作り直し（59 クレートを再コンパイル）。

| 比べたもの | `pcv_wasm.js` | `pcv_wasm.d.ts` | `pcv_wasm_bg.wasm.d.ts` | `pcv_wasm_bg.wasm` |
|---|---|---|---|---|
| ビルド 1 と、`target` を消したビルド 2（同じフォルダ `C:\workspace\point-cloud-viewer`） | 一致 | 一致 | 一致 | **一致**（2,083,361 バイト） |
| ビルド 1 と、ソースを別のフォルダ（スクラッチの下）へ `git archive HEAD` で出して作ったビルド 3 | 一致 | 一致 | 一致 | **不一致**（2,086,228 バイト） |
| コミット済みと、今回のビルド 1 | 内容は一致（`git diff` に差分なし。作業ツリーが CRLF のため sha256 は違う） | 同左 | 同左 | **不一致**（コミット済み 2,084,497 → 2,083,361 バイト） |

- 結論: **同じフォルダ・同じツールなら `.wasm` も再現する。だが `.wasm` はフォルダと機械に依存する。** `pcv_wasm_bg.wasm` には Rust の panic の場所として絶対パスが埋まっている。
  コミット済みの `.wasm` から `grep -a -o` で取り出した例: `%USERPROFILE%\.cargo\registry\src\index.crates.io-…\copc-core-0.9.0\src\hierarchy.rs`、
  `C:\rust\point-cloud-viewer\.claude\worktrees\agent-ab616ea6433c4e893\crates\pcv-core\src\raster\preview.rs`（別の worktree のパス）。
  CI（ubuntu、`/home/runner/…`、`rustc` は常に最新の stable）の `.wasm` は、同じソースでも**必ず一致しない**
- JS 糊と型の 3 ファイルは、フォルダが違っても再現した（ビルド 1・2・3 で一致）。コミット済みとも内容が一致した（今の HEAD は古くない）
- 作業ツリーが CRLF なのは `core.autocrlf=true` のため。`git diff` は改行を正規化するので、比較は `git diff --exit-code` で行う（`sha256sum` では比べない）

### やったこと

- `package.json` に `check:wasm-glue`（`git diff --exit-code -- src/wasm/pcv-wasm/pcv_wasm.js src/wasm/pcv-wasm/pcv_wasm.d.ts src/wasm/pcv-wasm/pcv_wasm_bg.wasm.d.ts`）を足した
- `.github/workflows/pages.yml` の、wasm を作り直すステップの後（`npm ci` の前）に、`npm run check:wasm-glue` を実行するステップを足した。落ちたら
  「`npm run build:wasm` を実行してコミットする」というエラーを出す。`wasm-bindgen-cli` は既存のステップが `Cargo.lock` の版を入れるので、版のずれによる誤検出を避ける形はそのまま使っている（RF-15 の「危険」）
- `ADR-0012` に追記: 「`pages.yml` がデプロイのたびに食い違いを検出できる」という上の記述の訂正

### 採らなかった案

- **`.wasm` 本体も `git diff --exit-code` に入れる**: 上の表のとおり、フォルダと機械で必ず違うので、CI で毎回落ちる。`RUSTFLAGS=--remap-path-prefix` で絶対パスを固定する手もあるが、
  CI の `rustc` が最新の stable で手元と版が違うとコード生成が変わりうる（**未検証**）ので、版の固定まで要る。割に合わない。そのため JS 糊と型だけにした（REVIEW の案どおり）
- **ソースのハッシュを生成物の隣に置いて、CI で再計算して比べる**: 関数の本体だけの変更（G1-T15・T18 のような、文言の修正）も検出できる。だが、`pcv-core` やコメントを 1 文字直すたびに
  2 MB の `.wasm` を作り直してコミットすることになり、リポジトリが版ごとに太る（A-9: パックの約 52%）問題を悪化させる。やるなら「コミットをやめる」案（下）とセットで
- **今の検出の限界（未対応）**: `#[wasm_bindgen]` の関数・型の追加・変更・削除は検出できる（JS 糊か型が変わる）。**関数の本体だけを変えて作り直しを忘れた場合は検出できない**
- **将来（所有者の判断。やっていない）**: コミットをやめ、CI とローカルで作る案（ADR-0012 の見直し）。開発機に `wasm-bindgen-cli`（`Cargo.lock` と同じ版）が要る

### 触ったファイル

`package.json`、`.github/workflows/pages.yml`、`TaskSheets/ADR-0012-web-worker-sync-io.md`、`TaskSheets/RF-safety-net.md`

### 確かめ方と結果

- **AC-1（`#[wasm_bindgen]` の関数を 1 つ足して作り直さないと落ちる）**: `crates/pcv-wasm/src/lib.rs` の末尾に `#[wasm_bindgen] pub fn rf15_probe_added_function() -> u32 { 1 }` を足し、`npm run build:wasm` のあと
  `npm run check:wasm-glue` を実行 → 終了コード 1。`pcv_wasm.d.ts` に `export function rf15_probe_added_function(): number;`、`pcv_wasm.js` に同名の関数の差分が出た。
  確かめたあと、`git checkout -- crates/pcv-wasm/src/lib.rs src/wasm` で戻した（コミットしていない）
- 一致する場合: 何も足さずに `npm run build:wasm` のあと `npm run check:wasm-glue` → 終了コード 0（`.wasm` が違っても落ちない）
- `ci.yml`・`pages.yml` の変更は、**CI では未確認**（push しない決まり）。同じコマンドを手元（Windows）で実行して確かめた。ubuntu で `git diff` の対象に CRLF が混ざる心配は、
  Linux の checkout では改行の変換が無いので小さいが、**実機（CI）では未確認**
- 生成物（`src/wasm/pcv-wasm/`）はコミットしていない。HEAD のコミット済みの生成物と今のソースの JS 糊・型は一致していたため、作り直してコミットする必要が無かった
