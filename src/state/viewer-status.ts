// The status of "open / convert a file", as one discriminated union (R5).
// Pure: no React, no renderer. The state hooks write it with `setStatus`, the UI reads it through the
// helpers below.
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
  // The file name and the progress are NOT in this variant, see `useConversionSession.ts`.
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

/** The error text to show in the panel and the error dialog, or null when the status is not an error. */
export function statusErrorMessage(status: ViewerStatus): string | null {
  switch (status.kind) {
    case "error":
      return status.message;
    case "idle":
    case "opening":
    case "converting":
    case "ready":
      return null;
  }
}

/**
 * True when the last open is running or finished well; false when nothing was opened yet, or it failed or
 * was cancelled (a failure and a cancel both leave "error" / "idle"). The conversion dialog shows the
 * result of a finished conversion only while this is true.
 */
export function isOpenRunningOrDone(status: ViewerStatus): boolean {
  switch (status.kind) {
    case "opening":
    case "converting":
    case "ready":
      return true;
    case "idle":
    case "error":
      return false;
  }
}
