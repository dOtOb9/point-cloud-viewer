// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Circle } from "lucide-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PcvPlugin, PluginHost } from "../../plugin-api";
import type { PluginHostCore } from "../../core/plugin-host";
import { PluginDialogs } from "./PluginDialogs";
import { PluginRibbonItems } from "./PluginRibbonItems";
import { PluginStatusItems } from "./PluginStatusItems";
import { usePluginHost } from "./usePluginHost";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function fakePlugin(id: string, activate: (host: PluginHost) => void | (() => void)): PcvPlugin {
  return { id, name: id, apiVersion: 1, activate };
}

function Shell({ plugins, reportError }: { plugins: readonly PcvPlugin[]; reportError: (message: string) => void }) {
  const host: PluginHostCore = usePluginHost(plugins, reportError);
  return (
    <div>
      <div data-testid="ribbon-slot">
        <PluginRibbonItems host={host} />
      </div>
      <div data-testid="status-slot">
        <PluginStatusItems host={host} />
      </div>
      <PluginDialogs host={host} />
    </div>
  );
}

let root: Root | null = null;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

function mount(plugins: readonly PcvPlugin[]) {
  const reported: string[] = [];
  root = createRoot(container);
  act(() => root!.render(<Shell plugins={plugins} reportError={(m) => reported.push(m)} />));
  return reported;
}

function buttonLabelled(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll("button")].find((b) => b.textContent === label);
}

const dialogPlugin = fakePlugin("demo.dialog", (host) => {
  host.ribbon.add({
    label: "デモ",
    icon: Circle,
    onClick: () => {
      host.dialogs.open({ title: "デモのダイアログ", render: () => <p data-testid="demo-body">中身</p> });
    },
  });
});

describe("plugin UI", () => {
  it("renders nothing in the slots when no plugin is registered", () => {
    mount([]);
    expect(document.querySelector('[data-testid="ribbon-slot"]')!.innerHTML).toBe("");
    expect(document.querySelector('[data-testid="status-slot"]')!.innerHTML).toBe("");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("shows a fake plugin's ribbon button, and pressing it opens its dialog in the existing Dialog frame", () => {
    mount([dialogPlugin]);
    const button = buttonLabelled("デモ");
    expect(button).toBeDefined();
    act(() => button!.click());
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("デモのダイアログ");
    expect(document.querySelector('[data-testid="demo-body"]')?.textContent).toBe("中身");
  });

  it("closes the plugin dialog with Escape", () => {
    mount([dialogPlugin]);
    act(() => buttonLabelled("デモ")!.click());
    const dialog = document.querySelector('[role="dialog"]')!;
    act(() => {
      dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(document.querySelector('[data-testid="demo-body"]')).toBeNull();
  });

  it("shows a status item", () => {
    mount([fakePlugin("demo.status", (host) => host.status.add({ render: () => "状態の表示" }))]);
    expect(document.querySelector('[data-testid="status-slot"]')!.textContent).toBe("状態の表示");
  });

  it("removes only the UI that threw while rendering, keeps the rest and reports the error", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const reported = mount([
      fakePlugin("demo.broken", (host) =>
        host.status.add({
          render: () => {
            throw new Error("render failed");
          },
        }),
      ),
      fakePlugin("demo.fine", (host) => host.status.add({ render: () => "残る表示" })),
      dialogPlugin,
    ]);
    expect(document.querySelector('[data-testid="status-slot"]')!.textContent).toBe("残る表示");
    expect(buttonLabelled("デモ")).toBeDefined();
    expect(reported).toContain("demo.broken: render failed");
  });

  it("removes a dialog's content that throws while rendering, reports it, and the app keeps running", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const throwing = fakePlugin("demo.throwing-dialog", (host) => {
      host.ribbon.add({
        label: "壊れた",
        icon: Circle,
        onClick: () => {
          host.dialogs.open({
            title: "壊れたダイアログ",
            render: () => {
              throw new Error("dialog render failed");
            },
          });
        },
      });
    });
    const reported = mount([throwing, dialogPlugin]);
    act(() => buttonLabelled("壊れた")!.click());
    expect(reported).toContain("demo.throwing-dialog: dialog render failed");
    expect(buttonLabelled("デモ")).toBeDefined();
  });

  it("removes the whole dialog of a plugin whose dialog content throws, not only its content", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const throwing = fakePlugin("demo.throwing-dialog", (host) => {
      host.ribbon.add({
        label: "壊れた",
        icon: Circle,
        onClick: () => {
          host.dialogs.open({
            title: "壊れたダイアログ",
            render: () => {
              throw new Error("dialog render failed");
            },
          });
        },
      });
    });
    mount([throwing]);
    act(() => buttonLabelled("壊れた")!.click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("passes window keydown to the host once, so a plugin shortcut runs", () => {
    const run = vi.fn();
    mount([fakePlugin("demo.key", (host) => host.shortcuts.add({ key: "q", label: "q", kind: "harmless", run }))]);
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "q", bubbles: true, cancelable: true }));
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("deactivates the plugins on unmount", () => {
    const cleanup = vi.fn();
    mount([fakePlugin("demo.cleanup", () => cleanup)]);
    act(() => root!.unmount());
    root = null;
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
