export interface TypingTargetLike {
  tagName?: string;
  isContentEditable?: boolean;
  type?: string;
}

const NON_TEXT_INPUT_TYPES = new Set(["radio", "checkbox", "button", "submit", "reset", "range", "color", "file", "image"]);

export function isFormControl(target: unknown): boolean {
  if (typeof target !== "object" || target === null) return false;
  const el = target as TypingTargetLike;
  if (el.isContentEditable === true) return true;
  const tag = (el.tagName ?? "").toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

export function isTypingTarget(target: unknown): boolean {
  if (typeof target !== "object" || target === null) return false;
  const el = target as TypingTargetLike;
  if (el.isContentEditable === true) return true;
  const tag = (el.tagName ?? "").toUpperCase();
  if (tag === "INPUT") return !NON_TEXT_INPUT_TYPES.has((el.type ?? "").toLowerCase());
  return tag === "TEXTAREA" || tag === "SELECT";
}
