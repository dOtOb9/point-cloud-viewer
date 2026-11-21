import { useEffect, useState, useSyncExternalStore } from "react";
import { createPluginHost, type PluginHostCore, type PluginHostDeps, type PluginHostState } from "../../core/plugin-host";
import type { PcvPlugin } from "../../plugin-api";

export function usePluginHost(plugins: readonly PcvPlugin[], deps: PluginHostDeps): PluginHostCore {
  const [host] = useState(() => createPluginHost(deps));
  useEffect(() => {
    host.activate(plugins);
    return () => host.deactivateAll();
  }, [host, plugins]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => host.handleKeyDown(event);
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [host]);
  return host;
}

export function usePluginHostState(host: PluginHostCore): PluginHostState {
  return useSyncExternalStore(host.subscribe, host.getState);
}
