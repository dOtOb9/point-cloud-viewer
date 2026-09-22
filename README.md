# point-cloud-viewer

点群解析ビューア。設計判断は `TaskSheets/ADR-*.md`、全体像は
`TaskSheets/ARCHITECTURE.md` を参照。

## 開発

```bash
npm install
npm run tauri dev     # ウィンドウを開く
cargo build --workspace
```

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
