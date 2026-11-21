import { createStore } from "../app/store";
import { createProgram } from "../app/tea";
import { isFormControl, isTypingTarget } from "../app/typing-target";
import { fitAllView, setViewProjection, showViewPreset, type ViewContext } from "../app/view";
import {
  PLUGIN_API_VERSION,
  type DialogSpec,
  type PcvPlugin,
  type PluginHost,
  type RibbonGroup,
  type RibbonHandle,
  type RibbonItem,
  type Shortcut,
  type ShortcutHandle,
  type StatusItem,
  type ViewApi,
  type LayersApi,
} from "../plugin-api";
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
  view: ViewContext;
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

export const APP_SHORTCUT_KEYS: readonly string[] = ["Delete", "Enter", "Escape", "Tab"];

const NO_REGISTRATIONS: PluginHostState = { ribbon: [], status: [], dialogs: [], shortcuts: [] };

const REFUSED_HANDLE: ShortcutHandle = { setEnabled: () => {} };

export function isEnabled(item: { enabled?: boolean }): boolean {
  return item.enabled !== false;
}

export function ribbonInGroup(ribbon: readonly Registered<RibbonItem>[], group: RibbonGroup): readonly Registered<RibbonItem>[] {
  return ribbon.filter((entry) => entry.item.group === group);
}

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
  const subscriptions = new Map<string, Set<() => void>>();
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

  function setEnabled(list: "ribbon" | "shortcuts", key: number, enabled: boolean): void {
    change((s) => {
      const entries: readonly Registered<RibbonItem | Shortcut>[] = s[list];
      const entry = entries.find((e) => e.key === key);
      if (!entry || isEnabled(entry.item) === enabled) return s;
      return { ...s, [list]: entries.map((e) => (e === entry ? { ...e, item: { ...e.item, enabled } } : e)) };
    });
  }

  function enabledHandle(list: "ribbon" | "shortcuts", key: number): RibbonHandle & ShortcutHandle {
    return { setEnabled: (enabled) => setEnabled(list, key, enabled) };
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

  function removeDialog(key: number): Registered<DialogSpec> | undefined {
    const entry = store.get().dialogs.find((d) => d.key === key);
    if (entry) change((s) => ({ ...s, dialogs: s.dialogs.filter((d) => d.key !== key) }));
    return entry;
  }

  function closeDialog(key: number): void {
    const entry = removeDialog(key);
    const onClose = entry?.item.onClose;
    if (entry && onClose) runReported(entry.pluginId, () => onClose.call(entry.item));
  }

  function addShortcut(pluginId: string, shortcut: Shortcut): ShortcutHandle {
    if (APP_SHORTCUT_KEYS.some((key) => sameShortcutKey(key, shortcut.key))) {
      report(pluginId, `ショートカット「${shortcut.key}」はアプリが使っているので登録しませんでした`);
      return REFUSED_HANDLE;
    }
    const taken = store.get().shortcuts.find((s) => sameShortcutKey(s.item.key, shortcut.key));
    if (taken) {
      report(pluginId, `ショートカット「${shortcut.key}」は ${taken.pluginId} が使っているので登録しませんでした`);
      return REFUSED_HANDLE;
    }
    return enabledHandle("shortcuts", register("shortcuts", pluginId, shortcut));
  }

  function subscribeReported(pluginId: string, subscribe: (listener: () => void) => () => void, listener: () => void): () => void {
    if (!active.has(pluginId)) return () => {};
    const stopListening = subscribe(() => runReported(pluginId, listener));
    const ofPlugin = subscriptions.get(pluginId) ?? new Set<() => void>();
    subscriptions.set(pluginId, ofPlugin);
    const unsubscribe = () => {
      if (!ofPlugin.delete(unsubscribe)) return;
      stopListening();
    };
    ofPlugin.add(unsubscribe);
    return unsubscribe;
  }

  function dropSubscriptions(pluginId: string): void {
    const ofPlugin = subscriptions.get(pluginId);
    subscriptions.delete(pluginId);
    for (const unsubscribe of ofPlugin ?? []) unsubscribe();
  }

  function layersFor(pluginId: string): LayersApi {
    return {
      hasPointCloud: () => deps.view.pointCloud.get(),
      subscribe: (listener) => subscribeReported(pluginId, deps.view.pointCloud.subscribe, listener),
    };
  }

  function viewFor(pluginId: string): ViewApi {
    return {
      get: () => deps.view.state.get(),
      subscribe: (listener) => subscribeReported(pluginId, deps.view.state.subscribe, listener),
      fitAll: () => void fitAllView(deps.view),
      showPreset: (id) => void showViewPreset(deps.view, id),
      setProjection: (mode) => setViewProjection(deps.view, mode),
    };
  }

  function hostFor(pluginId: string): PluginHost {
    return {
      ribbon: { add: (item) => enabledHandle("ribbon", register("ribbon", pluginId, item)) },
      dialogs: {
        open(dialog) {
          const key = register("dialogs", pluginId, dialog);
          return { close: () => void removeDialog(key) };
        },
      },
      status: { add: (item) => void register("status", pluginId, item) },
      shortcuts: { add: (shortcut) => addShortcut(pluginId, shortcut) },
      errors: { report },
      layers: layersFor(pluginId),
      view: viewFor(pluginId),
      program: (init, update, effectFailed) =>
        createProgram(init, update, {
          effectFailed(error) {
            const msg = effectFailed(error);
            report(pluginId, error);
            return msg;
          },
          report: (error) => report(pluginId, error),
        }),
    };
  }

  function activateOne(plugin: PcvPlugin): void {
    if (plugin.apiVersion !== PLUGIN_API_VERSION) {
      report(plugin.id, `apiVersion ${String(plugin.apiVersion)} に対応していないので読み込みませんでした（このアプリは ${PLUGIN_API_VERSION}）`);
      return;
    }
    if (active.has(plugin.id)) {
      report(plugin.id, "同じ id のプラグインが既に読み込まれているので、後のものを読み込みませんでした");
      return;
    }
    active.set(plugin.id, () => {});
    try {
      const cleanup = plugin.activate(hostFor(plugin.id));
      if (typeof cleanup === "function") active.set(plugin.id, cleanup);
    } catch (error) {
      active.delete(plugin.id);
      removeRegistrations(plugin.id);
      dropSubscriptions(plugin.id);
      report(plugin.id, error);
    }
  }

  function deactivate(pluginId: string): void {
    const cleanup = active.get(pluginId);
    if (!cleanup) return;
    active.delete(pluginId);
    removeRegistrations(pluginId);
    dropSubscriptions(pluginId);
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
    clickRibbonItem(entry) {
      if (!isEnabled(entry.item)) return;
      runReported(entry.pluginId, () => entry.item.onClick());
    },
    closeDialog,
    handleKeyDown(event) {
      if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing || event.repeat) return;
      const entry = store.get().shortcuts.find((s) => sameShortcutKey(s.item.key, event.key));
      if (!entry || !isEnabled(entry.item) || shortcutBlockedByFocus(entry.item.kind, event.target)) return;
      event.preventDefault();
      runReported(entry.pluginId, () => entry.item.run());
    },
  };
}
