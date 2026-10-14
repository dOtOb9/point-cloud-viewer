import { X } from "lucide-react";
import type { ReactNode } from "react";
import type { ColorMode, CopcViewerState, PointShape } from "../../state/useCopcViewer";
import { DEFAULT_POINT_SIZE_PX, MAX_POINT_SIZE_PX, MIN_POINT_SIZE_PX } from "../../renderer/layer-focus";
import { Dialog } from "./Dialog";
import { DIALOG_TERTIARY_BUTTON_CLASS } from "./dialog-styles";

// ADR-0017追記: レイヤー欄の「着色」「見た目」ボタン(LayerActions.tsx)から開くダイアログ2つ(読み込み優先はL2-Aで設定へ移した)。
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
    <button type="button" onClick={onClose} className={`${DIALOG_TERTIARY_BUTTON_CLASS} flex items-center gap-1`}>
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

/** 点の形の選択肢。 */
const POINT_SHAPE_LABELS: Record<PointShape, string> = {
  round: "丸",
  square: "四角",
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

/**
 * 見た目ダイアログ（L2-B）: **選択中のレイヤー**の点の形と点の大きさ。着色ダイアログと同じく、
 * 変わるのは選択中のレイヤーだけ。EDL は画面全体にかける処理でレイヤーごとにできないので、
 * ここには置かない（設定のページにある）。
 */
export function AppearanceDialog({ viewer, open, onClose }: DialogProps) {
  const layer = viewer.selectedLayer;
  return (
    <Dialog open={open} title="見た目" onClose={onClose} accent="primary" footer={<CloseButton onClose={onClose} />}>
      {layer ? (
        <p className="text-xs opacity-70">
          対象のレイヤー: <span className="font-semibold">{layer.name}</span>
          （レイヤー欄で選んだレイヤーの点だけが変わる）
        </p>
      ) : (
        <p className="text-xs opacity-70">見た目を変えるレイヤーがありません。ファイルを開いてから選んでください。</p>
      )}
      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 text-xs opacity-70">点の形</legend>
        {(Object.keys(POINT_SHAPE_LABELS) as PointShape[]).map((shape) => (
          <OptionRow key={shape} disabled={layer === null}>
            <input
              type="radio"
              name="point-shape"
              value={shape}
              checked={layer?.pointShape === shape}
              disabled={layer === null}
              onChange={() => layer && viewer.setLayerPointShape(layer.id, shape)}
              className="h-5 w-5 accent-primary"
            />
            {POINT_SHAPE_LABELS[shape]}
          </OptionRow>
        ))}
      </fieldset>
      <label className="flex flex-col gap-1 text-sm">
        <span className="flex justify-between">
          <span>点の大きさ</span>
          <span className="font-mono">{layer ? `${layer.pointSize}px` : "-"}</span>
        </span>
        <input
          type="range"
          name="point-size"
          min={MIN_POINT_SIZE_PX}
          max={MAX_POINT_SIZE_PX}
          step={1}
          value={layer?.pointSize ?? DEFAULT_POINT_SIZE_PX}
          disabled={layer === null}
          onChange={(e) => layer && viewer.setLayerPointSize(layer.id, Number(e.target.value))}
          className="h-8 w-full accent-primary"
        />
        <span className="text-xs opacity-70">直径{MIN_POINT_SIZE_PX}〜{MAX_POINT_SIZE_PX}px、既定{DEFAULT_POINT_SIZE_PX}px。</span>
      </label>
    </Dialog>
  );
}
