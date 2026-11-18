import { isFormControl } from "../../app/typing-target";

export interface DeleteKeyInput {
  key: string;
  target: { tagName?: string; isContentEditable?: boolean; type?: string } | null;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}

export function shouldDeleteLayerOnKey(input: DeleteKeyInput, hasSelectedLayer: boolean): boolean {
  if (!hasSelectedLayer) return false;
  if (input.key !== "Delete") return false;
  if (input.ctrlKey || input.metaKey || input.altKey) return false;
  return !isFormControl(input.target);
}
