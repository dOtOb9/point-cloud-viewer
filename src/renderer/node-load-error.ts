export function formatNodeLoadErrorMessage(key: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `ノード${key}の読み出しに失敗した: ${detail}`;
}
