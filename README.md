# point-cloud-viewer

点群解析ビューア。設計判断は `TaskSheets/ADR-*.md`、全体像は
`TaskSheets/ARCHITECTURE.md` を参照。

## 開発

```bash
npm install
npm run tauri dev     # ウィンドウを開く
cargo build --workspace
```

## Web版

[GitHub Pages](https://dOtOb9.github.io/point-cloud-viewer/) で公開しているデスクトップ版
（Tauri）とほぼ同じ機能のブラウザ版。COPCファイルはドラッグ&ドロップ/選択するか、
CORSとHTTP Rangeに対応したURLを指定して開く（設計は
[ADR-0012](TaskSheets/ADR-0012-web-worker-sync-io.md) 参照）。

Rust側を変更した場合、Web版が使うwasmバインディング(`src/wasm/pcv-wasm/`。
コミット済み)を再生成する必要がある。

```bash
npm run build:wasm
```

## ライセンス

本プロジェクトは以下のいずれかを、利用者の選択により適用できます。

- Apache License, Version 2.0 ([LICENSE-APACHE](LICENSE-APACHE))
- MIT License ([LICENSE-MIT](LICENSE-MIT))

### 貢献について

特に別段の意思表示がない限り、あなたが本プロジェクトに意図的に提出した貢献は、
Apache-2.0 の定義に従い、追加の条件なく上記のデュアルライセンスで提供されるものとします。

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
