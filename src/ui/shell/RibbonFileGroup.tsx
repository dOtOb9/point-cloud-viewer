import { useState } from "react";
import type { CopcViewerState } from "../../state/useCopcViewer";
// 規約2: `@tauri-apps/plugin-dialog`を直接importしない。DataSource側の関数
// (`pickLocalFile`)越しに呼ぶ(`src/datasource/tauri.ts`参照)。
import { pickLocalFile } from "../../datasource/tauri";
import { RIBBON_BUTTON_CLASS, RIBBON_GROUP_CLASS, RIBBON_GROUP_LABEL_CLASS, RIBBON_INPUT_CLASS } from "./ribbon-styles";

// CORSとHTTP Rangeに対応した公開COPCのサンプル(TaskSheets/TEST-DATA.mdのautzen)。
// 以前はLayerPanel.tsxにあった定数(ADR-0017でリボンへ移動)。
const SAMPLE_COPC_URL = "https://s3.amazonaws.com/hobu-lidar/autzen-classified.copc.laz";

interface Props {
  viewer: CopcViewerState;
}

/**
 * ADR-0017 (UIシェル再構築): トップリボンの「ファイル」グループ。
 *
 * 以前`LayerPanel.tsx`に直書きしていた「ファイルを開く」操作一式
 * (Web版: ファイル選択/URL入力/サンプルを開く、デスクトップ・Android版:
 * OSのファイル選択ダイアログ)をそのまま移した。見た目・DOM構造は変えたが、
 * `viewer.openFile()`を呼ぶだけの薄い呼び出しである点は変えていない
 * (並行して別のエージェントが複数ファイル選択(`multiple`属性)を
 * このファイル選択input自体に足す作業をしているため、ロジックをここに
 * 増やさず、呼び出すだけに留める。タスクの指示)。
 *
 * `data-testid="file-input"`は`e2e/web-conversion.spec.ts`が
 * `setInputFiles`で駆動するために必須(CLAUDE.md参照)。場所が
 * `LayerPanel.tsx`からここへ変わっただけで、要素の役割(ローカルファイル選択)は
 * 変えていない。
 */
export function RibbonFileGroup({ viewer }: Props) {
  const [urlInput, setUrlInput] = useState("");
  const busy = viewer.status === "opening" || viewer.status === "converting";

  return (
    <div className={RIBBON_GROUP_CLASS}>
      <span className={RIBBON_GROUP_LABEL_CLASS}>ファイル</span>
      <div className="flex flex-wrap items-center gap-1">
        {viewer.isBrowser ? (
          <>
            <label className={`${RIBBON_BUTTON_CLASS} flex cursor-pointer items-center bg-slate-900/90 text-white hover:bg-slate-900 dark:bg-white/90 dark:text-slate-900`}>
              開く…
              <input
                type="file"
                // M4-3/M4-6b/M4-9: 生のLAS/LAZ・PCDも選べる(Web版はOPFS上で
                // 直接COPCへ変換できる。`useCopcViewer.ts`の`openFile`参照)。
                accept=".las,.laz,.pcd"
                // E2E(`e2e/web-conversion.spec.ts`)がこのdata-testidで
                // `setInputFiles`してファイル選択を駆動する。
                data-testid="file-input"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void viewer.openFile(file);
                  e.target.value = "";
                }}
                disabled={busy}
                className="sr-only"
              />
            </label>
            <input
              type="text"
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              placeholder="COPCのURL"
              title="COPCのURL (CORS+Rangeが必要)"
              className={`${RIBBON_INPUT_CLASS} w-40 font-mono`}
            />
            <button
              type="button"
              onClick={() => void viewer.openFile(urlInput)}
              disabled={busy || urlInput.trim() === ""}
              className={RIBBON_BUTTON_CLASS}
            >
              {viewer.status === "opening" ? "開いています…" : "URLを開く"}
            </button>
            <button type="button" onClick={() => void viewer.openFile(SAMPLE_COPC_URL)} disabled={busy} className={RIBBON_BUTTON_CLASS}>
              サンプル
            </button>
          </>
        ) : (
          // デスクトップ・Android共通: OSのファイル選択ダイアログ
          // (`tauri-plugin-dialog`)。Androidはパスを手入力できないため、
          // これが唯一の開き方になる(TaskSheets/M3-release-and-update.md参照)。
          <button
            type="button"
            onClick={() => {
              void (async () => {
                const picked = await pickLocalFile();
                if (picked) void viewer.openFile(picked);
              })();
            }}
            disabled={busy}
            className={`${RIBBON_BUTTON_CLASS} bg-slate-900/90 text-white hover:bg-slate-900 dark:bg-white/90 dark:text-slate-900`}
          >
            {viewer.status === "opening" ? "開いています…" : viewer.status === "converting" ? "変換しています…" : "開く…"}
          </button>
        )}
      </div>
    </div>
  );
}
