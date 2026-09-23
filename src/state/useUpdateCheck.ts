import { useCallback, useEffect, useState } from "react";
import { fetchLatestRelease, openReleasePage, type LatestRelease } from "../datasource/update-check";
import { isNewerVersion } from "../datasource/version-compare";
import { getAppVersion } from "../datasource/tauri";

const STORAGE_KEY = "pcv-update-check-enabled";

function readStoredEnabled(): boolean {
  try {
    // 既定はオン("チェックは自動"というADR-0004の原則を引き継ぐ)。
    // 明示的に"false"が保存されているときだけオフにする。
    return localStorage.getItem(STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

export type UpdateStatus = "disabled" | "checking" | "none" | "available" | "dismissed";

export interface UpdateCheckState {
  status: UpdateStatus;
  latest: LatestRelease | null;
  /** 比較に使った、今動いているアプリのバージョン。取得できるまではnull。 */
  currentVersion: string | null;
  /** 起動時チェックそのものの有効/無効（設定画面から切り替える）。 */
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
  /** 「後で」。ダイアログを閉じるだけで、次回起動時にはまた確認する。 */
  dismiss: () => void;
  /** 「リリースページを開く」。適用（ダウンロード・インストール）は利用者の手作業（ADR-0004）。 */
  openRelease: () => Promise<void>;
}

/**
 * M3-2 / M3-4: 起動時の更新通知。デスクトップ・Androidで完全に同じロジックを使う
 * (ADR-0004追記4: 当面署名鍵を作らないため、デスクトップもAndroidと同じ
 * 「GitHub Releasesの最新版をfetchで確認 → 同意したらリリースページを開く」方式に
 * 統一した)。プラットフォームによる違いは`openReleasePage`内の
 * `@tauri-apps/plugin-opener`が吸収するので、ここにはプラットフォーム分岐が無い。
 *
 * 「チェックは自動・適用は手動」の原則(ADR-0004)を守り、開発中(`tauri dev`)は
 * チェックしない。チェック自体も設定でオフにできる(オプトイン)。
 *
 * `checkingEnabled`(=チェックしてよいか)は`enabled`とDEVフラグから毎回導出する
 * 値であり、それ自体をstateとして持たない。「オフ」の表示はここから直接出すので、
 * 効果(useEffect)の同期処理としてsetStateを呼ぶ必要がない
 * (react-hooks/set-state-in-effect: 効果の本体で直接setStateを呼ぶのを避け、
 * 外部とのやり取り(fetch)が終わった後のコールバックの中でだけ呼ぶ)。
 */
export function useUpdateCheck(): UpdateCheckState {
  const [enabled, setEnabledState] = useState(() => readStoredEnabled());
  const [phase, setPhase] = useState<"checking" | "done">("checking");
  const [dismissed, setDismissed] = useState(false);
  const [latest, setLatest] = useState<LatestRelease | null>(null);
  const [currentVersion, setCurrentVersion] = useState<string | null>(null);

  const checkingEnabled = !import.meta.env.DEV && enabled;

  useEffect(() => {
    if (!checkingEnabled) return;

    let cancelled = false;

    (async () => {
      setPhase("checking");
      setDismissed(false);

      const [version, release] = await Promise.all([getAppVersion(), fetchLatestRelease()]);
      if (cancelled) return;

      setCurrentVersion(version);
      setLatest(release && isNewerVersion(version, release.tagName) ? release : null);
      setPhase("done");
    })().catch(() => {
      // オフライン等で失敗しても起動は止めない(M3-4の受け入れ条件)。「更新なし」と同じ扱いにする。
      if (!cancelled) setPhase("done");
    });

    return () => {
      cancelled = true;
    };
  }, [checkingEnabled]);

  const status: UpdateStatus = !checkingEnabled
    ? "disabled"
    : phase === "checking"
      ? "checking"
      : dismissed
        ? "dismissed"
        : latest
          ? "available"
          : "none";

  const setEnabled = useCallback((v: boolean) => {
    setEnabledState(v);
    try {
      localStorage.setItem(STORAGE_KEY, String(v));
    } catch {
      // 保存できなくても動作に支障はない(次回起動時は既定のオンに戻るだけ)。
    }
  }, []);

  const dismiss = useCallback(() => {
    setDismissed(true);
  }, []);

  const openRelease = useCallback(async () => {
    if (latest) await openReleasePage(latest.htmlUrl);
  }, [latest]);

  return { status, latest, currentVersion, enabled, setEnabled, dismiss, openRelease };
}
