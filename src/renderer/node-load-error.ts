// NodeLoaderがノード読み出しの失敗を報告したとき、GpuErrorLog（バナー）へ渡す
// 1行のメッセージを組み立てる、GPUにもReactにも依存しない純粋関数。
//
// なぜ要るか（TaskSheets/ADR-0013-crash-visibility.md）: 所有者の実機で
// 「複数ノードを扱うと落ちる」という報告があった。原因がRust側のpanicだった
// 場合、Rust側は`catch_unwind`で捕まえてHTTP 500とpanicメッセージ・ノードキーを
// 返すようになった（`src-tauri/src/copc_state.rs`のReadNodeError::Panicked）。
// このメッセージが「そのまま」バナーに出ないと、せっかくRust側が残した情報が
// 画面まで届かない。この関数はその「そのまま」を保証する境界。
export function formatNodeLoadErrorMessage(key: string, error: unknown): string {
  // 受け入れ条件「エラーバナーに本文そのままで出る」を満たすため、
  // error.message（またはString(error)）は要約・切り詰めを一切行わない。
  // ノードキーを前に付けるのは「どのノードで起きたか」という追加情報であり、
  // 本文そのものの書き換えではない。
  const detail = error instanceof Error ? error.message : String(error);
  return `ノード${key}の読み出しに失敗した: ${detail}`;
}
