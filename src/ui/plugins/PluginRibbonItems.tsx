import type { LucideIcon } from "lucide-react";
import type { PluginHostCore } from "../../core/plugin-host";
import { ToolbarButton } from "../toolbar/ToolbarButton";
import { PluginErrorBoundary } from "./PluginErrorBoundary";
import { usePluginHostState } from "./usePluginHost";

export function PluginRibbonItems({ host }: { host: PluginHostCore }) {
  const { ribbon } = usePluginHostState(host);
  return (
    <>
      {ribbon.map((entry) => (
        <PluginErrorBoundary key={entry.key} pluginId={entry.pluginId} onError={host.report}>
          <ToolbarButton
            icon={entry.item.icon as LucideIcon}
            label={entry.item.label}
            title={entry.item.title}
            onClick={() => host.clickRibbonItem(entry)}
          />
        </PluginErrorBoundary>
      ))}
    </>
  );
}
