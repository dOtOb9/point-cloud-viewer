import { cancelConversion } from "../../app/open-files";
import type { PreparingStep } from "../../datasource/conversion-dto";
import type { CopcViewerState } from "../../state/useCopcViewer";
import { Dialog } from "./Dialog";
import { DIALOG_TERTIARY_BUTTON_CLASS } from "./dialog-styles";

function preparingStepLabel(preparing: PreparingStep): string {
  switch (preparing.step) {
    case "acquiringLock":
      return "変換のロックを取得しています…";
    case "cleaningStaleScratch":
      return "古い一時ファイルを掃除しています…";
    case "openingScratchFiles":
      return `一時ファイルを開いています(${preparing.opened}/${preparing.total})…`;
    case "openingOutputFile":
      return "出力ファイルを開いています…";
    case "readingHeader":
      return "ヘッダーを読み込んでいます…";
    case "startingDecompressWorkers":
      return `展開用のWorkerを起動しています(${preparing.started}/${preparing.total})…`;
  }
}

function formatElapsed(seconds: number): string {
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}分${s}秒` : `${s}秒`;
}

export function ConversionDialog({ viewer, open, onClose }: { viewer: CopcViewerState; open: boolean; onClose: () => void }) {
  const converting = viewer.status.kind === "converting";
  const progress = viewer.conversionProgress;
  const name = viewer.convertingFileName ?? "(不明)";

  return (
    <Dialog
      open={open}
      title={converting ? "変換中" : "変換が完了しました"}
      accent="secondary"
      onClose={onClose}
      footer={
        converting ? (
          <>
            <button type="button" onClick={() => cancelConversion(viewer.fileOpenContext)} className={DIALOG_TERTIARY_BUTTON_CLASS}>
              キャンセル
            </button>
          </>
        ) : (
          <button type="button" onClick={onClose} className={DIALOG_TERTIARY_BUTTON_CLASS}>
            閉じる
          </button>
        )
      }
    >
      <p className="break-words text-sm">
        <span className="opacity-60">ファイル: </span>
        {name}
      </p>

      {converting ? (
        <div className="flex flex-col gap-2 text-sm">
          <span className="self-start rounded bg-secondary px-2 py-0.5 text-xs text-on-secondary">
            段階: {progress === null || progress.phase === "preparing" ? "準備" : progress.phase === "reading" ? "読み込み" : "構築・書き出し"}
          </span>
          {progress === null ? (
            <p className="opacity-70">変換を準備しています…</p>
          ) : progress.phase === "preparing" ? (
            <p className="opacity-70">{preparingStepLabel(progress.preparing)}</p>
          ) : progress.phase === "reading" ? (
            <>
              <p>
                読み込み中: {progress.pointsRead.toLocaleString()} / {progress.totalPoints.toLocaleString()} 点(
                {((progress.pointsRead / Math.max(1, progress.totalPoints)) * 100).toFixed(1)}%)
              </p>
              <div className="h-2 w-full overflow-hidden rounded bg-tertiary/25">
                <div
                  className="h-full w-full origin-left bg-secondary transition-transform duration-(--motion-progress) ease-linear"
                  style={{ transform: `scaleX(${Math.min(1, progress.pointsRead / Math.max(1, progress.totalPoints))})` }}
                />
              </div>
              <p className="opacity-70">経過: {formatElapsed(progress.elapsedSecs)}</p>
            </>
          ) : (
            <>
              <p>octreeを構築・書き出し中(割合は出せません)…</p>
              <div className="h-2 w-full overflow-hidden rounded bg-tertiary/25">
                <div className="h-full w-1/3 animate-pulse bg-secondary" />
              </div>
              <p className="opacity-70">経過: {formatElapsed(progress.elapsedSecs)}</p>
            </>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-2 text-sm">
          <p>変換が終わり、結果を開きました（開いている最中のときは、そのまま待ってください）。</p>
          <p className="opacity-70">変換の内訳とダウンロードは、左パネルの「レイヤー情報」にあります。</p>
        </div>
      )}
    </Dialog>
  );
}
