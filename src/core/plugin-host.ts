import { createStore } from "../app/store";
import { createProgram } from "../app/tea";
import { isFormControl, isTypingTarget } from "../app/typing-target";
import { PLUGIN_API_VERSION, type DialogSpec, type PcvPlugin, type PluginHost, type RibbonItem, type Shortcut, type StatusItem } from "../plugin-api";
import type { GpuErrorSource } from "../renderer/gpu-error-log";

export interface Registered<T> {
  readonly key: number;
  readonly pluginId: string;
  readonly item: T;
}

export interface PluginHostState {
  readonly ribbon: readonly Registered<RibbonItem>[];
  readonly status: readonly Registered<StatusItem>[];
  readonly dialogs: readonly Registered<DialogSpec>[];
  readonly shortcuts: readonly Registered<Shortcut>[];
}

export interface ShortcutKeyEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  isComposing?: boolean;
  repeat?: boolean;
  target: unknown;
  preventDefault(): void;
}

export interface PluginHostDeps {
  reportError(message: string, source?: GpuErrorSource): void;
}

export interface PluginHostCore {
  getState(): PluginHostState;
  subscribe(listener: () => void): () => void;
  activate(plugins: readonly PcvPlugin[]): void;
  deactivate(pluginId: string): void;
  deactivateAll(): void;
  report(source: string, error: unknown): void;
  clickRibbonItem(entry: Registered<RibbonItem>): void;
  closeDialog(key: number): void;
  handleKeyDown(event: ShortcutKeyEvent): void;
}

const NO_REGISTRATIONS: PluginHostState = { ribbon: [], status: [], dialogs: [], shortcuts: [] };

export function pluginErrorMessage(source: string, error: unknown): string {
  const body = error instanceof Error ? error.message : String(error);
  return `${source}: ${body}`;
}

export function sameShortcutKey(a: string, b: string): boolean {
  const normalized = (key: string) => (key.length === 1 ? key.toUpperCase() : key);
  return normalized(a) === normalized(b);
}

export function shortcutBlockedByFocus(kind: Shortcut["kind"], target: unknown): boolean {
  return kind === "harmless" ? isTypingTarget(target) : isFormControl(target);
}

function withoutPlugin<T>(entries: readonly Registered<T>[], pluginId: string): readonly Registered<T>[] {
  return entries.some((e) => e.pluginId === pluginId) ? entries.filter((e) => e.pluginId !== pluginId) : entries;
}

export function createPluginHost(deps: PluginHostDeps): PluginHostCore {
  const store = createStore<PluginHostState>(NO_REGISTRATIONS);
  const active = new Map<string, () => void>();
  let nextKey = 1;

  function report(source: string, error: unknown): void {
    deps.reportError(pluginErrorMessage(source, error), "tool");
  }

  function change(next: (state: PluginHostState) => PluginHostState): void {
    store.set(next(store.get()));
  }

  function register<K extends keyof PluginHostState>(list: K, pluginId: string, item: PluginHostState[K][number]["item"]): number {
    const key = nextKey++;
    if (!active.has(pluginId)) return key;
    change((s) => ({ ...s, [list]: [...s[list], { key, pluginId, item }] }));
    return key;
  }

  function removeRegistrations(pluginId: string): void {
    change((s) => {
      const next = {
        ribbon: withoutPlugin(s.ribbon, pluginId),
        status: withoutPlugin(s.status, pluginId),
        dialogs: withoutPlugin(s.dialogs, pluginId),
        shortcuts: withoutPlugin(s.shortcuts, pluginId),
      };
      const unchanged = next.ribbon === s.ribbon && next.status === s.status && next.dialogs === s.dialogs && next.shortcuts === s.shortcuts;
      return unchanged ? s : next;
    });
  }

  function closeDialog(key: number): void {
    change((s) => (s.dialogs.some((d) => d.key === key) ? { ...s, dialogs: s.dialogs.filter((d) => d.key !== key) } : s));
  }

  function addShortcut(pluginId: string, shortcut: Shortcut): void {
    const taken = store.get().shortcuts.find((s) => sameShortcutKey(s.item.key, shortcut.key));
    if (taken) {
      report(pluginId, new Error(`ショートカット「${shortcut.key}」は ${taken.pluginId} が使っているので登録しませんでした`));
      return;
    }
    register("shortcuts", pluginId, shortcut);
  }

  function hostFor(pluginId: string): PluginHost {
    return {
      ribbon: { add: (item) => void register("ribbon", pluginId, item) },
      dialogs: {
        open(dialog) {
          const key = register("dialogs", pluginId, dialog);
          return { close: () => closeDialog(key) };
        },
      },
      status: { add: (item) => void register("status", pluginId, item) },
      shortcuts: { add: (shortcut) => addShortcut(pluginId, shortcut) },
      errors: { report },
      program: (init, update, effectFailed) =>
        createProgram(init, update, {
          effectFailed(error) {
            report(pluginId, error);
            return effectFailed(error);
          },
          report: (error) => report(pluginId, error),
        }),
    };
  }

  function activateOne(plugin: PcvPlugin): void {
    if (plugin.apiVersion !== PLUGIN_API_VERSION) {
      report(plugin.id, new Error(`apiVersion ${String(plugin.apiVersion)} に対応していないので読み込みませんでした（このアプリは ${PLUGIN_API_VERSION}）`));
      return;
    }
    if (active.has(plugin.id)) {
      report(plugin.id, new Error("同じ id のプラグインが既に読み込まれているので、後のものを読み込みませんでした"));
      return;
    }
    active.set(plugin.id, () => {});
    try {
      const cleanup = plugin.activate(hostFor(plugin.id));
      if (typeof cleanup === "function") active.set(plugin.id, cleanup);
    } catch (error) {
      active.delete(plugin.id);
      removeRegistrations(plugin.id);
      report(plugin.id, error);
    }
  }

  function deactivate(pluginId: string): void {
    const cleanup = active.get(pluginId);
    if (!cleanup) return;
    active.delete(pluginId);
    removeRegistrations(pluginId);
    try {
      cleanup();
    } catch (error) {
      report(pluginId, error);
    }
  }

  function runReported(pluginId: string, run: () => void): void {
    try {
      run();
    } catch (error) {
      report(pluginId, error);
    }
  }

  return {
    getState: store.get,
    subscribe: store.subscribe,
    activate(plugins) {
      for (const plugin of plugins) activateOne(plugin);
    },
    deactivate,
    deactivateAll() {
      for (const pluginId of [...active.keys()].reverse()) deactivate(pluginId);
    },
    report,
    clickRibbonItem: (entry) => runReported(entry.pluginId, () => entry.item.onClick()),
    closeDialog,
    handleKeyDown(event) {
      if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing || event.repeat) return;
      const entry = store.get().shortcuts.find((s) => sameShortcutKey(s.item.key, event.key));
      if (!entry || shortcutBlockedByFocus(entry.item.kind, event.target)) return;
      event.preventDefault();
      runReported(entry.pluginId, () => entry.item.run());
    },
  };
}
