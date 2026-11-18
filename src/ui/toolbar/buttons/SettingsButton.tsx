import { Settings } from "lucide-react";
import { ToolbarButton } from "../ToolbarButton";

export function SettingsButton({ onOpenSettings }: { onOpenSettings: () => void }) {
  return <ToolbarButton icon={Settings} label="設定" onClick={onOpenSettings} />;
}
