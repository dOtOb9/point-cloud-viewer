import { Settings } from "lucide-react";
import { ToolbarButton } from "../ToolbarButton";
import { TOOLBAR_GROUP_CLASS, TOOLBAR_GROUP_LABEL_CLASS } from "../toolbar-styles";

/**
 * ADR-0017 (UIシェル再構築): トップツールバーの「設定」グループ。設定ダイアログを
 * 開くボタン1つだけ(以前の`Dock.tsx`の設定ボタンと同じ役割)。
 */
export function ToolbarSettingsGroup({ onOpenSettings }: { onOpenSettings: () => void }) {
  return (
    <div className={TOOLBAR_GROUP_CLASS}>
      <span className={TOOLBAR_GROUP_LABEL_CLASS}>設定</span>
      <div className="flex items-center gap-1">
        <ToolbarButton icon={Settings} label="設定" onClick={onOpenSettings} />
      </div>
    </div>
  );
}
