// ファイル切り替え時の不具合の修正（TaskSheets/M4-import-and-conversion.md参照）。
//
// ファイルを切り替えると、切り替え前に送った`readNode`リクエストが切り替え後に
// 届くことがある（Tauriの`pcv://`はspawn_blockingで非同期に処理される、Webの
// Workerはメインスレッドが切り替え前のリクエストを送り続けている間にopenの
// メッセージを先に処理し終える、など。経緯の詳細は各DataSource実装
// （`tauri.ts`/`web.ts`/`copc.worker.ts`）とRust側（`src-tauri/src/copc_state.rs`の
// `OpenedFile`のドキュメントコメント）を参照）。
//
// `NodeLoader`（`src/renderer/node-loader.ts`）自身も「reset()より前に始まった
// リクエストの結果は捨てる」という世代カウンタを持っているが、「ファイルを
// 切り替えるinvoke/postMessageの往復」と「古いリクエストの応答」のどちらが先に
// JS側に届くかという競合には、フロント側だけでは対処しきれない狭い窓が残る。
//
// 裏側（Tauri/Web）が「このリクエストは今開いているファイルの世代と違う」と
// 検出できた場合、この専用のエラー型でそれを伝える。`NodeLoader`はこれを
// 他の読み出し失敗と区別し、**世代カウンタの状態に関わらず無条件に**
// エラーバナーへ出さず黙って捨てる（裏側の判定のほうが「今何が開いているか」を
// 正しく知っているため、常に信用してよい）。
export class StaleNodeRequestError extends Error {
  constructor(public readonly key: string) {
    super(`node ${key} belongs to a stale generation (the file was switched)`);
    this.name = "StaleNodeRequestError";
  }
}
