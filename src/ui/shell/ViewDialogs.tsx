import { X } from "lucide-react";
import type { ReactNode } from "react";
import type { ColorMode, CopcViewerState, PointShape } from "../../state/useCopcViewer";
import { Dialog } from "./Dialog";
import { DIALOG_PRIMARY_BUTTON_CLASS } from "./dialog-styles";

// ADR-0017追記: リボンの「着色」「見た目」「読み込み優先」ボタンから開くダイアログ3つ。
// 値はその場で反映する(適用ボタンは無い)。ダイアログが触るのは`viewer`のsetterだけで、
// 状態は`useCopcViewer`が持つ(ここには状態を持たない)。

interface DialogProps {
  viewer: CopcViewerState;
  open: boolean;
  onClose: () => void;
}

/** フッターの「閉じる」ボタン(アイコン+ラベル。ADR-0017の約束)。 */
function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button type="button" onClick={onClose} className={`${DIALOG_PRIMARY_BUTTON_CLASS} flex items-center gap-1`}>
      <X size={16} aria-hidden="true" />
      閉じる
    </button>
  );
}

/** 選択肢1つ分の行(ラジオ・チェック共通の見た目)。 */
function OptionRow({ children, disabled = false }: { children: ReactNode; disabled?: boolean }) {
  return (
    <label className={`flex min-h-11 items-center gap-3 rounded px-2 text-sm hover:bg-black/5 dark:hover:bg-white/10 ${disabled ? "opacity-50" : ""}`}>
      {children}
    </label>
  );
}

/** M2-2: 着色モードの並び・ラベル。`colormap.ts`の`COLOR_MODES`の並びと合わせてある。 */
const COLOR_MODE_LABELS: Record<ColorMode, string> = {
  rgb: "RGB",
  elevation: "標高",
  intensity: "強度",
  classification: "分類",
};

/** 点の形。「点のサイズ」に対応する既存の唯一の切り替えがこれ(数値での大小調整は未実装)。 */
const POINT_SHAPE_LABELS: Record<PointShape, string> = {
  round: "丸",
  square: "四角",
};

/** 着色ダイアログ: 色の付け方を1つ選ぶ。 */
export function ColorModeDialog({ viewer, open, onClose }: DialogProps) {
  return (
    <Dialog open={open} title="着色" onClose={onClose} accent="primary" backdrop="clear" footer={<CloseButton onClose={onClose} />}>
      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 text-xs opacity-70">点の色の付け方</legend>
        {(Object.keys(COLOR_MODE_LABELS) as ColorMode[]).map((mode) => {
          // RGBを持たないファイルではRGBを選べない。hasColorが分からない(ファイル未オープン)間は選べる。
          const disabled = mode === "rgb" && viewer.cloudInfo !== null && !viewer.cloudInfo.hasColor;
          return (
            <OptionRow key={mode} disabled={disabled}>
              <input
                type="radio"
                name="color-mode"
                value={mode}
                checked={viewer.colorMode === mode}
                disabled={disabled}
                onChange={() => viewer.setColorMode(mode)}
                className="h-5 w-5 accent-primary"
              />
              {COLOR_MODE_LABELS[mode]}
              {disabled && <span className="text-xs opacity-70">（このファイルはRGBを持たない）</span>}
            </OptionRow>
          );
        })}
      </fieldset>
    </Dialog>
  );
}

/** 見た目ダイアログ: EDL のオン/オフと点の形。 */
export function AppearanceDialog({ viewer, open, onClose }: DialogProps) {
  return (
    <Dialog open={open} title="見た目" onClose={onClose} accent="primary" backdrop="clear" footer={<CloseButton onClose={onClose} />}>
      <section className="flex flex-col gap-1">
        <h3 className="text-xs opacity-70">EDL（陰影で凹凸を強調）</h3>
        <OptionRow>
          <input type="checkbox" checked={viewer.edlEnabled} onChange={(e) => viewer.setEdlEnabled(e.target.checked)} className="h-5 w-5 accent-primary" />
          EDLを使う
        </OptionRow>
      </section>
      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 text-xs opacity-70">点の形</legend>
        {(Object.keys(POINT_SHAPE_LABELS) as PointShape[]).map((shape) => (
          <OptionRow key={shape}>
            <input
              type="radio"
              name="point-shape"
              value={shape}
              checked={viewer.pointShape === shape}
              onChange={() => viewer.setPointShape(shape)}
              className="h-5 w-5 accent-primary"
            />
            {POINT_SHAPE_LABELS[shape]}
          </OptionRow>
        ))}
      </fieldset>
    </Dialog>
  );
}

/** 読み込み優先ダイアログ: 画面中央を優先して読み込む強さと、重みの下限。 */
export function LoadPriorityDialog({ viewer, open, onClose }: DialogProps) {
  return (
    <Dialog open={open} title="読み込み優先" onClose={onClose} accent="primary" backdrop="clear" footer={<CloseButton onClose={onClose} />}>
      <p className="text-xs opacity-70">画面の中央に近いデータを先に読み込む設定。変更はすぐ反映される。</p>
      <label className="flex flex-col gap-1 text-sm">
        <span className="flex justify-between">
          <span>中央優先の強さ</span>
          <span className="font-mono">{viewer.centerPriorityStrength}</span>
        </span>
        <input
          type="range"
          min={0}
          max={16}
          step={0.5}
          value={viewer.centerPriorityStrength}
          onChange={(e) => viewer.setCenterPriorityStrength(Number(e.target.value))}
          className="h-8 w-full accent-primary"
        />
        <span className="text-xs opacity-70">0〜16、既定4。大きいほど画面の端を後回しにする。0で無効。</span>
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="flex justify-between">
          <span>重みの下限</span>
          <span className="font-mono">{viewer.minCenterPriorityWeight.toFixed(2)}</span>
        </span>
        <input
          type="range"
          min={0}
          max={0.5}
          step={0.01}
          value={viewer.minCenterPriorityWeight}
          onChange={(e) => viewer.setMinCenterPriorityWeight(Number(e.target.value))}
          className="h-8 w-full accent-primary"
        />
        <span className="text-xs opacity-70">0〜0.5、既定0.2。画面の端でも読み込まれなくならないよう、重みの最小値を決める。</span>
      </label>
    </Dialog>
  );
}
