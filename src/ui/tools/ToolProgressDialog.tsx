import { cancelTool } from "../../app/point-cloud-tools";
import type { CopcViewerState } from "../../state/useCopcViewer";
import { Dialog } from "../dialogs/Dialog";
import { DIALOG_BUTTON_CLASS } from "../dialogs/dialog-styles";

/** Progress of the running point-cloud tool, with a cancel button. Shown while `viewer.toolProgress` is set. */
export function ToolProgressDialog({ viewer }: { viewer: CopcViewerState }) {
  const progress = viewer.toolProgress;
  const ratio = progress && progress.totalPoints > 0 ? Math.min(1, progress.pointsRead / progress.totalPoints) : 0;
  return (
    <Dialog
      open={progress !== null}
      title="点群ツールを実行中"
      accent="secondary"
      onClose={() => cancelTool(viewer.toolContext)}
      footer={
        <button type="button" onClick={() => cancelTool(viewer.toolContext)} className={DIALOG_BUTTON_CLASS} data-testid="tool-cancel">
          キャンセル
        </button>
      }
    >
      <p className="break-words text-sm" data-testid="tool-progress-title">
        {progress?.title ?? ""}
      </p>
      {progress && progress.totalPoints > 0 ? (
        <>
          <p className="text-sm">
            読み込み中: {progress.pointsRead.toLocaleString()} / {progress.totalPoints.toLocaleString()} 点（{(ratio * 100).toFixed(1)}%）
          </p>
          <div className="h-2 w-full overflow-hidden rounded bg-tertiary/25">
            <div className="h-full w-full origin-left bg-secondary transition-transform duration-(--motion-progress) ease-linear" style={{ transform: `scaleX(${ratio})` }} />
          </div>
        </>
      ) : (
        <p className="text-sm opacity-70">準備しています…</p>
      )}
      <p className="text-xs opacity-70">書き出しの間は割合を出せません。キャンセルは読み込みの合間に効きます。</p>
    </Dialog>
  );
}
