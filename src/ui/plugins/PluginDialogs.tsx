import type { PluginHostCore } from "../../core/plugin-host";
import { Dialog } from "../dialogs/Dialog";
import { PluginErrorBoundary } from "./PluginErrorBoundary";
import { RenderedByPlugin } from "./RenderedByPlugin";
import { usePluginHostState } from "./usePluginHost";

export function PluginDialogs({ host }: { host: PluginHostCore }) {
  const { dialogs } = usePluginHostState(host);
  return (
    <>
      {dialogs.map((entry) => (
        <PluginErrorBoundary
          key={entry.key}
          pluginId={entry.pluginId}
          onError={(pluginId, error) => {
            host.report(pluginId, error);
            host.closeDialog(entry.key);
          }}
        >
          <Dialog open title={entry.item.title} placement={entry.item.placement} onClose={() => host.closeDialog(entry.key)}>
            <RenderedByPlugin render={entry.item.render} />
          </Dialog>
        </PluginErrorBoundary>
      ))}
    </>
  );
}
