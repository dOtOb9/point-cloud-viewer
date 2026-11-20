import type { EffectFailed, Program, Update } from "../app/tea";

export type { Dispatch, Effect, EffectFailed, Program, Update } from "../app/tea";

export const PLUGIN_API_VERSION = 1;

export type ViewNode = object | string | number | boolean | null | undefined;
export type IconComponent = object;

export interface RibbonItem {
  label: string;
  icon: IconComponent;
  title?: string;
  onClick(): void;
}

export interface StatusItem {
  render(): ViewNode;
}

export interface DialogSpec {
  title: string;
  placement?: "center" | "side";
  render(): ViewNode;
}

export interface DialogHandle {
  close(): void;
}

export type ShortcutKind = "harmless" | "irreversible";

export interface Shortcut {
  key: string;
  label: string;
  kind: ShortcutKind;
  run(): void;
}

export interface PluginHost {
  ribbon: { add(item: RibbonItem): void };
  dialogs: { open(dialog: DialogSpec): DialogHandle };
  status: { add(item: StatusItem): void };
  shortcuts: { add(shortcut: Shortcut): void };
  errors: { report(source: string, error: unknown): void };
  program<Model, Msg>(init: Model, update: Update<Model, Msg>, effectFailed: EffectFailed<Msg>): Program<Model, Msg>;
}

export interface PcvPlugin {
  id: string;
  name: string;
  apiVersion: typeof PLUGIN_API_VERSION;
  activate(host: PluginHost): void | (() => void);
}
