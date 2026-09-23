// バージョン文字列の比較だけを行う純粋関数。DOM/fetchに依存しないのでvitestで
// 直接検証できる(mat4/up-axis等と同じ方針)。
//
// GitHub ReleasesのtagName(例: "v0.1.0")とTauriアプリのversion(例: "0.1.0")は
// 先頭の"v"の有無が食い違うので、比較の前にここで吸収する。

function toNumbers(version: string): number[] {
  const stripped = version.trim().replace(/^v/i, "");
  // プレリリース識別子("1.2.3-beta.1"の"-beta.1"部分)は比較に含めない。
  const core = stripped.split("-")[0];
  return core.split(".").map((part) => {
    const n = Number.parseInt(part, 10);
    return Number.isNaN(n) ? 0 : n;
  });
}

/** latestがcurrentより新しいバージョンならtrueを返す(同じ・古い場合はfalse)。 */
export function isNewerVersion(current: string, latest: string): boolean {
  const a = toNumbers(current);
  const b = toNumbers(latest);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (bv > av) return true;
    if (bv < av) return false;
  }
  return false;
}
