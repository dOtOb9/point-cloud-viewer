import type { ReactNode } from "react";
import type { ViewNode } from "../../plugin-api";
import type { PluginHostCore } from "../../core/plugin-host";
import { PluginErrorBoundary } from "./PluginErrorBoundary";

export function RenderedByPlugin({ render }: { render: () => ViewNode }) {
  return <>{render() as ReactNode}</>;
}

export function PluginView({ host, pluginId, render }: { host: PluginHostCore; pluginId: string; render: () => ViewNode }) {
  return (
    <PluginErrorBoundary pluginId={pluginId} onError={host.report}>
      <RenderedByPlugin render={render} />
    </PluginErrorBoundary>
  );
}
