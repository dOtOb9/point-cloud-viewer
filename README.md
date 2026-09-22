# point-cloud-viewer

点群解析ビューア。設計判断は `TaskSheets/ADR-*.md`、全体像は
`TaskSheets/ARCHITECTURE.md` を参照。

## 開発

```bash
npm install
npm run tauri dev     # ウィンドウを開く
cargo build --workspace
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
