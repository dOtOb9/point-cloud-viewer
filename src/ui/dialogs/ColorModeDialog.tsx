import type { ColorMode } from "../../renderer/colormap";
import type { CopcViewerState } from "../../state/useCopcViewer";
import { CloseButton } from "./CloseButton";
import { Dialog } from "./Dialog";
import { OptionRow } from "./OptionRow";

interface DialogProps {
  viewer: CopcViewerState;
  open: boolean;
  onClose: () => void;
}

const COLOR_MODE_LABELS: Record<ColorMode, string> = {
  rgb: "RGB",
  elevation: "標高",
  intensity: "強度",
  classification: "分類",
};


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
