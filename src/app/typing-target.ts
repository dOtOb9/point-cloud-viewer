// One answer to "is the user typing in this element?", shared by every window-level key handler
// (view shortcuts, measurement / selection tool keys, deleting a layer with Delete). Before TP-1 four copies
// existed and they did not agree (only some looked at SELECT).

/** The part of an element this check reads. A DOM element or a plain object in a test. */
export interface TypingTargetLike {
  tagName?: string;
  isContentEditable?: boolean;
}

/** True for an element that takes typed keys: input, textarea, select, or a contenteditable element. */
export function isTypingTarget(target: unknown): boolean {
  if (typeof target !== "object" || target === null) return false;
  const el = target as TypingTargetLike;
  if (el.isContentEditable === true) return true;
  const tag = (el.tagName ?? "").toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}
