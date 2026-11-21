// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Circle } from "lucide-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PcvPlugin, PluginHost, RibbonHandle } from "../../plugin-api";
import { createViewContext } from "../../app/view";
import { createPluginHost, type PluginHostCore, type PluginHostState } from "../../core/plugin-host";
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
  const host: PluginHostCore = usePluginHost(plugins, { reportError, view: createViewContext() });
  return (
    <div>
      <div data-testid="ribbon-slot">
        <PluginRibbonItems host={host} group="view" />
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
    group: "view",
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
        group: "view",
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
        group: "view",
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
    mount([fakePlugin("demo.key", (host) => void host.shortcuts.add({ key: "q", label: "q", kind: "harmless", run }))]);
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

  it("grays out a disabled ribbon button with its disabled title, and enables the same button in place", () => {
    let handle: RibbonHandle | null = null;
    const onClick = vi.fn();
    mount([
      fakePlugin("demo.enabled", (host) => {
        handle = host.ribbon.add({
          group: "view",
          label: "切替",
          icon: Circle,
          title: "押せる",
          disabledTitle: "まだ押せない",
          enabled: false,
          testId: "demo-button",
          onClick,
        });
      }),
    ]);
    const button = document.querySelector<HTMLButtonElement>('[data-testid="demo-button"]')!;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe("まだ押せない");
    act(() => handle!.setEnabled(true));
    expect(document.querySelector('[data-testid="demo-button"]')).toBe(button);
    expect(button.disabled).toBe(false);
    expect(button.title).toBe("押せる");
    act(() => button.click());
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("a plugin is told once when the host closes its dialog", () => {
  function closingPlugin(onClose: () => void, render: () => unknown = () => <p data-testid="demo-body">中身</p>) {
    return fakePlugin("demo.closing", (host) => void host.dialogs.open({ title: "閉じるデモ", render: render as () => null, onClose }));
  }

  it("on Escape", () => {
    const onClose = vi.fn();
    mount([closingPlugin(onClose)]);
    act(() => {
      document.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("on a click outside the frame", () => {
    const onClose = vi.fn();
    mount([closingPlugin(onClose)]);
    const backdrop = document.querySelector('[role="dialog"]')!.parentElement!;
    act(() => {
      backdrop.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      backdrop.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("when its content throws and the host closes it", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const onClose = vi.fn();
    const reported = mount([closingPlugin(onClose, throwingRender)]);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(reported).toContain("demo.closing: render failed");
  });

  it("on the footer close button the plugin asked for", () => {
    const onClose = vi.fn();
    mount([fakePlugin("demo.footer", (host) => void host.dialogs.open({ title: "フッター", closeButtonLabel: "閉じる", render: () => "中身", onClose }))]);
    act(() => buttonLabelled("閉じる")!.click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("the frame of a plugin dialog", () => {
  it("has no footer unless the plugin asks for a close button", () => {
    mount([fakePlugin("demo.plain", (host) => void host.dialogs.open({ title: "なし", render: () => "中身" }))]);
    expect(document.querySelector('[role="dialog"]')!.querySelectorAll("button")).toHaveLength(0);
  });

  it("is narrow when the plugin asks for it, and the normal width otherwise", () => {
    mount([
      fakePlugin("demo.widths", (host) => {
        host.dialogs.open({ title: "狭い", width: "narrow", placement: "side", render: () => "a" });
        host.dialogs.open({ title: "普通", render: () => "b" });
      }),
    ]);
    const [narrow, normal] = [...document.querySelectorAll('[role="dialog"]')];
    expect(narrow.className).toContain("max-w-xs");
    expect(normal.className).toContain("max-w-lg");
  });
});

function throwingRender(): never {
  throw new Error("render failed");
}

const THROWING_UI_BY_PLACE: Record<Exclude<keyof PluginHostState, "shortcuts">, (host: PluginHost) => void> = {
  ribbon: (host) => void host.ribbon.add({ group: "view", label: "壊れたアイコン", icon: throwingRender, onClick: () => {} }),
  status: (host) => host.status.add({ render: throwingRender }),
  dialogs: (host) => void host.dialogs.open({ title: "壊れたダイアログ", render: throwingRender }),
};

describe("a plugin UI that throws leaves nothing behind, in every place the host draws", () => {
  it("covers every drawn list of the host state (a new place must be added here)", () => {
    const drawn = Object.keys(createPluginHost({ reportError: () => {}, view: createViewContext() }).getState()).filter((k) => k !== "shortcuts");
    expect(drawn.sort()).toEqual(Object.keys(THROWING_UI_BY_PLACE).sort());
  });

  it.each(Object.entries(THROWING_UI_BY_PLACE))("%s: the whole frame goes and the error is reported", (_place, register) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mount([]);
    const empty = container.innerHTML;
    act(() => root!.unmount());
    root = null;
    container.innerHTML = "";
    const reported = mount([fakePlugin("demo.broken", register)]);
    expect(container.innerHTML).toBe(empty);
    expect(reported).toContain("demo.broken: render failed");
  });
});
