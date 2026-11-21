import { describe, expect, it, vi } from "vitest";
import type { PcvPlugin, PluginHost } from "../plugin-api";
import { createViewContext } from "../app/view";
import { createPluginHost } from "./plugin-host";

function fakePlugin(id: string, activate: (host: PluginHost) => void | (() => void)): PcvPlugin {
  return { id, name: id, apiVersion: 1, activate };
}

describe("plugin host: subscriptions to layers and view end with the plugin", () => {
  it("drops the subscriptions of a plugin whose activate throws, like its registrations", () => {
    const reported: string[] = [];
    const view = createViewContext();
    const host = createPluginHost({ reportError: (message) => reported.push(message), view });
    const viewListener = vi.fn();
    const layersListener = vi.fn();
    host.activate([
      fakePlugin("broken", (h) => {
        h.view.subscribe(viewListener);
        h.layers.subscribe(layersListener);
        throw new Error("activate failed");
      }),
    ]);
    view.pointCloud.set(true);
    view.state.set({ ...view.state.get(), preset: "top" });
    expect(layersListener).not.toHaveBeenCalled();
    expect(viewListener).not.toHaveBeenCalled();
  });

  it("drops the subscriptions of a deactivated plugin that did not return a cleanup", () => {
    const view = createViewContext();
    const host = createPluginHost({ reportError: () => {}, view });
    const viewListener = vi.fn();
    host.activate([fakePlugin("a", (h) => void h.view.subscribe(viewListener))]);
    host.deactivate("a");
    view.state.set({ ...view.state.get(), preset: "top" });
    expect(viewListener).not.toHaveBeenCalled();
  });
});
