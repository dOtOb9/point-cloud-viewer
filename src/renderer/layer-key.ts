export function layerKeyPrefix(serial: number): string {
  return `${serial}:`;
}

export function layerNodeKey(serial: number, nodeKey: string): string {
  return layerKeyPrefix(serial) + nodeKey;
}

export function parseLayerNodeKey(key: string): { serial: number; nodeKey: string } | null {
  const i = key.indexOf(":");
  if (i <= 0) return null;
  const serial = Number(key.slice(0, i));
  if (!Number.isInteger(serial)) return null;
  return { serial, nodeKey: key.slice(i + 1) };
}
