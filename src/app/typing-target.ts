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
 * Which function to use (the two answer in opposite directions on purpose):
 *  - `isTypingTarget`: for HARMLESS keys (the view keys F, 1 to 7). A radio button or a slider keeps focus after a
 *    click and takes no text, so the keys must still work there.
 *  - `isFormControl`: for keys that DESTROY or DECIDE something (Delete removes the selected layer at once; Enter / Esc
 *    finish or cancel a measurement and Enter also clicks a focused button). Any form control keeps them: the safe side.
 */

/**
 * True for any form control, whatever its type: input (checkbox, radio, range, ... too), textarea, select, or a
 * contenteditable element. Use it for keys that cannot be undone or that a focused control already uses (see above).
 */
export function isFormControl(target: unknown): boolean {
  if (typeof target !== "object" || target === null) return false;
  const el = target as TypingTargetLike;
  if (el.isContentEditable === true) return true;
  const tag = (el.tagName ?? "").toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

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
