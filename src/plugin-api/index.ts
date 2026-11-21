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

export interface PluginHost {
  ribbon: { add(item: RibbonItem): RibbonHandle };
  dialogs: { open(dialog: DialogSpec): DialogHandle };
  status: { add(item: StatusItem): void };
  shortcuts: { add(shortcut: Shortcut): ShortcutHandle };
  errors: { report(source: string, error: unknown): void };
  program<Model, Msg>(init: Model, update: Update<Model, Msg>, effectFailed: EffectFailed<Msg>): Program<Model, Msg>;
}

export interface PcvPlugin {
  id: string;
  name: string;
  apiVersion: typeof PLUGIN_API_VERSION;
  activate(host: PluginHost): void | (() => void);
}
