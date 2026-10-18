// The status of "open / convert a file", as one discriminated union (R5).
// Pure: no React, no renderer. The state hooks write it with `setStatus`; the UI reads `status.kind` and uses the
// two helpers below, which are used in more than one place.
//
// Why a plain string-literal `kind` tag, not a TypeScript `enum` or an `as const` object of kinds:
// the tag is the same idea as a Rust `enum` with data or a Haskell ADT. `kind: "error"` is the only variant
// that carries data (`message`), so an error text cannot exist while the status is "ready".
// With `strict`, a `switch` over `kind` that misses a variant does not compile (TS2366: the function
// lacks an ending return), so the helpers have no `default:` and a new kind fails to build until each
// helper handles it. `tsconfig.json` has no `noImplicitReturns`; this check does not need it.

export type ViewerStatus =
  | { kind: "idle" }
  | { kind: "opening" }
  // Converting a raw LAS/LAZ (progress and cancel UI). A normal COPC open stays "opening" (it ends at once).
  // The file name and the progress are NOT in this variant, see `OpenFilesContext` in src/app/open-files.ts.
  | { kind: "converting" }
  | { kind: "ready" }
  | { kind: "error"; message: string };

/** Opening or converting a file: the open button and the layer list wait. */
export function isFileOpenBusy(status: ViewerStatus): boolean {
  switch (status.kind) {
    case "opening":
    case "converting":
      return true;
    case "idle":
    case "ready":
    case "error":
      return false;
  }
}

/** Label of the toolbar's open button. */
export function openButtonLabel(status: ViewerStatus): string {
  switch (status.kind) {
    case "opening":
      return "開いています…";
    case "converting":
      return "変換中…";
    case "idle":
    case "ready":
    case "error":
      return "開く";
  }
}
