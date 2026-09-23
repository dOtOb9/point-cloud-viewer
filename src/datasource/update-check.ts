// 自前の更新通知（デスクトップ・Android共通。M3-2/M3-4）。
//
// 当初はデスクトップに tauri-plugin-updater（署名付き自動適用）を使う設計だった
// (ADR-0004)が、所有者が当面署名鍵を作らない方針に変えたため、デスクトップも
// Androidと同じ「GitHub Releasesの最新版をfetchで確認し、新しければ知らせ、
// 同意したときだけリリースページを開く」方式に統一した(同じことを2回書かない
// ため、プラットフォーム分岐はここに置かず、呼び出し側は関数を呼ぶだけでよい)。
// 詳しい経緯は TaskSheets/ADR-0004-distribution-and-update.md 追記4を参照。
//
// 適用（インストール）は常に利用者の手作業。Windowsは無署名インストーラの
// ダウンロード、AndroidはAPKのサイドロードになる。
//
// 規約2の拡張(TaskSheets/M3-release-and-update.md M3-2): @tauri-apps/plugin-opener の
// importもこのファイルに閉じ込める（`src/datasource/tauri.ts`と同じ扱い）。

import { openUrl } from "@tauri-apps/plugin-opener";

const REPO = "dOtOb9/point-cloud-viewer";

export interface LatestRelease {
  /** GitHubのtag_name。例: "v0.1.0"。 */
  tagName: string;
  /** リリースページのURL。「開く」ボタンでここへ遷移する。 */
  htmlUrl: string;
  /** リリースノート本文。長い場合はUI側で省略する。 */
  body: string;
}

/**
 * GitHub Releases APIで最新リリースを取得する。
 *
 * オフライン・レート制限（未認証60req/h）・その他のHTTPエラーはすべてnullを返す
 * （起動を止めないため。呼び出し側はnullを「更新なし」と同様に扱う。M3-4の
 * 受け入れ条件: レート制限に当たっても起動を妨げない）。
 */
export async function fetchLatestRelease(): Promise<LatestRelease | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) return null;

    const json = (await res.json()) as { tag_name?: string; html_url?: string; body?: string };
    if (!json.tag_name || !json.html_url) return null;

    return { tagName: json.tag_name, htmlUrl: json.html_url, body: json.body ?? "" };
  } catch {
    return null;
  }
}

/**
 * リリースページをブラウザで開く。`@tauri-apps/plugin-opener`はデスクトップ・
 * Androidの両方に対応しているため、プラットフォーム分岐はここに要らない
 * （「適用手段だけを差し替える」M3-4の設計要件をこの1関数で満たす）。
 *
 * インストール自体は利用者の手作業（ADR-0004）。Windowsは無署名インストーラなので
 * SmartScreenの警告が出る場合がある。Androidはサイドロードになる。
 */
export async function openReleasePage(url: string): Promise<void> {
  await openUrl(url);
}
