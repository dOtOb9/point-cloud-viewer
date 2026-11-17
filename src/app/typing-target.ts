// One answer to "is the user typing in this element?", shared by every window-level key handler
// (view shortcuts, measurement / selection tool keys, deleting a layer with Delete). Before TP-1 four copies
// existed and they did not agree (only some looked at SELECT).

/** The part of an element this check reads. A DOM element or a plain object in a test. */
export interface TypingTargetLike {
  tagName?: string;
  isContentEditable?: boolean;
  /** For an input element: its type ("text", "radio", ...). */
  type?: string;
}

/** Input types that take no typed text: pressing a key on them is not "typing" (a radio button keeps focus after a click). */
const NON_TEXT_INPUT_TYPES = new Set(["radio", "checkbox", "button", "submit", "reset", "range", "color", "file", "image"]);

/**
 * True for an element that takes typed keys: a text-like input, textarea, select, or a contenteditable element.
 * An input of a non-text type (radio, checkbox, button, range, ...) is not: the view dialog stays open and its radio
 * button keeps focus after a click, and the view keys must still work there.
 */
export function isTypingTarget(target: unknown): boolean {
  if (typeof target !== "object" || target === null) return false;
  const el = target as TypingTargetLike;
  if (el.isContentEditable === true) return true;
  const tag = (el.tagName ?? "").toUpperCase();
  if (tag === "INPUT") return !NON_TEXT_INPUT_TYPES.has((el.type ?? "").toLowerCase());
  return tag === "TEXTAREA" || tag === "SELECT";
}
