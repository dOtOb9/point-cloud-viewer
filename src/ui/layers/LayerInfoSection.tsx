import type { CopcViewerState } from "../../state/useCopcViewer";
import { MEASURE_KIND_NAME, measurementLabelLines } from "../../state/measure";
import { coordinateUnitLabel, formatCoordinate, lengthUnitsFor } from "../../state/units";
import { useDisplayUnit } from "../../state/useDisplayUnit";
import { formatCrsLong } from "../common/crs-format";
import { ConversionBreakdownPanel } from "./ConversionBreakdownPanel";

// 変換の進捗・キャンセルは中央の変換ダイアログ(ConversionDialog.tsx)へ移した(ADR-0017)。
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
  // L1-D: 選択中のレイヤーの情報を出す。変換の内訳・ダウンロードは、それを作ったレイヤーを
  // 選んでいるときだけ出る（変換直後はそのレイヤーが選択になる）。
  const layer = viewer.selectedLayer;
  const cloudInfo = layer?.info ?? null;
  // L2-D: the bounding box is shown in the chosen display unit (converted from the file unit).
  const [displayUnit] = useDisplayUnit();
  const units = lengthUnitsFor(cloudInfo?.crs, displayUnit);
  return (
    <div className="flex flex-col gap-3 pl-[11px]">
      {layer?.measurement ? (
        // L2-F: a measurement layer has no points, so show the kind and the measured values
        // (same lines as the on-screen label, in the display unit) instead of point count / CRS / bounding box.
        <div className="flex flex-col gap-0.5 text-xs" data-testid="measure-layer-info">
          <p>
            <span className="opacity-60">名前: </span>
            {layer.name}
          </p>
          <p>
            <span className="opacity-60">種類: </span>
            計測（{MEASURE_KIND_NAME[layer.measurement.kind]}）
          </p>
          {measurementLabelLines(layer.measurement, units).map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-0.5 text-xs">
          <p>
            <span className="opacity-60">ファイル名: </span>
            {layer?.name ?? "（未選択）"}
          </p>
          <p>
            <span className="opacity-60">点数: </span>
            {cloudInfo ? cloudInfo.pointCount.toLocaleString() : "―"}
          </p>
          <p>
            <span className="opacity-60">CRS: </span>
            {cloudInfo ? formatCrsLong(cloudInfo.crs) : "―"}
          </p>
          <p>
            <span className="opacity-60">バウンディングボックス: </span>
            {cloudInfo ? (
              <span className="font-mono">
                min={formatCoordinate(cloudInfo.min, units)} / max={formatCoordinate(cloudInfo.max, units)} {coordinateUnitLabel(units)}
              </span>
            ) : (
              "―"
            )}
          </p>
        </div>
      )}

      {viewer.error && (
        // E2E(`e2e/web-conversion.spec.ts`)がこのdata-testidでエラー表示の
        // 有無を確かめる。削除・リネームするときはそちらも直すこと(CLAUDE.md参照)。
        <p data-testid="viewer-error" className="text-xs text-error">
          {viewer.error}
        </p>
      )}

      {/* M4-6b: Web版のダウンロード導線。 */}
      {viewer.isBrowser && layer?.download && (
        <div className="flex items-center justify-between gap-2 rounded border border-black/10 p-2 text-xs dark:border-white/10">
          <span className="opacity-70">変換したCOPCを保存できます</span>
          <a
            href={layer.download.url}
            download={layer.download.fileName}
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
      {layer?.conversionBreakdownText && (
        <ConversionBreakdownPanel text={layer.conversionBreakdownText} onCopy={viewer.copyConversionBreakdownText} />
      )}
    </div>
  );
}
