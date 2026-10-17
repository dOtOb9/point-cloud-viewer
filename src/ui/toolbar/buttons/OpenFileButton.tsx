import { FolderOpen } from "lucide-react";
import type { CopcViewerState } from "../../../state/useCopcViewer";
// 規約2: Tauriのダイアログのパッケージを直接importしない。DataSource側の関数
// (`pickLocalFiles`。M4-14で複数選択に対応)越しに呼ぶ(`src/datasource/tauri.ts`参照)。
import { pickLocalFiles } from "../../../datasource/tauri";
import { ToolbarButton } from "../ToolbarButton";
import { TOOLBAR_BUTTON_CLASS, TOOLBAR_BUTTON_PRIMARY_CLASS, TOOLBAR_GROUP_CLASS, TOOLBAR_GROUP_LABEL_CLASS } from "../toolbar-styles";

interface Props {
  viewer: CopcViewerState;
}

/**
 * ADR-0017 (UIシェル再構築): トップツールバーの「ファイル」グループ。
 *
 * **ファイルはOSのファイル選択ダイアログからだけ開く**(所有者の要件: パスを
 * 人に打たせない)。Web版は隠した`<input type="file">`、デスクトップ・Androidは
 * Tauriのダイアログ(`pickLocalFiles`)。ドラッグ&ドロップは`useFileDrop.ts`。
 * 所有者の決定(2026-10-14): 読み込みのボタンは「開く」だけにする。以前あった
 * 「URLから開く」「サンプル」のボタンと`UrlDialog`は削除した(L1-multi-layer.md)。
 *
 * どの経路も`viewer.openFiles()`/`viewer.openFile()`を呼ぶだけの薄い呼び出し
 * (並行して別のエージェントが複数ファイル選択の対応をしているため、ロジックは
 * ここに増やさない)。`data-testid="file-input"`は`e2e/web-conversion.spec.ts`が
 * `setInputFiles`で駆動するために必須(CLAUDE.md参照)。
 */
export function ToolbarFileGroup({ viewer }: Props) {
  const busy = viewer.status === "opening" || viewer.status === "converting";

  return (
    <div className={TOOLBAR_GROUP_CLASS}>
      <span className={TOOLBAR_GROUP_LABEL_CLASS}>ファイル</span>
      <div className="flex flex-nowrap items-center gap-1">
        {viewer.isBrowser ? (
          <>
            {/* 隠した<input>をラベルで包み、見た目はツールバーのボタン(アイコン+ラベル)にする。 */}
            <label
              className={`${TOOLBAR_BUTTON_CLASS} ${TOOLBAR_BUTTON_PRIMARY_CLASS} cursor-pointer ${busy ? "pointer-events-none opacity-40" : ""}`}
              title="ファイルを開く"
            >
              <FolderOpen size={20} aria-hidden="true" />
              <span>開く</span>
              <input
                type="file"
                // M4-3/M4-6b/M4-9: 生のLAS/LAZ・PCDも選べる(Web版はOPFS上で
                // 直接COPCへ変換できる。`useCopcViewer.ts`の`openFile`参照)。
                accept=".las,.laz,.pcd"
                // E2E(`e2e/web-conversion.spec.ts`)がこのdata-testidで
                // `setInputFiles`してファイル選択を駆動する。
                data-testid="file-input"
                // M4-14: 複数選択できる(`viewer.openFiles`。1件だけなら従来どおり)。
                multiple
                onChange={(e) => {
                  const files = e.target.files;
                  if (files && files.length > 0) void viewer.openFiles(Array.from(files));
                  e.target.value = "";
                }}
                disabled={busy}
                className="sr-only"
              />
            </label>
          </>
        ) : (
          <ToolbarButton
            icon={FolderOpen}
            label={viewer.status === "opening" ? "開いています…" : viewer.status === "converting" ? "変換中…" : "開く"}
            primary
            disabled={busy}
            onClick={() => {
              void (async () => {
                // M4-14: 複数選択できるダイアログ。LAS/LAZを複数選ぶと1つのCOPCへ
                // マージする(`viewer.openFiles`)。1件だけなら従来どおり。
                const picked = await pickLocalFiles();
                if (picked && picked.length > 0) void viewer.openFiles(picked);
              })();
            }}
          />
        )}
      </div>
    </div>
  );
}
