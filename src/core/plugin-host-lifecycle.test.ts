import { describe, expect, it, vi } from "vitest";
import { createViewContext, type ViewContext } from "../app/view";
import type { PcvPlugin, PluginHost } from "../plugin-api";
import { createPluginHost } from "./plugin-host";

function fakePlugin(id: string, activate: (host: PluginHost) => void | (() => void)): PcvPlugin {
  return { id, name: id, apiVersion: 1, activate };
}

interface SubscribingPart {
  subscribe(host: PluginHost, listener: () => void): void;
  change(view: ViewContext): void;
}

const SUBSCRIBING_PARTS: Record<string, SubscribingPart> = {
  layers: {
    subscribe: (host, listener) => void host.layers.subscribe(listener),
    change: (view) => view.pointCloud.set(!view.pointCloud.get()),
  },
  view: {
    subscribe: (host, listener) => void host.view.subscribe(listener),
    change: (view) => view.state.set({ ...view.state.get(), preset: view.state.get().preset === "top" ? "front" : "top" }),
  },
};

function partsWithSubscribe(): string[] {
  let given: PluginHost | null = null;
  createPluginHost({ reportError: () => {}, view: createViewContext() }).activate([fakePlugin("probe", (h) => void (given = h))]);
  return Object.entries(given!)
    .filter(([, part]) => typeof part === "object" && part !== null && typeof (part as { subscribe?: unknown }).subscribe === "function")
    .map(([name]) => name);
}

describe("every subscription a plugin makes through the host ends with the plugin", () => {
  it("covers every part of the host that has subscribe (a new one must be added here)", () => {
    expect(partsWithSubscribe().sort()).toEqual(Object.keys(SUBSCRIBING_PARTS).sort());
  });

  it.each(Object.entries(SUBSCRIBING_PARTS))("%s: a listener of an active plugin hears the change", (_name, part) => {
    const view = createViewContext();
    const host = createPluginHost({ reportError: () => {}, view });
    const listener = vi.fn();
    host.activate([fakePlugin("a", (h) => part.subscribe(h, listener))]);
    part.change(view);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it.each(Object.entries(SUBSCRIBING_PARTS))("%s: nothing is heard after activate threw", (_name, part) => {
    const view = createViewContext();
    const host = createPluginHost({ reportError: () => {}, view });
    const listener = vi.fn();
    host.activate([
      fakePlugin("broken", (h) => {
        part.subscribe(h, listener);
        throw new Error("activate failed");
      }),
    ]);
    part.change(view);
    expect(listener).not.toHaveBeenCalled();
  });

  it.each(Object.entries(SUBSCRIBING_PARTS))("%s: nothing is heard after deactivating a plugin that returned no cleanup", (_name, part) => {
    const view = createViewContext();
    const host = createPluginHost({ reportError: () => {}, view });
    const listener = vi.fn();
    host.activate([fakePlugin("a", (h) => part.subscribe(h, listener))]);
    host.deactivate("a");
    part.change(view);
    expect(listener).not.toHaveBeenCalled();
  });

  it.each(Object.entries(SUBSCRIBING_PARTS))("%s: nothing is heard after deactivateAll", (_name, part) => {
    const view = createViewContext();
    const host = createPluginHost({ reportError: () => {}, view });
    const listener = vi.fn();
    host.activate([fakePlugin("a", (h) => part.subscribe(h, listener))]);
    host.deactivateAll();
    part.change(view);
    expect(listener).not.toHaveBeenCalled();
  });
});
