import { RIBBON_BUTTON_CLASS, RIBBON_GROUP_CLASS, RIBBON_GROUP_LABEL_CLASS } from "./ribbon-styles";

/**
 * ADR-0017 (UIシェル再構築): トップリボンの「設定」グループ。設定モーダルを
 * 開くボタン1つだけ(以前の`Dock.tsx`の設定ボタンと同じ役割)。
 */
export function RibbonSettingsGroup({ onOpenSettings }: { onOpenSettings: () => void }) {
  return (
    <div className={RIBBON_GROUP_CLASS}>
      <span className={RIBBON_GROUP_LABEL_CLASS}>設定</span>
      <div className="flex items-center gap-1">
        <button type="button" onClick={onOpenSettings} className={RIBBON_BUTTON_CLASS}>
          設定…
        </button>
      </div>
    </div>
  );
}
