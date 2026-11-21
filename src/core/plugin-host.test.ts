import { describe, expect, it, vi } from "vitest";
import type { PcvPlugin, PluginHost, RibbonHandle, ShortcutHandle } from "../plugin-api";
import { attachViewRenderer, createViewContext } from "../app/view";
import { createPluginHost, isEnabled, pluginErrorMessage, ribbonInGroup, type ShortcutKeyEvent } from "./plugin-host";

function fakePlugin(id: string, activate: (host: PluginHost) => void | (() => void)): PcvPlugin {
  return { id, name: id, apiVersion: 1, activate };
}

function makeHost() {
  const reported: string[] = [];
  const host = createPluginHost({ reportError: (message) => reported.push(message), view: createViewContext() });
  return { host, reported };
}

const icon = {};

function keyEvent(key: string, target: unknown = null, extra: Partial<ShortcutKeyEvent> = {}): ShortcutKeyEvent & { prevented: boolean } {
  const event = {
    key,
    target,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    prevented: false,
    preventDefault() {
      event.prevented = true;
    },
    ...extra,
  };
  return event;
}

describe("plugin host: activation", () => {
  it("activates the plugins in order and keeps what they register", () => {
    const { host } = makeHost();
    const order: string[] = [];
    host.activate([
      fakePlugin("a", (h) => {
        order.push("a");
        h.ribbon.add({ group: "view", label: "A", icon, onClick: () => {} });
      }),
      fakePlugin("b", (h) => {
        order.push("b");
        h.status.add({ render: () => "b status" });
      }),
    ]);
    expect(order).toEqual(["a", "b"]);
    expect(host.getState().ribbon.map((r) => [r.pluginId, r.item.label])).toEqual([["a", "A"]]);
    expect(host.getState().status.map((s) => s.pluginId)).toEqual(["b"]);
  });

  it("stops a plugin whose activate throws, drops what it registered, reports it and keeps loading the others", () => {
    const { host, reported } = makeHost();
    host.activate([
      fakePlugin("broken", (h) => {
        h.ribbon.add({ group: "view", label: "half", icon, onClick: () => {} });
        h.shortcuts.add({ key: "x", label: "x", kind: "harmless", run: () => {} });
        throw new Error("activate failed");
      }),
      fakePlugin("fine", (h) => void h.ribbon.add({ group: "view", label: "ok", icon, onClick: () => {} })),
    ]);
    expect(host.getState().ribbon.map((r) => r.item.label)).toEqual(["ok"]);
    expect(host.getState().shortcuts).toEqual([]);
    expect(reported).toEqual(["broken: activate failed"]);
  });

  it("ignores what a stopped plugin tries to register later", () => {
    const { host } = makeHost();
    let saved: PluginHost | null = null;
    host.activate([
      fakePlugin("broken", (h) => {
        saved = h;
        throw new Error("no");
      }),
    ]);
    saved!.ribbon.add({ group: "view", label: "late", icon, onClick: () => {} });
    expect(host.getState().ribbon).toEqual([]);
  });

  it("does not load a plugin with an unknown apiVersion and reports its id and version", () => {
    const { host, reported } = makeHost();
    const activate = vi.fn();
    host.activate([{ id: "vendor.future", name: "future", apiVersion: 2, activate } as unknown as PcvPlugin]);
    expect(activate).not.toHaveBeenCalled();
    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain("vendor.future");
    expect(reported[0]).toContain("apiVersion 2");
  });

  it("keeps the first plugin of an id and reports the second", () => {
    const { host, reported } = makeHost();
    const second = vi.fn();
    host.activate([fakePlugin("same", (h) => void h.ribbon.add({ group: "view", label: "first", icon, onClick: () => {} })), fakePlugin("same", second)]);
    expect(second).not.toHaveBeenCalled();
    expect(host.getState().ribbon.map((r) => r.item.label)).toEqual(["first"]);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatch(/^same: /);
  });
});

describe("plugin host: cleanup", () => {
  it("calls the cleanup that activate returned and removes everything the plugin registered", () => {
    const { host } = makeHost();
    const cleanup = vi.fn();
    host.activate([
      fakePlugin("a", (h) => {
        h.ribbon.add({ group: "view", label: "A", icon, onClick: () => {} });
        h.status.add({ render: () => "a" });
        h.shortcuts.add({ key: "a", label: "a", kind: "harmless", run: () => {} });
        h.dialogs.open({ title: "A", render: () => "a" });
        return cleanup;
      }),
      fakePlugin("b", (h) => void h.ribbon.add({ group: "view", label: "B", icon, onClick: () => {} })),
    ]);
    host.deactivate("a");
    expect(cleanup).toHaveBeenCalledTimes(1);
    const state = host.getState();
    expect(state.ribbon.map((r) => r.pluginId)).toEqual(["b"]);
    expect(state.status).toEqual([]);
    expect(state.shortcuts).toEqual([]);
    expect(state.dialogs).toEqual([]);
  });

  it("deactivates a plugin without a cleanup function too", () => {
    const { host } = makeHost();
    host.activate([fakePlugin("a", (h) => void h.ribbon.add({ group: "view", label: "A", icon, onClick: () => {} }))]);
    host.deactivate("a");
    expect(host.getState().ribbon).toEqual([]);
  });

  it("reports a cleanup that throws and still removes the registrations", () => {
    const { host, reported } = makeHost();
    host.activate([
      fakePlugin("a", (h) => {
        h.ribbon.add({ group: "view", label: "A", icon, onClick: () => {} });
        return () => {
          throw new Error("cleanup failed");
        };
      }),
    ]);
    host.deactivate("a");
    expect(host.getState().ribbon).toEqual([]);
    expect(reported).toEqual(["a: cleanup failed"]);
  });

  it("deactivateAll lets the same plugins be activated again (React StrictMode runs effects twice)", () => {
    const { host, reported } = makeHost();
    const plugins = [fakePlugin("a", (h) => void h.ribbon.add({ group: "view", label: "A", icon, onClick: () => {} }))];
    host.activate(plugins);
    host.deactivateAll();
    host.activate(plugins);
    expect(host.getState().ribbon.map((r) => r.item.label)).toEqual(["A"]);
    expect(reported).toEqual([]);
  });
});

describe("plugin host: shortcuts", () => {
  it("keeps the first shortcut of a key and reports the second, also across plugins and letter case", () => {
    const { host, reported } = makeHost();
    const first = vi.fn();
    const second = vi.fn();
    host.activate([
      fakePlugin("a", (h) => void h.shortcuts.add({ key: "K", label: "fit", kind: "harmless", run: first })),
      fakePlugin("b", (h) => void h.shortcuts.add({ key: "k", label: "other", kind: "harmless", run: second })),
    ]);
    expect(host.getState().shortcuts.map((s) => s.pluginId)).toEqual(["a"]);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatch(/^b: /);
    host.handleKeyDown(keyEvent("k"));
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it("runs a harmless shortcut on a checkbox but not in a text input", () => {
    const { host } = makeHost();
    const run = vi.fn();
    host.activate([fakePlugin("a", (h) => void h.shortcuts.add({ key: "8", label: "top", kind: "harmless", run }))]);
    host.handleKeyDown(keyEvent("8", { tagName: "INPUT", type: "text" }));
    expect(run).not.toHaveBeenCalled();
    const onCheckbox = keyEvent("8", { tagName: "INPUT", type: "checkbox" });
    host.handleKeyDown(onCheckbox);
    expect(run).toHaveBeenCalledTimes(1);
    expect(onCheckbox.prevented).toBe(true);
  });

  it("does not run an irreversible shortcut on any form control, a checkbox included", () => {
    const { host } = makeHost();
    const run = vi.fn();
    host.activate([fakePlugin("a", (h) => void h.shortcuts.add({ key: "Backspace", label: "delete", kind: "irreversible", run }))]);
    const onCheckbox = keyEvent("Backspace", { tagName: "INPUT", type: "checkbox" });
    host.handleKeyDown(onCheckbox);
    host.handleKeyDown(keyEvent("Backspace", { tagName: "SELECT" }));
    expect(run).not.toHaveBeenCalled();
    expect(onCheckbox.prevented).toBe(false);
    host.handleKeyDown(keyEvent("Backspace", { tagName: "DIV" }));
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("ignores keys pressed with Ctrl, Meta or Alt, repeats and composition", () => {
    const { host } = makeHost();
    const run = vi.fn();
    host.activate([fakePlugin("a", (h) => void h.shortcuts.add({ key: "k", label: "fit", kind: "harmless", run }))]);
    host.handleKeyDown(keyEvent("k", null, { ctrlKey: true }));
    host.handleKeyDown(keyEvent("k", null, { metaKey: true }));
    host.handleKeyDown(keyEvent("k", null, { altKey: true }));
    host.handleKeyDown(keyEvent("k", null, { repeat: true }));
    host.handleKeyDown(keyEvent("k", null, { isComposing: true }));
    expect(run).not.toHaveBeenCalled();
  });

  it("reports a shortcut that throws instead of letting the key handler throw", () => {
    const { host, reported } = makeHost();
    host.activate([
      fakePlugin("a", (h) =>
        void h.shortcuts.add({
          key: "g",
          label: "g",
          kind: "harmless",
          run: () => {
            throw new Error("run failed");
          },
        }),
      ),
    ]);
    expect(() => host.handleKeyDown(keyEvent("g"))).not.toThrow();
    expect(reported).toEqual(["a: run failed"]);
  });

  it("neither runs nor takes the key of a disabled shortcut, and follows setEnabled", () => {
    const { host } = makeHost();
    const run = vi.fn();
    let handle: ShortcutHandle | null = null;
    host.activate([fakePlugin("a", (h) => void (handle = h.shortcuts.add({ key: "k", label: "k", kind: "harmless", enabled: false, run })))]);
    const off = keyEvent("k");
    host.handleKeyDown(off);
    expect(run).not.toHaveBeenCalled();
    expect(off.prevented).toBe(false);
    handle!.setEnabled(true);
    const on = keyEvent("k");
    host.handleKeyDown(on);
    expect(run).toHaveBeenCalledTimes(1);
    expect(on.prevented).toBe(true);
    handle!.setEnabled(false);
    host.handleKeyDown(keyEvent("k"));
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("gives a refused shortcut a handle that does nothing", () => {
    const { host } = makeHost();
    let handle: ShortcutHandle | null = null;
    host.activate([
      fakePlugin("a", (h) => void h.shortcuts.add({ key: "k", label: "k", kind: "harmless", run: () => {} })),
      fakePlugin("b", (h) => void (handle = h.shortcuts.add({ key: "k", label: "k", kind: "harmless", enabled: false, run: () => {} }))),
    ]);
    const before = host.getState();
    handle!.setEnabled(true);
    expect(host.getState()).toBe(before);
  });
});

describe("plugin host: ribbon enabled and groups", () => {
  it("keeps a ribbon item disabled until setEnabled(true), without registering it again", () => {
    const { host } = makeHost();
    const onClick = vi.fn();
    let handle: RibbonHandle | null = null;
    host.activate([fakePlugin("a", (h) => void (handle = h.ribbon.add({ group: "view", label: "A", icon, enabled: false, onClick })))]);
    const key = host.getState().ribbon[0].key;
    expect(isEnabled(host.getState().ribbon[0].item)).toBe(false);
    host.clickRibbonItem(host.getState().ribbon[0]);
    expect(onClick).not.toHaveBeenCalled();
    handle!.setEnabled(true);
    expect(host.getState().ribbon.map((e) => [e.key, isEnabled(e.item)])).toEqual([[key, true]]);
    host.clickRibbonItem(host.getState().ribbon[0]);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("does not notify when setEnabled does not change anything", () => {
    const { host } = makeHost();
    let handle: RibbonHandle | null = null;
    host.activate([fakePlugin("a", (h) => void (handle = h.ribbon.add({ group: "view", label: "A", icon, onClick: () => {} })))]);
    const listener = vi.fn();
    host.subscribe(listener);
    handle!.setEnabled(true);
    expect(listener).not.toHaveBeenCalled();
  });

  it("lists the ribbon items of a group in the order they were added", () => {
    const { host } = makeHost();
    host.activate([
      fakePlugin("a", (h) => {
        h.ribbon.add({ group: "view", label: "A1", icon, onClick: () => {} });
        h.ribbon.add({ group: "view", label: "A2", icon, onClick: () => {} });
      }),
    ]);
    expect(ribbonInGroup(host.getState().ribbon, "view").map((e) => e.item.label)).toEqual(["A1", "A2"]);
  });
});

describe("plugin host: ribbon, dialogs, errors and programs", () => {
  it("reports a ribbon click that throws under the plugin's id", () => {
    const { host, reported } = makeHost();
    host.activate([
      fakePlugin("a", (h) =>
        void h.ribbon.add({
          group: "view",
          label: "A",
          icon,
          onClick: () => {
            throw new Error("click failed");
          },
        }),
      ),
    ]);
    host.clickRibbonItem(host.getState().ribbon[0]);
    expect(reported).toEqual(["a: click failed"]);
  });

  it("opens a dialog and closes it through the handle or the host", () => {
    const { host } = makeHost();
    let handle: { close(): void } | null = null;
    host.activate([fakePlugin("a", (h) => void (handle = h.dialogs.open({ title: "one", render: () => "1" })))]);
    expect(host.getState().dialogs.map((d) => d.item.title)).toEqual(["one"]);
    handle!.close();
    expect(host.getState().dialogs).toEqual([]);
  });

  it("tells the plugin exactly once when the host closes its dialog", () => {
    const { host } = makeHost();
    const onClose = vi.fn();
    host.activate([fakePlugin("a", (h) => void h.dialogs.open({ title: "one", render: () => "1", onClose }))]);
    const key = host.getState().dialogs[0].key;
    host.closeDialog(key);
    host.closeDialog(key);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(host.getState().dialogs).toEqual([]);
  });

  it("does not tell the plugin when the plugin closes its own dialog through the handle", () => {
    const { host } = makeHost();
    const onClose = vi.fn();
    let handle: { close(): void } | null = null;
    host.activate([fakePlugin("a", (h) => void (handle = h.dialogs.open({ title: "one", render: () => "1", onClose })))]);
    const key = host.getState().dialogs[0].key;
    handle!.close();
    host.closeDialog(key);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("does not tell a plugin that is being deactivated about its dialogs", () => {
    const { host } = makeHost();
    const onClose = vi.fn();
    host.activate([fakePlugin("a", (h) => void h.dialogs.open({ title: "one", render: () => "1", onClose }))]);
    host.deactivate("a");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("reports an onClose that throws under the plugin's id and the dialog stays closed", () => {
    const { host, reported } = makeHost();
    host.activate([
      fakePlugin("a", (h) =>
        void h.dialogs.open({
          title: "one",
          render: () => "1",
          onClose: () => {
            throw new Error("close failed");
          },
        }),
      ),
    ]);
    expect(() => host.closeDialog(host.getState().dialogs[0].key)).not.toThrow();
    expect(reported).toEqual(["a: close failed"]);
    expect(host.getState().dialogs).toEqual([]);
  });

  it("notifies subscribers when a registration changes", () => {
    const { host } = makeHost();
    const listener = vi.fn();
    host.subscribe(listener);
    host.activate([fakePlugin("a", (h) => h.status.add({ render: () => "a" }))]);
    expect(listener).toHaveBeenCalled();
  });

  it("passes errors.report to reportError with the source and the message unchanged", () => {
    const { host, reported } = makeHost();
    host.activate([fakePlugin("a", (h) => h.errors.report("a", new Error("読み込めませんでした: x.laz")))]);
    expect(reported).toEqual(["a: 読み込めませんでした: x.laz"]);
    expect(pluginErrorMessage("a", "plain text")).toBe("a: plain text");
  });

  it("files plugin errors under the existing tool source of the error log", () => {
    const reportError = vi.fn();
    createPluginHost({ reportError, view: createViewContext() }).report("a", new Error("x"));
    expect(reportError).toHaveBeenCalledWith("a: x", "tool");
  });

  it("gives each plugin a TEA program", () => {
    const { host } = makeHost();
    let count = -1;
    host.activate([
      fakePlugin("a", (h) => {
        const program = h.program(0, (model: number, msg: "inc") => [msg === "inc" ? model + 1 : model, []], () => "inc" as const);
        program.dispatch("inc");
        count = program.getModel();
      }),
    ]);
    expect(count).toBe(1);
  });

  it("reports an effect failure of a plugin program under the plugin's id and still gives the msg to update", () => {
    const { host, reported } = makeHost();
    const seen: string[] = [];
    host.activate([
      fakePlugin("a", (h) => {
        const program = h.program<number, "start" | "failed">(
          0,
          (model, msg) => {
            seen.push(msg);
            return [
              model,
              msg === "start"
                ? [
                    () => {
                      throw new Error("effect failed");
                    },
                  ]
                : [],
            ];
          },
          () => "failed",
        );
        program.dispatch("start");
      }),
    ]);
    expect(seen).toEqual(["start", "failed"]);
    expect(reported).toEqual(["a: effect failed"]);
  });

  it("reports under the plugin's id an effect that fails again while its update handles a failure", () => {
    const { host, reported } = makeHost();
    host.activate([
      fakePlugin("a", (h) => {
        const program = h.program<number, "start" | "failed">(
          0,
          (model, msg) => [
            model,
            [
              () => {
                throw new Error(msg === "start" ? "first" : "again");
              },
            ],
          ],
          () => "failed",
        );
        program.dispatch("start");
      }),
    ]);
    expect(reported).toEqual(["a: first", "a: again"]);
  });

  it("reports an effect failure once, and the error of an effectFailed that throws, under the plugin's id", () => {
    const { host, reported } = makeHost();
    host.activate([
      fakePlugin("a", (h) => {
        const program = h.program<number, "start">(
          0,
          (model) => [
            model,
            [
              () => {
                throw new Error("effect");
              },
            ],
          ],
          () => {
            throw new Error("conversion");
          },
        );
        program.dispatch("start");
      }),
    ]);
    expect(reported).toEqual(["a: effect", "a: conversion"]);
  });

  it("reports an update that throws once under the plugin's id and keeps the program running", () => {
    const { host, reported } = makeHost();
    let total = -1;
    host.activate([
      fakePlugin("a", (h) => {
        const program = h.program<number, "explode" | "inc">(
          0,
          (model, msg) => {
            if (msg === "explode") throw new Error("update failed");
            return [model + 1, []];
          },
          () => "inc",
        );
        program.dispatch("explode");
        program.dispatch("inc");
        total = program.getModel();
      }),
    ]);
    expect(reported).toEqual(["a: update failed"]);
    expect(total).toBe(1);
  });
});

describe("plugin host: layers and view", () => {
  function hostWithView() {
    const reported: string[] = [];
    const view = createViewContext();
    const renderer = { setViewPreset: vi.fn(() => true), fitAll: vi.fn(() => true), setProjectionMode: vi.fn() };
    attachViewRenderer(view, renderer);
    const host = createPluginHost({ reportError: (message) => reported.push(message), view });
    let given: PluginHost | null = null;
    host.activate([fakePlugin("a", (h) => void (given = h))]);
    return { host, reported, view, renderer, api: given! };
  }

  it("layers tells whether a point cloud is open and when that changes", () => {
    const { api, view } = hostWithView();
    const listener = vi.fn();
    api.layers.subscribe(listener);
    expect(api.layers.hasPointCloud()).toBe(false);
    view.pointCloud.set(true);
    expect(api.layers.hasPointCloud()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("view passes fit, a viewpoint and a projection to the renderer of this viewer, and reads them back", () => {
    const { api, renderer } = hostWithView();
    const listener = vi.fn();
    api.view.subscribe(listener);
    api.view.fitAll();
    api.view.showPreset("left");
    api.view.setProjection("orthographic");
    expect(renderer.fitAll).toHaveBeenCalledTimes(1);
    expect(renderer.setViewPreset).toHaveBeenCalledWith("left");
    expect(renderer.setProjectionMode).toHaveBeenLastCalledWith("orthographic");
    expect(api.view.get()).toEqual({ projection: "orthographic", preset: null, rendererHasLayers: false });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("reports a subscriber that throws under the plugin's id, and the other subscribers still hear the change", () => {
    const { api, view, reported } = hostWithView();
    const other = vi.fn();
    api.view.subscribe(() => {
      throw new Error("listener failed");
    });
    api.view.subscribe(other);
    api.layers.subscribe(() => {
      throw new Error("layers listener failed");
    });
    expect(() => api.view.setProjection("orthographic")).not.toThrow();
    expect(() => view.pointCloud.set(true)).not.toThrow();
    expect(other).toHaveBeenCalledTimes(1);
    expect(reported).toEqual(["a: listener failed", "a: layers listener failed"]);
  });

  it("stops telling a subscriber after it unsubscribes", () => {
    const { api, view } = hostWithView();
    const listener = vi.fn();
    const stop = api.layers.subscribe(listener);
    stop();
    view.pointCloud.set(true);
    expect(listener).not.toHaveBeenCalled();
  });
});
