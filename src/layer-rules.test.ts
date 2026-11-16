// @vitest-environment node
// Checks the layer rules in eslint.config.js (ARCHITECTURE.md rules 2, 3, 5; ADR-0023 for src/plugins) by
// linting small pieces of source text under made-up paths. The rules look at import statements only.
// src/plugins/ does not exist yet; its rules are tested here so that they work on the day it appears.
import { ESLint } from "eslint";
import { beforeAll, describe, expect, it } from "vitest";

let eslint: ESLint;

beforeAll(() => {
  eslint = new ESLint();
});

/** The messages the layer rules report for `code` linted as if it lived at `filePath`. */
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
