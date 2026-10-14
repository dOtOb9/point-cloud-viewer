// L2-A: 「選択中のレイヤーを Delete キーで消す」かどうかを決める小さな純粋関数。
// React に依存しないので Vitest だけで確かめられる(layer-delete-key.test.ts)。

/** キー入力の判定に必要な部分だけ。KeyboardEvent の値をそのまま渡せる。 */
export interface DeleteKeyInput {
  key: string;
  /** 押された時点でフォーカスがある要素。 */
  target: { tagName?: string; isContentEditable?: boolean } | null;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}

/** 文字を打つ要素にフォーカスがあるときは、Delete は文字の削除に使われるのでレイヤーを消さない。 */
function isTypingTarget(target: DeleteKeyInput["target"]): boolean {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName?.toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/**
 * Delete キーでレイヤーを消してよいか。
 * - 選択中のレイヤーがあること
 * - 修飾キー(Ctrl/Meta/Alt)なし
 * - 入力欄にフォーカスがない
 * チェックボックス(INPUT)にフォーカスがあるときも消さない(入力欄と同じ扱いで、安全側に倒す)。
 */
export function shouldDeleteLayerOnKey(input: DeleteKeyInput, hasSelectedLayer: boolean): boolean {
  if (!hasSelectedLayer) return false;
  if (input.key !== "Delete") return false;
  if (input.ctrlKey || input.metaKey || input.altKey) return false;
  return !isTypingTarget(input.target);
}
