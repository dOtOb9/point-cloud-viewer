import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

// ---- Import patterns for the layer rules (used in the config below) ----
// Each pattern is checked in three places: import/export statements (no-restricted-imports), dynamic
// `import("...")` and type-position `import("...").X` (no-restricted-syntax, see layerRules()).
const TAURI = {
  regex: "^@tauri-apps/",
  message: "Tauri の npm パッケージを import してよいのは src/datasource/tauri.ts だけ（規約2、ADR-0001）。",
};
const REACT = {
  regex: "^react(-dom)?($|/)",
  message: "src/renderer と src/app は React を import できない（規約3・5、ADR-0021）。",
};
const STATE_HOOKS = {
  regex: "(^|/)state/use[A-Z]",
  message: "src/app は src/state のフック（use*）を import できない（規約5、ADR-0021）。型だけでも不可。型は src/app 側に置く。",
};
const RENDERER_CLASS = {
  // The optional extension: tsconfig has allowImportingTsExtensions.
  regex: String.raw`(^|/)renderer/point-cloud-renderer(\.[cm]?[jt]sx?)?$`,
  message:
    "src/ui は PointCloudRenderer クラスを import しない（規約3）。純粋な関数・定数・型（screen-project.ts、colormap.ts など）はよい。操作は src/app の関数を呼ぶ。",
};
// Paths that are not normalized ("./../x", "../y/../x", "a/./b"). The plugin rule below counts the leading
// "../", so these would get around it. Not written by hand in this repository.
const UNNORMALIZED = {
  regex: String.raw`/\.(/|$)|^\./\.|(^|/)(?!\.\.?(/|$))[^/]+/\.\.(/|$)`,
  message: "正規化していないパス（./.. や x/../y など）は import しない。層の検査をすり抜けるため。",
};
const JSX_SYNTAX = ["JSXElement", "JSXFragment"].map((selector) => ({
  selector,
  message: "src/renderer と src/app は React を知らない（JSX を書かない）。ADR-0021",
}));

// The rules for one zone: the complete list of patterns for its files (ESLint replaces the options of a rule
// when a later config object sets it again, so a zone never relies on another one).
// `no-restricted-imports` does not see dynamic `import("x")` or the type `import("x").Y`, so the same
// patterns are also written as `no-restricted-syntax` selectors. An esquery regex literal cannot contain a
// slash, so slashes outside a character class are written `[/]` there (see selectorRegex()).
function selectorRegex(regex) {
  let out = "";
  let inClass = false;
  for (let i = 0; i < regex.length; i++) {
    const c = regex[i];
    if (c === "\\") {
      out += c + regex[++i];
      continue;
    }
    if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    out += c === "/" && !inClass ? "[/]" : c;
  }
  return out;
}

function layerRules(patterns, extraSyntax = []) {
  const syntax = [...extraSyntax];
  for (const { regex, message } of patterns) {
    const re = selectorRegex(regex);
    syntax.push({ selector: `ImportExpression[source.value=/${re}/]`, message });
    syntax.push({ selector: `TSImportType[argument.literal.value=/${re}/]`, message });
    syntax.push({ selector: `CallExpression[callee.name="require"][arguments.0.value=/${re}/]`, message });
  }
  return {
    "no-restricted-imports": ["error", { patterns: patterns.map((p) => ({ ...p, caseSensitive: true })) }],
    "no-restricted-syntax": ["error", ...syntax],
  };
}

const SRC_FILES = ["src/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"];
const GENERATED_WASM = "src/wasm/**";

// ADR-0023: what a plugin file may import. `depth` is how many folders the file is below src/plugins/
// (src/plugins/builtin.ts: 0, src/plugins/<id>/index.ts: 1, src/plugins/<id>/view/Panel.tsx: 2).
// A relative import that climbs `depth` or more levels ("../" repeated) leaves the plugin's own folder.
// src/ is reached after `depth + 1` climbs, and from there only plugin-api and ui/kit are allowed.
// Everything that is not relative must be react (or react/...) or lucide-react (vitest too, in tests).
// Limit: files deeper than MAX_PLUGIN_DEPTH get only the bare-package and normalization checks.
const MAX_PLUGIN_DEPTH = 8;
const PLUGIN_MESSAGE =
  "プラグイン（src/plugins/**）が import してよいのは src/plugin-api・自分のフォルダ・react・lucide-react・src/ui/kit だけ。他のプラグインやコアを直接 import しない（ADR-0023）。";
function pluginBare(isTest) {
  const bare = isTest ? "react($|/)|lucide-react($|/)|vitest$" : "react($|/)|lucide-react($|/)";
  return { regex: String.raw`^(?!\.{1,2}(/|$)|${bare})`, message: PLUGIN_MESSAGE };
}
function pluginPatterns(depth, isTest) {
  const outOfFolder = Math.max(depth, 1);
  return [
    pluginBare(isTest),
    UNNORMALIZED,
    {
      regex: String.raw`^(?!(\.\./){${depth + 1}}(plugin-api|ui/kit)(/|$))(\.\.(/|$)){${outOfFolder},}`,
      message: PLUGIN_MESSAGE,
    },
  ];
}

function pluginZones() {
  const zones = [
    // Any depth: the checks that do not depend on it.
    { files: ["src/plugins/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"], rules: layerRules([pluginBare(false), UNNORMALIZED]) },
    {
      files: ["src/plugins/**/*.test.{ts,tsx}"],
      rules: layerRules([pluginBare(true), UNNORMALIZED]),
    },
  ];
  for (let depth = 0; depth <= MAX_PLUGIN_DEPTH; depth++) {
    const dir = "src/plugins/" + (depth === 0 ? "" : "*/".repeat(depth));
    const tests = [dir + "*.test.{ts,tsx}"];
    zones.push({
      files: [dir + "*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"],
      ignores: tests,
      rules: layerRules(pluginPatterns(depth, false)),
    });
    zones.push({ files: tests, rules: layerRules(pluginPatterns(depth, true)) });
  }
  return zones;
}

export default tseslint.config(
  // Agent worktrees under .claude/ are full copies of this repository; ignore them so lint does not
  // check every file twice. `**/*.generated.tsx` is kept ignored for generated TSX (ui-forge, ADR-0014,
  // has been removed and no such file exists now).
  { ignores: ["dist", "src-tauri", "target", ".claude", "**/*.generated.tsx"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx,mts,cts}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
    },
  },
  // ---- Layer rules (ARCHITECTURE.md rules 2, 3, 5; ADR-0021; ADR-0023 for src/plugins) ----
  //
  // These replace the grep steps that used to be in the CI `invariants` job (RF-1). They look at import
  // statements, dynamic import() and import() types only, so a comment that mentions a package name no
  // longer fails. See layerRules() for why each zone lists its complete set of patterns.
  { files: SRC_FILES, ignores: ["src/datasource/tauri.ts", GENERATED_WASM], rules: layerRules([TAURI]) },
  // Rule 3 (first half): the renderer does not know React. JSX imports React implicitly, so it is forbidden too.
  { files: ["src/renderer/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"], rules: layerRules([TAURI, REACT], JSX_SYNTAX) },
  // Rule 5: src/app does not know React or the src/state hooks (type imports count too).
  { files: ["src/app/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"], rules: layerRules([TAURI, REACT, STATE_HOOKS, UNNORMALIZED], JSX_SYNTAX) },
  // Rule 3 (second half, decided again in RF-1): src/ui does not import the `PointCloudRenderer` class.
  // Pure functions, constants and types of src/renderer (screen-project.ts, colormap.ts, ...) are fine.
  { files: ["src/ui/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"], rules: layerRules([TAURI, RENDERER_CLASS]) },
  // ADR-0023: a plugin (src/plugins/<id>/**) may import only src/plugin-api, its own folder, react, lucide-react
  // and src/ui/kit. The folder does not exist yet; the rule is in place for when it does.
  ...pluginZones(),
);
