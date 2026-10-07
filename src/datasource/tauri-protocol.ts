// TauriSource(`tauri.ts`)が`convertFileSrc`に渡す前の文字列を組み立てる純粋関数。
// `convertFileSrc`自体（TauriのAPIパッケージが提供する関数。実体はTauriの
// webview初期化スクリプトが注入する`window.__TAURI_INTERNALS__.convertFileSrc`）は
// テスト環境（vitest）には存在しないため、ここを切り出すことで「送る文字列の形が
// 正しいか」をTauriを起動せずにテストできる（`web-protocol.ts`の
// `buildReadNodeRequest`等と同じ考え方）。
//
// 緊急修正の経緯（v0.1.3でノード読み出しが全滅した不具合）:
// `convertFileSrc(filePath, protocol)`は`filePath`全体を1回の`encodeURIComponent`で
// エンコードしてから1セグメントとしてURLに埋め込む（`tauri`クレートの
// `scripts/core.js`参照）。このため、ここで組み込む区切り文字（`/`）も
// `%2F`になって届く。v0.1.3では区切りに`:`を使っていたが、Rust側
// （`src-tauri/src/lib.rs`の`parse_pcv_path`）がパーセントデコードせずに解析して
// いたため、常に失敗していた。Rust側は今回デコードしてから解析するように直した
// （`parse_pcv_path`参照）ため、ここでの区切り文字の選択自体は動作に影響しないが、
// ベンチ用の`/<size>`形式と見た目で区別しやすいよう`/`に揃えた。

/**
 * ノード読み出し（`pcv://`）のパス部分（`convertFileSrc`に渡す文字列。まだ
 * エンコードされていない）を組み立てる。`generation`は`open()`が返した世代番号、
 * `key`はoctreeのノードキー（`"<level>-<x>-<y>-<z>"`）。
 */
export function buildNodeRequestPath(generation: number, key: string): string {
  return `${generation}/${key}`;
}
