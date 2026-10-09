import { Box, FolderOpen, Link2 } from "lucide-react";
import type { CopcViewerState } from "../../state/useCopcViewer";
// 規約2: Tauriのダイアログのパッケージを直接importしない。DataSource側の関数
// (`pickLocalFiles`。M4-14で複数選択に対応)越しに呼ぶ(`src/datasource/tauri.ts`参照)。
import { pickLocalFiles } from "../../datasource/tauri";
import { RibbonButton } from "./RibbonButton";
import { RIBBON_BUTTON_CLASS, RIBBON_BUTTON_PRIMARY_CLASS, RIBBON_GROUP_CLASS, RIBBON_GROUP_LABEL_CLASS } from "./ribbon-styles";

// CORSとHTTP Rangeに対応した公開COPCのサンプル(TaskSheets/TEST-DATA.mdのautzen)。
const SAMPLE_COPC_URL = "https://s3.amazonaws.com/hobu-lidar/autzen-classified.copc.laz";

interface Props {
  viewer: CopcViewerState;
  /** 「URLから開く」ダイアログを開く(ダイアログ本体はAppShellが持つ。リボンの
   *  重ね順(z-20)の内側に出すと他の面に隠れるため)。 */
  onOpenUrlDialog: () => void;
}

/**
 * ADR-0017 (UIシェル再構築): トップリボンの「ファイル」グループ。
 *
 * **ファイルはOSのファイル選択ダイアログからだけ開く**(所有者の要件: パスを
 * 人に打たせない)。Web版は隠した`<input type="file">`、デスクトップ・Androidは
 * Tauriのダイアログ(`pickLocalFiles`)。ドラッグ&ドロップは`useFileDrop.ts`。
 * リモートCOPCのURLは「URLから開く」ボタンで`UrlDialog`(1つの入力欄)を開く。
 *
 * どの経路も`viewer.openFiles()`/`viewer.openFile()`を呼ぶだけの薄い呼び出し
 * (並行して別のエージェントが複数ファイル選択の対応をしているため、ロジックは
 * ここに増やさない)。`data-testid="file-input"`は`e2e/web-conversion.spec.ts`が
 * `setInputFiles`で駆動するために必須(CLAUDE.md参照)。
 */
export function RibbonFileGroup({ viewer, onOpenUrlDialog }: Props) {
  const busy = viewer.status === "opening" || viewer.status === "converting";

  return (
    <div className={RIBBON_GROUP_CLASS}>
      <span className={RIBBON_GROUP_LABEL_CLASS}>ファイル</span>
      <div className="flex flex-wrap items-center gap-1">
        {viewer.isBrowser ? (
          <>
            {/* 隠した<input>をラベルで包み、見た目はリボンのボタン(アイコン+ラベル)にする。 */}
            <label
              className={`${RIBBON_BUTTON_CLASS} ${RIBBON_BUTTON_PRIMARY_CLASS} cursor-pointer ${busy ? "pointer-events-none opacity-40" : ""}`}
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
            <RibbonButton icon={Link2} label="URLから開く" onClick={onOpenUrlDialog} disabled={busy} />
            <RibbonButton icon={Box} label="サンプル" onClick={() => void viewer.openFile(SAMPLE_COPC_URL)} disabled={busy} />
          </>
        ) : (
          <RibbonButton
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
