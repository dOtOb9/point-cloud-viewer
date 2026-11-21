import type { PluginHostCore } from "../../core/plugin-host";
import { PluginErrorBoundary } from "./PluginErrorBoundary";
import { RenderedByPlugin } from "./RenderedByPlugin";
import { usePluginHostState } from "./usePluginHost";

export function PluginStatusItems({ host }: { host: PluginHostCore }) {
  const { status } = usePluginHostState(host);
  return (
    <>
      {status.map((entry) => (
        <PluginErrorBoundary key={entry.key} pluginId={entry.pluginId} onError={host.report}>
          <span className="whitespace-nowrap empty:hidden">
            <RenderedByPlugin render={entry.item.render} />
          </span>
        </PluginErrorBoundary>
      ))}
    </>
  );
}
