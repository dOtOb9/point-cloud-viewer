import { describe, expect, it, vi } from "vitest";
import { VIEW_SHORTCUTS } from "../app/view";
import { APP_SHORTCUT_KEYS, createPluginHost } from "./plugin-host";

const SOURCES = import.meta.glob(["../**/*.{ts,tsx}", "!../wasm/**", "!../**/*.test.{ts,tsx}", "!./plugin-host.ts"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

function keysComparedInSource(): string[] {
  const keys = new Set<string>();
  for (const text of Object.values(SOURCES)) {
    for (const match of text.matchAll(/\b(?:e|event|input)\.key\s*[!=]==?\s*"([^"]+)"/g)) keys.add(match[1]);
  }
  return [...keys];
}

describe("keys the app already uses are not given to plugins", () => {
  it("lists every view shortcut key", () => {
    for (const { key } of VIEW_SHORTCUTS) expect(APP_SHORTCUT_KEYS).toContain(key);
  });

  it("lists every key the app compares in a key handler (Delete, Enter, Escape, Tab)", () => {
    const found = keysComparedInSource();
    expect(found).toEqual(expect.arrayContaining(["Delete", "Enter", "Escape", "Tab"]));
    for (const key of found) expect(APP_SHORTCUT_KEYS).toContain(key);
  });

  it.each([...APP_SHORTCUT_KEYS, "f"])("refuses a plugin shortcut on %s and reports it", (key) => {
    const reported: string[] = [];
    const host = createPluginHost({ reportError: (message) => reported.push(message) });
    const run = vi.fn();
    host.activate([{ id: "a", name: "a", apiVersion: 1, activate: (h) => h.shortcuts.add({ key, label: key, kind: "harmless", run }) }]);
    expect(host.getState().shortcuts).toEqual([]);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatch(/^a: /);
  });
});
