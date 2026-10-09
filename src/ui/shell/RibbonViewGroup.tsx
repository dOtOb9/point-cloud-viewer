import type { ColorMode, CopcViewerState, PointShape } from "../../state/useCopcViewer";
import { RIBBON_GROUP_CLASS, RIBBON_GROUP_LABEL_CLASS, RIBBON_INPUT_CLASS } from "./ribbon-styles";

/** M2-2: 着色モードの並び・ラベル。`colormap.ts`の`COLOR_MODES`の並びと合わせてある
 *  (以前は`LayerPanel.tsx`にあった定数。ADR-0017でリボンへ移動)。 */
const COLOR_MODE_LABELS: Record<ColorMode, string> = {
  rgb: "RGB",
  elevation: "標高",
  intensity: "強度",
  classification: "分類",
};

/** 点の形。「点のサイズ」に対応する既存の唯一の切り替えがこれ(丸/四角)。
 *  数値での大小調整は実装していない(`src/renderer/gpu-resources.ts`の
 *  `POINT_SIZE_PX`は固定値で、UIから変えられる口は無い)。
 *  タスクシートの「point size」はこの「点の形」に対応付けた
 *  (ADR-0017の対応表に明記)。 */
const POINT_SHAPE_LABELS: Record<PointShape, string> = {
  round: "丸",
  square: "四角",
};

/**
 * ADR-0017 (UIシェル再構築): トップリボンの「表示」グループ。
 *
 * タスクシートの指定: 着色モード・EDL・点のサイズ(=点の形)・中央優先度の強さと
 * 下限。以前はそれぞれ`LayerPanel.tsx`(着色モード)・`SettingsModal.tsx`
 * (EDL・点の形・中央優先度)に分かれていたものを、ここへ移した。
 *
 * 背景(`backgroundMode`)・グリッド(`gridEnabled`)・点予算はタスクシートが
 * 明示していないため、ここへは移さず左パネル(レイヤー情報)に残した
 * (`LayerInfoSection.tsx`参照。ADR-0017の対応表に理由を記載)。
 */
export function RibbonViewGroup({ viewer }: { viewer: CopcViewerState }) {
  return (
    <div className={RIBBON_GROUP_CLASS}>
      <span className={RIBBON_GROUP_LABEL_CLASS}>表示</span>
      <div className="flex flex-wrap items-center gap-1.5">
        <select
          value={viewer.colorMode}
          onChange={(e) => viewer.setColorMode(e.target.value as ColorMode)}
          title="着色モード"
          className={RIBBON_INPUT_CLASS}
        >
          {(Object.keys(COLOR_MODE_LABELS) as ColorMode[]).map((mode) => {
            // RGBを持たないファイルではRGBを選べないようにする(受け入れ条件)。
            // hasColorが分からない(まだファイルを開いていない)間はグレーアウトしない。
            const disabled = mode === "rgb" && viewer.cloudInfo !== null && !viewer.cloudInfo.hasColor;
            return (
              <option key={mode} value={mode} disabled={disabled} title={disabled ? "このファイルはRGBを持たない" : undefined}>
                {COLOR_MODE_LABELS[mode]}
                {disabled ? "（RGB無し）" : ""}
              </option>
            );
          })}
        </select>

        <label className="flex min-h-11 items-center gap-1.5 px-1 text-xs" title="EDL(陰影で凹凸を強調)">
          <input type="checkbox" checked={viewer.edlEnabled} onChange={(e) => viewer.setEdlEnabled(e.target.checked)} />
          EDL
        </label>

        <select
          value={viewer.pointShape}
          onChange={(e) => viewer.setPointShape(e.target.value as PointShape)}
          title="点のサイズ（点の形。丸/四角）"
          className={RIBBON_INPUT_CLASS}
        >
          {(Object.keys(POINT_SHAPE_LABELS) as PointShape[]).map((shape) => (
            <option key={shape} value={shape}>
              {POINT_SHAPE_LABELS[shape]}
            </option>
          ))}
        </select>

        <label className="flex min-h-11 items-center gap-1 px-1 text-xs" title={`中央優先の強さ（現在値: ${viewer.centerPriorityStrength}）`}>
          中央優先
          <input
            type="range"
            min={0}
            max={16}
            step={0.5}
            value={viewer.centerPriorityStrength}
            onChange={(e) => viewer.setCenterPriorityStrength(Number(e.target.value))}
            className="w-16"
          />
        </label>

        <label
          className="flex min-h-11 items-center gap-1 px-1 text-xs"
          title={`中央優先の重みの下限（現在値: ${viewer.minCenterPriorityWeight.toFixed(2)}）`}
        >
          下限
          <input
            type="range"
            min={0}
            max={0.5}
            step={0.01}
            value={viewer.minCenterPriorityWeight}
            onChange={(e) => viewer.setMinCenterPriorityWeight(Number(e.target.value))}
            className="w-16"
          />
        </label>
      </div>
    </div>
  );
}
