import type { LucideIcon } from "lucide-react";
import { isEnabled, ribbonInGroup, type PluginHostCore } from "../../core/plugin-host";
import type { RibbonGroup } from "../../plugin-api";
import { ToolbarButton } from "../toolbar/ToolbarButton";
import { PluginErrorBoundary } from "./PluginErrorBoundary";
import { usePluginHostState } from "./usePluginHost";

export function PluginRibbonItems({ host, group }: { host: PluginHostCore; group: RibbonGroup }) {
  const { ribbon } = usePluginHostState(host);
  return (
    <>
      {ribbonInGroup(ribbon, group).map((entry) => {
        const enabled = isEnabled(entry.item);
        return (
          <PluginErrorBoundary key={entry.key} pluginId={entry.pluginId} onError={host.report}>
            <ToolbarButton
              icon={entry.item.icon as LucideIcon}
              label={entry.item.label}
              title={enabled ? entry.item.title : (entry.item.disabledTitle ?? entry.item.title)}
              disabled={!enabled}
              testId={entry.item.testId}
              onClick={() => host.clickRibbonItem(entry)}
            />
          </PluginErrorBoundary>
        );
      })}
    </>
  );
}
