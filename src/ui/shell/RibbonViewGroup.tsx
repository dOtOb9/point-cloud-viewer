import { Eye, Gauge, Palette } from "lucide-react";
import { RibbonButton } from "./RibbonButton";
import { RIBBON_GROUP_CLASS, RIBBON_GROUP_LABEL_CLASS } from "./ribbon-styles";

interface Props {
  onOpenColorMode: () => void;
  onOpenAppearance: () => void;
  onOpenLoadPriority: () => void;
}

/**
 * ADR-0017 (UIシェル再構築): トップリボンの「表示」グループ。
 * ボタンだけを並べる。詳しい操作(選択肢・スライダー)は、押した後に開く
 * ダイアログ(`ViewDialogs.tsx`)にある。ダイアログの開閉は`Ribbon.tsx`が持つ。
 */
export function RibbonViewGroup({ onOpenColorMode, onOpenAppearance, onOpenLoadPriority }: Props) {
  return (
    <div className={RIBBON_GROUP_CLASS}>
      <span className={RIBBON_GROUP_LABEL_CLASS}>表示</span>
      <div className="flex flex-wrap items-center gap-1">
        <RibbonButton icon={Palette} label="着色" title="色の付け方を選ぶ" onClick={onOpenColorMode} />
        <RibbonButton icon={Eye} label="見た目" title="EDL・点の形" onClick={onOpenAppearance} />
        <RibbonButton icon={Gauge} label="読み込み優先" title="画面中央を優先して読み込む強さ" onClick={onOpenLoadPriority} />
      </div>
    </div>
  );
}
