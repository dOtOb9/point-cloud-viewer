// @vitest-environment node
import { ESLint } from "eslint";
import { beforeAll, describe, expect, it } from "vitest";

let eslint: ESLint;

beforeAll(() => {
  eslint = new ESLint();
});

async function layerMessages(filePath: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return result.messages
    .filter((m) => m.ruleId === "no-restricted-imports" || m.ruleId === "no-restricted-syntax")
    .map((m) => m.message);
}

describe("rule 2: Tauri packages only in src/datasource/tauri.ts", () => {
  it("allows them in tauri.ts", async () => {
    expect(await layerMessages("src/datasource/tauri.ts", 'import { invoke } from "@tauri-apps/api/core";')).toEqual([]);
  });

  it.each([
    ["src/datasource/update-check.ts", 'import { openUrl } from "@tauri-apps/plugin-opener";'],
    ["src/ui/shell/X.tsx", 'import { open } from "@tauri-apps/plugin-dialog";'],
    ["src/state/useX.ts", 'import { invoke } from "@tauri-apps/api/core";'],
    ["src/app/x.ts", 'import { invoke } from "@tauri-apps/api/core";'],
    ["src/renderer/x.ts", 'import { invoke } from "@tauri-apps/api/core";'],
  ])("rejects them in %s", async (filePath, code) => {
    expect(await layerMessages(filePath, code)).toHaveLength(1);
  });

  it("does not fail on a comment that names the package", async () => {
    const code = "// @tauri-apps/api is only imported by tauri.ts\nexport const x = 1;\n";
    expect(await layerMessages("src/app/x.ts", code)).toEqual([]);
  });
});

describe("rule 3 and 5: React and hooks", () => {
  it.each(["src/app/x.ts", "src/renderer/x.ts"])("rejects react in %s", async (filePath) => {
    expect(await layerMessages(filePath, 'import { useState } from "react";')).toHaveLength(1);
    expect(await layerMessages(filePath, 'import { createRoot } from "react-dom/client";')).toHaveLength(1);
  });

  it("allows react in src/ui and src/state", async () => {
    expect(await layerMessages("src/ui/x.tsx", 'import { useState } from "react";')).toEqual([]);
    expect(await layerMessages("src/state/useX.ts", 'import { useState } from "react";')).toEqual([]);
  });

  it("rejects a state hook in src/app, even as a type import", async () => {
    expect(await layerMessages("src/app/x.ts", 'import type { Layers } from "../state/useLayers";')).toHaveLength(1);
    expect(await layerMessages("src/app/x.ts", 'import { useStore } from "../state/useStore";')).toHaveLength(1);
  });

  it("allows the React-free modules of src/state in src/app", async () => {
    expect(await layerMessages("src/app/x.ts", 'import { findLayer } from "../state/layers";')).toEqual([]);
  });

  it("rejects JSX in src/app and src/renderer", async () => {
    expect(await layerMessages("src/app/x.tsx", "export const a = <div />;")).toHaveLength(1);
    expect(await layerMessages("src/renderer/x.tsx", "export const a = <></>;")).toHaveLength(1);
  });

  it.each([
    ["a store created at the top of the module", 'import { createStore } from "./store";\nexport const blocked = createStore(null);'],
    ["an unexported store created at the top of the module", 'import { createStore } from "./store";\nconst blocked = createStore(null);'],
    ["a let at the top of the module", "export let current = 0;"],
    ["a var at the top of the module", "var current = 0;"],
  ])("rejects module state in src/app: %s", async (_name, code) => {
    expect(await layerMessages("src/app/x.ts", code)).toHaveLength(1);
  });

  it.each([
    ["a store cast with as", 'import { createStore, type Store } from "./store";\nexport const blocked = createStore(null) as Store<null>;'],
    ["a store inside an object literal", 'import { createStore } from "./store";\nexport const ctx = { blocked: createStore(null) };'],
    ["a default-exported store", 'import { createStore } from "./store";\nexport default createStore(null);'],
    ["a store through a namespace import", 'import * as store from "./store";\nexport const blocked = store.createStore(null);'],
  ])("rejects module state in src/app written another way: %s", async (_name, code) => {
    expect(await layerMessages("src/app/x.ts", code)).toHaveLength(1);
  });

  it.each([
    ["a store wrapped in Object.freeze", 'import { createStore } from "./store";\nexport const blocked = Object.freeze(createStore(null));'],
    ["createStore imported under another name", 'import { createStore as make } from "./store";\nexport function f() {\n  return make(null);\n}'],
  ])("rejects module state in src/app hidden behind a call or a rename: %s", async (_name, code) => {
    expect(await layerMessages("src/app/x.ts", code)).toHaveLength(1);
  });

  it("still applies the layer rules to test files in src/app", async () => {
    expect(await layerMessages("src/app/x.test.ts", 'import { useState } from "react";')).toHaveLength(1);
  });

  it("allows a top-level let in a test file in src/app", async () => {
    const code = 'import { beforeEach, expect, it } from "vitest";\nlet count = 0;\nbeforeEach(() => {\n  count = 1;\n});\nit("x", () => {\n  expect(count).toBe(1);\n});';
    expect(await layerMessages("src/app/x.test.ts", code)).toEqual([]);
  });

  it("allows a store created inside a function in src/app, and module state outside src/app", async () => {
    const factory =
      'import { createStore } from "./store";\nexport function createBlocked() {\n  let made = createStore(null);\n  return made;\n}';
    expect(await layerMessages("src/app/x.ts", factory)).toEqual([]);
    expect(await layerMessages("src/app/x.ts", "export const LIMIT = 3;")).toEqual([]);
    expect(await layerMessages("src/state/useX.ts", "let current = 0;\nexport const read = () => current;")).toEqual([]);
  });

  it("rejects the PointCloudRenderer class in src/ui but allows its pure helpers", async () => {
    const cls = 'import { PointCloudRenderer } from "../../renderer/point-cloud-renderer";';
    expect(await layerMessages("src/ui/tools/X.tsx", cls)).toHaveLength(1);
    expect(await layerMessages("src/ui/tools/X.tsx", 'import { projectPoint } from "../../renderer/screen-project";')).toEqual([]);
    expect(await layerMessages("src/state/useX.ts", cls)).toEqual([]);
  });
});

describe("ADR-0023: what src/plugins/** may import", () => {
  it.each([
    ["src/plugins/demo/index.ts", 'import { definePlugin } from "../../plugin-api";'],
    ["src/plugins/demo/index.ts", 'import { Button } from "../../ui/kit/Button";'],
    ["src/plugins/demo/index.ts", 'import { update } from "./model";'],
    ["src/plugins/demo/index.ts", 'import { useState } from "react";'],
    ["src/plugins/demo/index.ts", 'import { Ruler } from "lucide-react";'],
    ["src/plugins/demo/view/Panel.tsx", 'import { update } from "../model";'],
    ["src/plugins/demo/view/Panel.tsx", 'import type { Host } from "../../../plugin-api";'],
    ["src/plugins/demo/view/Panel.tsx", 'import { Button } from "../../../ui/kit";'],
    ["src/plugins/demo/model.test.ts", 'import { expect } from "vitest";'],
    ["src/plugins/builtin.ts", 'import demo from "./demo";'],
    ["src/plugins/builtin.ts", 'import type { PcvPlugin } from "../plugin-api";'],
  ])("allows %s: %s", async (filePath, code) => {
    expect(await layerMessages(filePath, code)).toEqual([]);
  });

  it.each([
    ["src/plugins/demo/index.ts", 'import { openFiles } from "../../app/open-files";'],
    ["src/plugins/demo/index.ts", 'import { projectPoint } from "../../renderer/screen-project";'],
    ["src/plugins/demo/index.ts", 'import { Dialog } from "../../ui/dialogs/Dialog";'],
    ["src/plugins/demo/index.ts", 'import { x } from "../other/model";'],
    ["src/plugins/demo/index.ts", 'import { chunk } from "lodash";'],
    ["src/plugins/demo/index.ts", 'import { invoke } from "@tauri-apps/api/core";'],
    ["src/plugins/demo/index.ts", 'import { createRoot } from "react-dom/client";'],
    ["src/plugins/demo/index.ts", 'import { x } from "../../plugin-api-internal/x";'],
    ["src/plugins/demo/view/Panel.tsx", 'import { x } from "../../other/model";'],
    ["src/plugins/demo/view/Panel.tsx", 'import { openFiles } from "../../../app/open-files";'],
    ["src/plugins/demo/view/Panel.tsx", 'import { x } from "../../plugin-api";'],
    ["src/plugins/demo/index.ts", 'import { expect } from "vitest";'],
    ["src/plugins/builtin.ts", 'import { x } from "../app/open-files";'],
  ])("rejects %s: %s", async (filePath, code) => {
    expect(await layerMessages(filePath, code)).not.toEqual([]);
  });
});

describe("audit RF-1 R1: other forms of import", () => {
  it.each([
    ["src/ui/x.ts", 'export const f = () => import("@tauri-apps/plugin-opener");'],
    ["src/app/x.ts", 'export const f = () => import("react");'],
    ["src/app/x.ts", 'export const f = () => import("../state/useLayers");'],
    ["src/ui/x.ts", 'export const f = () => import("../renderer/point-cloud-renderer");'],
    ["src/plugins/demo/index.ts", 'export const f = () => import("../../app/open-files");'],
  ])("F-1 rejects a dynamic import in %s: %s", async (filePath, code) => {
    expect(await layerMessages(filePath, code)).not.toEqual([]);
  });

  it.each([
    ["src/app/x.ts", 'export type A = import("../state/useLayers").Layers;'],
    ["src/ui/x.ts", 'export type A = import("../renderer/point-cloud-renderer").PointCloudRenderer;'],
  ])("F-2 rejects an import() type in %s: %s", async (filePath, code) => {
    expect(await layerMessages(filePath, code)).not.toEqual([]);
  });

  it.each([
    'import { PointCloudRenderer } from "../../renderer/point-cloud-renderer.ts";',
    'import { PointCloudRenderer } from "../../renderer/point-cloud-renderer.js";',
  ])("F-3 rejects the PointCloudRenderer class with a file extension in src/ui: %s", async (code) => {
    expect(await layerMessages("src/ui/tools/X.tsx", code)).not.toEqual([]);
  });
});

describe("RF-1 R2: case, unnormalized paths and plain JavaScript", () => {
  it("F-4 matches the hook pattern case-sensitively: state/user-settings is not a hook", async () => {
    expect(await layerMessages("src/app/x.ts", 'import { x } from "../state/user-settings";')).toEqual([]);
  });

  it.each([
    ["src/plugins/demo/index.ts", 'import { x } from "./../../../app/x";'],
    ["src/plugins/demo/index.ts", 'import { x } from "../y/../../../app/x";'],
    ["src/plugins/demo/index.ts", 'import { x } from "../../plugin-api/../app/x";'],
    ["src/plugins/demo/index.ts", 'import { x } from "../..";'],
    ["src/plugins/a/b/c/d/e/f/g/h/i/x.ts", 'import { chunk } from "lodash";'],
    ["src/app/x.ts", 'import { x } from "../state/./useLayers";'],
  ])("F-5 rejects %s: %s", async (filePath, code) => {
    expect(await layerMessages(filePath, code)).not.toEqual([]);
  });

  it("F-6 checks plain JavaScript files too, but not the generated wasm glue", async () => {
    expect(await layerMessages("src/zz.js", 'import { invoke } from "@tauri-apps/api/core";')).not.toEqual([]);
    expect(await layerMessages("src/ui/zz.mjs", 'import { invoke } from "@tauri-apps/api/core";')).not.toEqual([]);
    expect(await layerMessages("src/wasm/pcv-wasm/x.js", 'import { invoke } from "@tauri-apps/api/core";')).toEqual([]);
  });
});

describe("everything the old CI greps caught is still caught", () => {
  const tauri = [
    'import { invoke } from "@tauri-apps/api/core";',
    'import "@tauri-apps/api";',
    "import { invoke } from '@tauri-apps/api/core';",
    'import type { UnlistenFn } from "@tauri-apps/api/event";',
    'export * from "@tauri-apps/api/core";',
    'export { listen } from "@tauri-apps/api/event";',
    'export const f = () => import("@tauri-apps/api/core");',
    'const t = require("@tauri-apps/api/core");',
    'export type A = import("@tauri-apps/api/event").UnlistenFn;',
  ];
  const tauriFiles = [
    "src/datasource/update-check.ts",
    "src/state/useX.ts",
    "src/ui/shell/X.tsx",
    "src/app/x.ts",
    "src/renderer/x.ts",
    "src/zz.js",
    "src/zz.mjs",
  ];
  it.each(tauriFiles.flatMap((file) =>
      tauri.filter((code) => !/\.m?js$/.test(file) || !/import type|\)\.Unlisten/.test(code)).map((code) => [file, code]),
    ))("rule 2 in %s: %s", async (filePath, code) => {
    expect(await layerMessages(filePath, code)).not.toEqual([]);
  });

  const react = [
    'import React from "react";',
    "import { useState } from 'react';",
    'import "react-dom";',
    'import { createRoot } from "react-dom/client";',
    'import type { ReactNode } from "react";',
    'export { useState } from "react";',
    'export * from "react-dom/client";',
    'export const f = () => import("react");',
    'const r = require("react");',
  ];
  it.each(["src/app/x.ts", "src/renderer/x.ts"].flatMap((file) => react.map((code) => [file, code])))(
    "rule 3/5 react in %s: %s",
    async (filePath, code) => {
      expect(await layerMessages(filePath, code)).not.toEqual([]);
    },
  );

  const hooks = [
    'import { useLayers } from "../state/useLayers";',
    'import type { Layers } from "../state/useLayers";',
    'import "../state/useStore";',
    'export * from "../state/useStore";',
    'export type { Layers } from "../state/useLayers";',
    'export const f = () => import("../state/useLayers");',
    'import { useX } from "../../state/useCopcViewer";',
  ];
  it.each(hooks)("rule 5 state hook in src/app: %s", async (code) => {
    expect(await layerMessages("src/app/x.ts", code)).not.toEqual([]);
  });

  it("a .tsx file with JSX in src/app or src/renderer (the old `find -name *.tsx`)", async () => {
    expect(await layerMessages("src/app/x.tsx", "export const a = <div />;")).not.toEqual([]);
    expect(await layerMessages("src/renderer/x.tsx", "export const a = <div />;")).not.toEqual([]);
  });
});

describe("audit RF-0/1/15-RP R1: file extensions the old greps also saw", () => {
  it.each([
    ["src/ui/x.jsx", 'import { invoke } from "@tauri-apps/api/core";'],
    ["src/x.mts", 'import { invoke } from "@tauri-apps/api/core";'],
    ["src/x.cts", 'import { invoke } from "@tauri-apps/api/core";'],
    ["src/app/x.jsx", 'import { useState } from "react";'],
  ])("F-RP-2 rejects %s: %s", async (filePath, code) => {
    expect(await layerMessages(filePath, code)).not.toEqual([]);
  });
});
