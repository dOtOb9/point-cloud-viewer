# 配布

このアプリには3つの GitHub Actions ワークフローがあります。

| ファイル | いつ走るか | 目的 |
|---|---|---|
| [`ci.yml`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/.github/workflows/ci.yml) | 毎 push・PR | 壊れていないことを速く確認する |
| [`release.yml`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/.github/workflows/release.yml) | タグ push（`v*`）、手動実行 | インストーラ・APK を作って配る |
| [`pages.yml`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/.github/workflows/pages.yml) | 毎 push（main）・PR | Web 版と、この本を GitHub Pages へ公開する |

目的も所要時間も違うため、意図的に別ファイルに分けられています。

## `ci.yml`

`frontend`（typecheck/lint/test）・`invariants`（[規約1・2](./conventions.md)の機械検査）・
`rust`（fmt/clippy/test）・`build`（`tauri build --no-bundle`、インストーラ生成は含めない）
の4ジョブです。`build` は `frontend` の完了だけを待ち、`rust`（5分超）とは
並行に走らせることで CI 全体の時間を縮めています。

## `release.yml`: インストーラと APK

タグ（`v*`）を push すると、`check-version`（タグと `tauri.conf.json` の
バージョン一致を検査）→ `windows`（MSI/NSIS をビルドし Release に添付）→
`android`（debug 署名の APK をビルドし Release に添付）の順で走ります。

**署名はしていません。** 当初は Tauri の updater プラグインによる署名付き自動
更新を計画していましたが、所有者が「当面、署名鍵を作らない」と判断したため、
更新マニフェスト（`latest.json`）の生成自体をやめています。デスクトップも
Android と同じ「GitHub API で最新版を確認し、同意したらリリースページを開く」
という自前の通知方式に統一されました（[ADR-0004 の追記4](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0004-distribution-and-update.md#追記42026-09-23-当面は署名鍵を作らない)）。

この決定の帰結:

- Windows の MSI/NSIS は無署名なので、SmartScreen が「発行元不明」の警告を出します
  （リリース本文に明記されています）
- Android は debug 署名です。CI ランナーは毎回まっさらな環境のため、debug 鍵を
  `actions/cache` でキャッシュして使い回しています。**キャッシュが7日使われないと
  鍵が入れ替わる可能性があり**、その場合は利用者がいったんアンインストールしてから
  新しい APK を入れ直す必要があります
- デスクトップの更新適用は手作業です（チェックは自動、ダウンロード・インストールは
  利用者が行います）

`workflow_dispatch`（手動実行）では Release を作らず、ビルドの成否だけを確認でき、
Android の APK は `actions/upload-artifact` でワークフロー実行の成果物として
残ります。タグを打たずに試験用 APK を取れる経路です（[ADR-0013](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0013-crash-visibility.md)）。

### このワークフローが実際に踏んだ不具合

`release.yml` は一度も「書いたら最初から動いた」わけではありません。実際に
タグを打って3つの不具合が見つかり、直されています。

1. **`GITHUB_TOKEN` に `contents: write` 権限が無く、Release の作成自体が
   403 で失敗した。** `permissions: { contents: write }` を追加して解決
2. **インストーラが1つも Release に添付されていなかった。** ルートの
   `Cargo.toml` が `src-tauri` を含むワークスペースのため、ビルド成果物は
   `src-tauri/target/` ではなく**リポジトリ直下の `target/`** に出ます。誤った
   パスを指定していたため何もマッチせず、しかも `softprops/action-gh-release`
   は既定では「添付ファイルが0件でも失敗しない」ため、**インストーラ抜きの
   Release がそのまま「成功」として公開されていました。** `fail_on_unmatched_files: true`
   を追加し、ビルド成果物を毎回ログに残すステップも足して解決しました
3. **Android の APK が 493MB の `--debug` ビルドだった。** `--debug` は Gradle の
   ビルドタイプだけでなく Rust 側も最適化なしにしてしまいます。`--debug` を
   外して release 最適化ビルドにし、対象 ABI を実機（arm64）だけに絞り、
   署名は `zipalign`→`apksigner` で後付けする形に直し、**493MB → 7.6MB** になりました

これらはいずれも「CI が緑でも壊れている」の具体例です。[落とし穴と教訓](./pitfalls.md)で
改めて取り上げます。

## `pages.yml`: Web 版とこの本の公開

`main` への push ごとに、Web 版（`crates/pcv-wasm` を実際にビルドし直して
`npm run build`）と、この本（`mdbook build`）をビルドし、同じ GitHub Pages の
成果物にまとめて公開します。

```
build ジョブ
  1. crates/pcv-wasm を release ビルド → wasm-bindgen で src/wasm/pcv-wasm/ を生成
  2. npm run build (GITHUB_PAGES_BUILD=true, dist/ に出力)
  3. mdbook build docs/book (docs/book/book/ に出力)
  4. docs/book/book/ の中身を dist/book/ にコピー
  5. actions/upload-pages-artifact で dist/ 全体をアップロード
deploy ジョブ
  actions/deploy-pages でそのまま公開
```

アプリは引き続き `https://dotob9.github.io/point-cloud-viewer/` で動き、
この本は `https://dotob9.github.io/point-cloud-viewer/book/` で読めます。
mdBook は [`peaceiris/actions-mdbook`](https://github.com/peaceiris/actions-mdbook) で導入しています（バイナリの手動取得ではなく、
この Action を使う形にしました）。

Web 版は `crates/pcv-wasm` が `wasm32-unknown-unknown` でビルドできること
（[規約1](./conventions.md)）に依存しています。規約1が壊れれば、このワークフロー自体が
失敗し、Pages のデプロイが止まります。wasm-bindgen CLI のバージョンは
`Cargo.lock` から実際のバージョンを読んで決めており、ハードコードしていません
（バージョンがずれると `wasm-bindgen` は動かないため）。

## まず読むファイル

- [`.github/workflows/ci.yml`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/.github/workflows/ci.yml)
- [`.github/workflows/pages.yml`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/.github/workflows/pages.yml)
- [`TaskSheets/ADR-0004-distribution-and-update.md`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0004-distribution-and-update.md) — 署名鍵を作らない決定とその帰結
