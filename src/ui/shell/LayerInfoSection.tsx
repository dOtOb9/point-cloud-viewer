import { useState } from "react";
import type { BackgroundMode, CopcViewerState } from "../../state/useCopcViewer";
import { formatCrsLong } from "./crs-format";

// 変換の進捗・キャンセルは中央の変換ダイアログ(ConversionDialog.tsx)へ移した(ADR-0017)。
function fmt3(v: readonly [number, number, number]): string {
  return `[${v.map((x) => x.toFixed(2)).join(", ")}]`;
}

const BACKGROUND_MODE_LABELS: Record<BackgroundMode, string> = {
  "solid-dark": "単色(暗)",
  "solid-light": "単色(明)",
  sky: "空",
};

/**
 * M4-12(`TaskSheets/M4-import-and-conversion.md`): 変換完了後、段階ごとの
 * 所要時間を所有者がそのまま報告できるようにする内訳パネル(以前
 * `LayerPanel.tsx`にあったもの。ADR-0017でこちらへ移動。コピー機能含めて
 * そのまま)。
 */
function ConversionBreakdownPanel({ text, onCopy }: { text: string; onCopy: () => Promise<boolean> }) {
  const [copied, setCopied] = useState(false);

  return (
    // E2E(`e2e/web-conversion.spec.ts`)がこのdata-testidで「変換の内訳」の
    // 表示を待つ。削除・リネームするときはそちらも直すこと(`CLAUDE.md`参照)。
    <div data-testid="conversion-breakdown" className="flex flex-col gap-1 rounded border border-black/10 p-2 text-xs dark:border-white/10">
      <div className="flex items-center justify-between">
        <span className="opacity-70">変換の内訳</span>
        <button
          type="button"
          onClick={() => {
            void (async () => {
              const ok = await onCopy();
              if (ok) {
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }
            })();
          }}
          className="rounded bg-tertiary px-2 py-1 text-xs text-on-tertiary hover:opacity-90"
        >
          {copied ? "コピーしました" : "内訳をコピー"}
        </button>
      </div>
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap font-mono text-[11px] opacity-80">{text}</pre>
    </div>
  );
}

/**
 * ADR-0017 (UIシェル再構築): 左パネルの「レイヤー情報」節。
 *
 * タスクシートの指定: ファイル名・点数・CRS・バウンディングボックス・
 * 変換の内訳(コピー機能ごと移動)。以前は`LayerPanel.tsx`(開く操作・点予算・
 * 背景・グリッド・変換進捗・エラー・ダウンロード・内訳)と`InfoPanel.tsx`
 * (cloudInfoの先頭部分)に分かれていた表示をここへまとめた。
 *
 * CRSは`CloudInfo.crs`(Rust側`pcv_core::crs::CrsInfo`)を`formatCrsLong`で
 * 文字列にして出す(配線の経緯はADR-0017のCRSの節とADR-0008の追記を参照)。
 */
export function LayerInfoSection({ viewer }: { viewer: CopcViewerState }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5 text-xs">
        <p>
          <span className="opacity-60">ファイル名: </span>
          {viewer.openedFileName ?? "（未選択）"}
        </p>
        <p>
          <span className="opacity-60">点数: </span>
          {viewer.cloudInfo ? viewer.cloudInfo.pointCount.toLocaleString() : "―"}
        </p>
        <p>
          <span className="opacity-60">CRS: </span>
          {viewer.cloudInfo ? formatCrsLong(viewer.cloudInfo.crs) : "―"}
        </p>
        <p>
          <span className="opacity-60">バウンディングボックス: </span>
          {viewer.cloudInfo ? (
            <span className="font-mono">
              min={fmt3(viewer.cloudInfo.min)} / max={fmt3(viewer.cloudInfo.max)}
            </span>
          ) : (
            "―"
          )}
        </p>
      </div>

      {viewer.error && (
        // E2E(`e2e/web-conversion.spec.ts`)がこのdata-testidでエラー表示の
        // 有無を確かめる。削除・リネームするときはそちらも直すこと(CLAUDE.md参照)。
        <p data-testid="viewer-error" className="text-xs text-error">
          {viewer.error}
        </p>
      )}

      {/* M4-6b: Web版のダウンロード導線。 */}
      {viewer.isBrowser && viewer.downloadReady && (
        <div className="flex items-center justify-between gap-2 rounded border border-black/10 p-2 text-xs dark:border-white/10">
          <span className="opacity-70">変換したCOPCを保存できます</span>
          <a
            href={viewer.downloadReady.url}
            download={viewer.downloadReady.fileName}
            // E2E(`e2e/web-conversion.spec.ts`)がこのdata-testidでダウンロード
            // リンクの表示を確かめる。削除・リネームするときはそちらも直すこと。
            data-testid="download-link"
            className="rounded bg-primary px-2 py-1 text-xs text-on-primary hover:opacity-90"
          >
            ダウンロード
          </a>
        </div>
      )}

      {/* M4-12: 変換完了後の内訳。 */}
      {viewer.conversionBreakdownText && (
        <ConversionBreakdownPanel text={viewer.conversionBreakdownText} onCopy={viewer.copyConversionBreakdownText} />
      )}

      {/* 点予算・背景・グリッドはタスクシートが「表示」グループへの移動を
          明示した5項目(着色・EDL・点のサイズ・中央優先度の強さと下限)には
          含まれていないため、ここ(レイヤー情報)に残した(ADR-0017の対応表参照)。 */}
      <div className="flex flex-col gap-1 border-t border-black/10 pt-2 text-xs dark:border-white/10">
        <div className="flex items-center justify-between">
          <label className="opacity-70">点予算{viewer.autoPointBudgetEnabled ? "（自動調整中）" : ""}</label>
        </div>
        <input
          type="number"
          min={1000}
          step={100_000}
          value={viewer.pointBudget}
          onChange={(e) => viewer.setPointBudget(Number(e.target.value) || 0)}
          disabled={viewer.autoPointBudgetEnabled}
          title={viewer.autoPointBudgetEnabled ? "自動調整中のため読み取り専用。下のチェックを外すと手動で変更できる" : undefined}
          className="rounded border border-black/10 bg-white/60 px-2 py-1 font-mono text-xs text-inherit disabled:opacity-60 dark:border-white/10 dark:bg-black/30"
        />
        <label className="flex items-center gap-2">
          <input type="checkbox" className="accent-primary" checked={viewer.autoPointBudgetEnabled} onChange={(e) => viewer.setAutoPointBudgetEnabled(e.target.checked)} />
          点予算を自動調整する
        </label>
      </div>

      <div className="flex flex-col gap-1 text-xs">
        <label className="opacity-70">背景</label>
        <select
          value={viewer.backgroundMode}
          onChange={(e) => viewer.setBackgroundMode(e.target.value as BackgroundMode)}
          className="rounded border border-black/10 bg-white/60 px-2 py-1 text-xs text-inherit dark:border-white/10 dark:bg-black/30"
        >
          {(Object.keys(BACKGROUND_MODE_LABELS) as BackgroundMode[]).map((mode) => (
            <option key={mode} value={mode}>
              {BACKGROUND_MODE_LABELS[mode]}
            </option>
          ))}
        </select>
      </div>

      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" className="accent-primary" checked={viewer.gridEnabled} onChange={(e) => viewer.setGridEnabled(e.target.checked)} />
        グリッド
      </label>
    </div>
  );
}
