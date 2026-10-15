import type { CopcViewerState, PointShape } from "../../state/useCopcViewer";
import { DEFAULT_POINT_SIZE_PX, MAX_POINT_SIZE_PX, MIN_POINT_SIZE_PX } from "../../renderer/layer-focus";
import { CloseButton } from "./CloseButton";
import { Dialog } from "./Dialog";
import { OptionRow } from "./OptionRow";

// ADR-0017追記: レイヤー欄の「見た目」ボタン(LayerActions.tsx)から開くダイアログ。
// 値はその場で反映する(適用ボタンは無い)。触るのは`viewer`のsetterだけで、状態は`useCopcViewer`が持つ。

interface DialogProps {
  viewer: CopcViewerState;
  open: boolean;
  onClose: () => void;
}

/** 点の形の選択肢。 */
const POINT_SHAPE_LABELS: Record<PointShape, string> = {
  round: "丸",
  square: "四角",
};

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
