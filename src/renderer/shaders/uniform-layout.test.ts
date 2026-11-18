import { describe, expect, it } from "vitest";
import edlSource from "../edl.ts?raw";
import gpuResourcesSource from "../gpu-resources.ts?raw";
import groundGridSource from "../ground-grid.ts?raw";
import skySource from "../sky.ts?raw";
import edlWgsl from "./edl.wgsl?raw";
import groundGridWgsl from "./ground-grid.wgsl?raw";
import pointsWgsl from "./points.wgsl?raw";
import skyWgsl from "./sky.wgsl?raw";

function wgslStructFields(wgsl: string, structName: string): string[] {
  const body = wgsl.match(new RegExp(`struct ${structName} \\{([^}]*)\\}`))?.[1] ?? "";
  return [...body.matchAll(/(\w+)\s*:/g)].map((match) => match[1]);
}

function tsStringList(source: string, constName: string): string[] {
  const body = source.match(new RegExp(`const ${constName} = \\[([^\\]]*)\\]`))?.[1] ?? "";
  return [...body.matchAll(/"(\w+)"/g)].map((match) => match[1]);
}

function tsObjectKeys(source: string, constName: string): string[] {
  const body = source.match(new RegExp(`const ${constName} = \\{([^}]*)\\}`))?.[1] ?? "";
  return [...body.matchAll(/(\w+)\s*:/g)].map((match) => match[1]);
}

describe("uniform layouts written on the TypeScript side match the WGSL structs", () => {
  it("reads the field names of a WGSL struct and of a TypeScript list", () => {
    expect(wgslStructFields("struct A {\n  x: f32,\n  y: vec4<f32>,\n};", "A")).toEqual(["x", "y"]);
    expect(tsStringList('const A_FIELDS = ["x", "y"] as const;', "A_FIELDS")).toEqual(["x", "y"]);
    expect(tsObjectKeys("const A = { x: 4, y: 64 };", "A")).toEqual(["x", "y"]);
  });

  it.each([
    ["edl.ts", "EDL_UNIFORM_F32_FIELDS", "EdlUniforms", edlSource, edlWgsl],
    ["sky.ts", "SKY_UNIFORM_VEC4_FIELDS", "SkyUniforms", skySource, skyWgsl],
    ["ground-grid.ts", "GRID_UNIFORM_VEC4_FIELDS", "GridUniforms", groundGridSource, groundGridWgsl],
    ["gpu-resources.ts", "COLOR_SETTINGS_UNIFORM_F32_FIELDS", "ColorSettings", gpuResourcesSource, pointsWgsl],
  ])("%s %s lists the fields of %s in order", (_file, constName, structName, source, wgsl) => {
    const fields = tsStringList(source, constName);
    expect(fields.length).toBeGreaterThan(0);
    expect(fields).toEqual(wgslStructFields(wgsl, structName));
  });

  it("gpu-resources.ts NODE_UNIFORM_FIELD_BYTES follows the Uniforms struct of points.wgsl, and the float indices point at its fields", () => {
    const structFields = wgslStructFields(pointsWgsl, "Uniforms");
    expect(tsObjectKeys(gpuResourcesSource, "NODE_UNIFORM_FIELD_BYTES")).toEqual(structFields);
    const mvpFloats = 16;
    const expectedIndex = Object.fromEntries(structFields.slice(1).map((name, i) => [name, mvpFloats + i]));
    const indexBody = gpuResourcesSource.match(/const NODE_UNIFORM_FLOAT_INDEX = \{([^}]*)\}/)?.[1] ?? "";
    const actualIndex = Object.fromEntries([...indexBody.matchAll(/(\w+)\s*:\s*(\d+)/g)].map((m) => [m[1], Number(m[2])]));
    expect(actualIndex).toEqual(expectedIndex);
  });
});
