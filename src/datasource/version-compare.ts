function numericPartsWithoutVPrefixOrPrerelease(version: string): number[] {
  const stripped = version.trim().replace(/^v/i, "");
  const core = stripped.split("-")[0];
  return core.split(".").map((part) => {
    const n = Number.parseInt(part, 10);
    return Number.isNaN(n) ? 0 : n;
  });
}

export function isNewerVersion(current: string, latest: string): boolean {
  const a = numericPartsWithoutVPrefixOrPrerelease(current);
  const b = numericPartsWithoutVPrefixOrPrerelease(latest);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (bv > av) return true;
    if (bv < av) return false;
  }
  return false;
}
