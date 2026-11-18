export type ViewerStatus =
  | { kind: "idle" }
  | { kind: "opening" }
  | { kind: "converting" }
  | { kind: "ready" }
  | { kind: "error"; message: string };

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
