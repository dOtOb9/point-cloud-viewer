import { Settings } from "lucide-react";
import { ToolbarButton } from "../ToolbarButton";

/**
 * ADR-0017: opens the settings dialog. Always enabled (same role as the settings button
 * of the old `Dock.tsx`).
 */
export function SettingsButton({ onOpenSettings }: { onOpenSettings: () => void }) {
  return <ToolbarButton icon={Settings} label="設定" onClick={onOpenSettings} />;
}
