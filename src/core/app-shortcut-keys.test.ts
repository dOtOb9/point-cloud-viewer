import { describe, expect, it, vi } from "vitest";
import { createViewContext } from "../app/view";
import { viewPlugin } from "../plugins/view";
import { APP_SHORTCUT_KEYS, createPluginHost } from "./plugin-host";

const RAW = import.meta.glob(["../**/*.{ts,tsx}", "!../wasm/**", "!../**/*.test.{ts,tsx}", "!./plugin-host.ts"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const SOURCES: [string, string][] = Object.entries(RAW).map(([path, text]) => [
  path.startsWith("./") ? "src/core/" + path.slice(2) : "src/" + path.slice(3),
  text,
]);

const KEYBOARD_FILES = [
  "src/state/useLayerTool.ts",
  "src/state/useMeasureTool.ts",
  "src/ui/dialogs/Dialog.tsx",
  "src/ui/layers/LayerActions.tsx",
  "src/ui/layers/LayerContextMenu.tsx",
  "src/ui/layers/LayerList.tsx",
  "src/ui/layers/layer-delete-key.ts",
  "src/ui/plugins/usePluginHost.ts",
];

const VIEW_KEYS = ["F", "1", "2", "3", "4", "5", "6", "7"];

const KEY = String.raw`(?:[\w$]+\.)*key`;

function handlesKeyboard(text: string): boolean {
  return /keydown|onKeyDown|KeyboardEvent|ctrlKey/.test(text);
}

function stringsIn(text: string): string[] {
  return [...text.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

function blockAfter(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(open, i);
  }
  return text.slice(open);
}

function keysComparedIn(text: string): string[] {
  const keys: string[] = [];
  for (const m of text.matchAll(new RegExp(String.raw`\b${KEY}\s*[!=]==?\s*"([^"]+)"`, "g"))) keys.push(m[1]);
  for (const m of text.matchAll(new RegExp(String.raw`"([^"]+)"\s*[!=]==?\s*${KEY}\b`, "g"))) keys.push(m[1]);
  for (const m of text.matchAll(new RegExp(String.raw`\[([^\]]*)\]\s*\.includes\(\s*${KEY}\s*\)`, "g"))) keys.push(...stringsIn(m[1]));
  for (const m of text.matchAll(new RegExp(String.raw`switch\s*\(\s*${KEY}\s*\)\s*\{`, "g"))) {
    const block = blockAfter(text, m.index + m[0].length - 1);
    for (const c of block.matchAll(/case\s+"([^"]+)"\s*:/g)) keys.push(c[1]);
  }
  return keys;
}

function keyLookupsWithoutLiterals(text: string): string[] {
  const lookups = [...text.matchAll(new RegExp(String.raw`([\w$.\]]+)\.(?:includes|has)\(\s*${KEY}\s*\)`, "g"))].map((m) => m[0]);
  return lookups.filter((lookup) => !lookup.startsWith("]"));
}

function keyCodeUses(text: string): string[] {
  return [...text.matchAll(/[\w$]+\.code\b|\bcode\s*[!=]==?/g)].map((m) => m[0]);
}

describe("the scanner finds every way a key handler names a key", () => {
  it.each([
    ['if (e.key === "Escape") close();', ["Escape"]],
    ['if (ev.key !== "Insert") return;', ["Insert"]],
    ['const { key } = e; if (key === "PageUp") up();', ["PageUp"]],
    ['if ("End" === event.key) end();', ["End"]],
    ['if (["Home", "End"].includes(e.key)) jump();', ["Home", "End"]],
    ['switch (e.key) {\n  case "Backspace":\n    back();\n    break;\n  case "x": {\n    x();\n  }\n}\nswitch (mode) { case "draw": break; }', ["Backspace", "x"]],
    ["VIEW_SHORTCUTS.find((s) => s.key === key);", []],
    ['switch (e.key) {\r\n  case "Home":\r\n    home();\r\n}\r\nif (e.key === "End") end();\r\n', ["End", "Home"]],
  ])("keysComparedIn(%s)", (code, keys) => {
    expect(keysComparedIn(code)).toEqual(keys);
  });

  it("finds key lookups through a named list or set, and any use of event.code", () => {
    expect(keyLookupsWithoutLiterals("if (KEYS.has(e.key)) x();")).toEqual(["KEYS.has(e.key)"]);
    expect(keyLookupsWithoutLiterals('if (["a"].includes(e.key)) x();')).toEqual([]);
    expect(keyCodeUses('if (e.code === "KeyQ") q();')).toEqual(["e.code"]);
    expect(keyCodeUses('const { code } = e; if (code === "KeyQ") q();')).toEqual(["code ==="]);
  });
});

describe("keys the app already uses are not given to plugins", () => {
  it("knows which files handle the keyboard (a new one needs a look: add its keys to APP_SHORTCUT_KEYS)", () => {
    expect(SOURCES.filter(([, text]) => handlesKeyboard(text)).map(([path]) => path).sort()).toEqual(KEYBOARD_FILES);
  });

  it("leaves the view keys to the pcv.view plugin instead of keeping them for the app", () => {
    for (const key of VIEW_KEYS) expect(APP_SHORTCUT_KEYS).not.toContain(key);
  });

  it("lists every key named in a keyboard file: comparisons with any variable, reversed, in a literal list, or a switch case", () => {
    const found = SOURCES.filter(([path]) => KEYBOARD_FILES.includes(path)).flatMap(([, text]) => keysComparedIn(text));
    expect(found).toEqual(expect.arrayContaining(["Delete", "Enter", "Escape", "Tab"]));
    for (const key of found) expect(APP_SHORTCUT_KEYS).toContain(key);
  });

  it("finds no key lookup through a named list and no event.code in a keyboard file (the scan could not read those keys)", () => {
    const keyboard = SOURCES.filter(([path]) => KEYBOARD_FILES.includes(path));
    expect(keyboard.flatMap(([path, text]) => keyLookupsWithoutLiterals(text).map((l) => `${path}: ${l}`))).toEqual([]);
    expect(keyboard.flatMap(([path, text]) => keyCodeUses(text).map((c) => `${path}: ${c}`))).toEqual([]);
  });

  it.each(APP_SHORTCUT_KEYS)("refuses a plugin shortcut on %s and reports it", (key) => {
    const reported: string[] = [];
    const host = createPluginHost({ reportError: (message) => reported.push(message), view: createViewContext() });
    const run = vi.fn();
    host.activate([{ id: "a", name: "a", apiVersion: 1, activate: (h) => void h.shortcuts.add({ key, label: key, kind: "harmless", run }) }]);
    expect(host.getState().shortcuts).toEqual([]);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatch(/^a: /);
  });
});

describe("the view keys belong to the pcv.view plugin", () => {
  function hostWithViewPlugin() {
    const reported: string[] = [];
    const host = createPluginHost({ reportError: (message) => reported.push(message), view: createViewContext() });
    host.activate([viewPlugin]);
    return { host, reported };
  }

  it("pcv.view registers F and 1 to 7 as harmless shortcuts", () => {
    const { host, reported } = hostWithViewPlugin();
    const viewShortcuts = host.getState().shortcuts.filter((s) => s.pluginId === "pcv.view");
    expect(viewShortcuts.map((s) => s.item.key)).toEqual(VIEW_KEYS);
    expect(viewShortcuts.every((s) => s.item.kind === "harmless")).toBe(true);
    expect(reported).toEqual([]);
  });

  it.each([...VIEW_KEYS, "f"])("another plugin cannot take %s, and it is reported under that plugin's id", (key) => {
    const { host, reported } = hostWithViewPlugin();
    const run = vi.fn();
    host.activate([{ id: "other", name: "other", apiVersion: 1, activate: (h) => void h.shortcuts.add({ key, label: key, kind: "harmless", run }) }]);
    expect(host.getState().shortcuts.filter((s) => s.pluginId === "other")).toEqual([]);
    expect(reported).toEqual([`other: ショートカット「${key}」は pcv.view が使っているので登録しませんでした`]);
  });
});
