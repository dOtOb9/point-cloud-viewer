import type { EffectFailed, Program, Update } from "../app/tea";

export type { Dispatch, Effect, EffectFailed, Program, Update } from "../app/tea";

export const PLUGIN_API_VERSION = 1;

export type ViewNode = object | string | number | boolean | null | undefined;
export type IconComponent = object;

export type RibbonGroup = "view";

export interface RibbonItem {
  label: string;
  icon: IconComponent;
  group: RibbonGroup;
  title?: string;
  enabled?: boolean;
  disabledTitle?: string;
  testId?: string;
  onClick(): void;
}

export interface RibbonHandle {
  setEnabled(enabled: boolean): void;
}

export interface StatusItem {
  render(): ViewNode;
}

export type DialogWidth = "normal" | "narrow";

export interface DialogSpec {
  title: string;
  placement?: "center" | "side";
  width?: DialogWidth;
  closeButtonLabel?: string;
  render(): ViewNode;
  onClose?(): void;
}

export interface DialogHandle {
  close(): void;
}

export type ShortcutKind = "harmless" | "irreversible";

export interface Shortcut {
  key: string;
  label: string;
  kind: ShortcutKind;
  enabled?: boolean;
  run(): void;
}

export interface ShortcutHandle {
  setEnabled(enabled: boolean): void;
}

export interface LayersApi {
  hasPointCloud(): boolean;
  subscribe(listener: () => void): () => void;
}

export type ProjectionMode = "perspective" | "orthographic";

export type ViewPresetId = "top" | "front" | "back" | "left" | "right" | "isometric";

export const VIEW_PRESET_IDS: readonly ViewPresetId[] = ["top", "front", "back", "left", "right", "isometric"];

export interface ViewState {
  readonly projection: ProjectionMode;
  readonly preset: ViewPresetId | null;
  readonly rendererHasLayers: boolean;
}

export interface ViewApi {
  get(): ViewState;
  subscribe(listener: () => void): () => void;
  fitAll(): void;
  showPreset(id: ViewPresetId): void;
  setProjection(mode: ProjectionMode): void;
}

export interface PluginHost {
  ribbon: { add(item: RibbonItem): RibbonHandle };
  dialogs: { open(dialog: DialogSpec): DialogHandle };
  status: { add(item: StatusItem): void };
  shortcuts: { add(shortcut: Shortcut): ShortcutHandle };
  errors: { report(source: string, error: unknown): void };
  layers: LayersApi;
  view: ViewApi;
  program<Model, Msg>(init: Model, update: Update<Model, Msg>, effectFailed: EffectFailed<Msg>): Program<Model, Msg>;
}

export interface PcvPlugin {
  id: string;
  name: string;
  apiVersion: typeof PLUGIN_API_VERSION;
  activate(host: PluginHost): void | (() => void);
}
