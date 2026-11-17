// L2-A: 「選択中のレイヤーを Delete キーで消す」かどうかを決める小さな純粋関数。
// React に依存しないので Vitest だけで確かめられる(layer-delete-key.test.ts)。
import { isFormControl } from "../../app/typing-target";

/** キー入力の判定に必要な部分だけ。KeyboardEvent の値をそのまま渡せる。 */
export interface DeleteKeyInput {
  key: string;
  /** 押された時点でフォーカスがある要素。 */
  target: { tagName?: string; isContentEditable?: boolean; type?: string } | null;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}

/**
 * Delete キーでレイヤーを消してよいか。
 * - 選択中のレイヤーがあること
 * - 修飾キー(Ctrl/Meta/Alt)なし
 * - フォームの部品（INPUT は type を問わず・TEXTAREA・SELECT・contenteditable）にフォーカスがない
 * チェックボックス・ラジオ・スライダーにフォーカスがあるときも消さない（安全側。Delete は確認なしで即座に消し、戻せないため。
 * 視点のキーが使う `isTypingTarget` とは逆の向きで、`isFormControl` を使う。src/app/typing-target.ts 参照）。
 */
export function shouldDeleteLayerOnKey(input: DeleteKeyInput, hasSelectedLayer: boolean): boolean {
  if (!hasSelectedLayer) return false;
  if (input.key !== "Delete") return false;
  if (input.ctrlKey || input.metaKey || input.altKey) return false;
  return !isFormControl(input.target);
}
