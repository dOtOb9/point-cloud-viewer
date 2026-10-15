import type { ColorMode, CopcViewerState } from "../../state/useCopcViewer";
import { CloseButton } from "./CloseButton";
import { Dialog } from "./Dialog";
import { OptionRow } from "./OptionRow";

// ADR-0017追記: レイヤー欄の「着色」ボタン(LayerActions.tsx)から開くダイアログ。
// 値はその場で反映する(適用ボタンは無い)。触るのは`viewer`のsetterだけで、状態は`useCopcViewer`が持つ。

interface DialogProps {
  viewer: CopcViewerState;
  open: boolean;
  onClose: () => void;
}

/** M2-2: 着色モードの並び・ラベル。`colormap.ts`の`COLOR_MODES`の並びと合わせてある。 */
const COLOR_MODE_LABELS: Record<ColorMode, string> = {
  rgb: "RGB",
  elevation: "標高",
  intensity: "強度",
  classification: "分類",
};


/**
 * 着色ダイアログ: 色の付け方を1つ選ぶ。L1-D: 変えるのは**選択中のレイヤー**だけ（着色はレイヤーごと）。
 * レイヤーが無いときは選べない旨を出す。
 */
export function ColorModeDialog({ viewer, open, onClose }: DialogProps) {
  const layer = viewer.selectedLayer;
  return (
    <Dialog open={open} title="着色" onClose={onClose} accent="primary" footer={<CloseButton onClose={onClose} />}>
      {layer ? (
        <p className="text-xs opacity-70">
          対象のレイヤー: <span className="font-semibold">{layer.name}</span>
          （レイヤー欄で選んだレイヤーの色だけが変わる）
        </p>
      ) : (
        <p className="text-xs opacity-70">着色を変えるレイヤーがありません。ファイルを開いてから選んでください。</p>
      )}
      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 text-xs opacity-70">点の色の付け方</legend>
        {(Object.keys(COLOR_MODE_LABELS) as ColorMode[]).map((mode) => {
          // レイヤーが無ければ全部選べない。RGBを持たないレイヤーではRGBを選べない。
          const lacksRgb = mode === "rgb" && layer !== null && !layer.info.hasColor;
          const disabled = layer === null || lacksRgb;
          return (
            <OptionRow key={mode} disabled={disabled}>
              <input
                type="radio"
                name="color-mode"
                value={mode}
                checked={layer?.colorMode === mode}
                disabled={disabled}
                onChange={() => layer && viewer.setLayerColorMode(layer.id, mode)}
                className="h-5 w-5 accent-primary"
              />
              {COLOR_MODE_LABELS[mode]}
              {lacksRgb && <span className="text-xs opacity-70">（このレイヤーはRGBを持たない）</span>}
            </OptionRow>
          );
        })}
      </fieldset>
    </Dialog>
  );
}
