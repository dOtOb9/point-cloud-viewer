import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

// ---- Import patterns for the layer rules (used in the config below) ----
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
  regex: "(^|/)renderer/point-cloud-renderer$",
  message:
    "src/ui は PointCloudRenderer クラスを import しない（規約3）。純粋な関数・定数・型（screen-project.ts、colormap.ts など）はよい。操作は src/app の関数を呼ぶ。",
};

// ADR-0023: what a plugin file may import. `depth` is how many folders the file is below src/plugins/
// (src/plugins/builtin.ts: 0, src/plugins/<id>/index.ts: 1, src/plugins/<id>/view/Panel.tsx: 2).
// A relative import that climbs `depth` or more levels ("../" repeated) leaves the plugin's own folder.
// src/ is reached after `depth + 1` climbs, and from there only plugin-api and ui/kit are allowed.
// Everything that is not relative must be react (or react/...) or lucide-react (vitest too, in tests).
function pluginPatterns(depth, isTest) {
  const bare = isTest ? "react($|/)|lucide-react($|/)|vitest$" : "react($|/)|lucide-react($|/)";
  const outOfFolder = Math.max(depth, 1);
  return [
    {
      regex: `^(?!\\.{1,2}(/|$)|${bare})`,
      message:
        "プラグイン（src/plugins/**）が import してよいのは src/plugin-api・自分のフォルダ・react・lucide-react・src/ui/kit だけ（ADR-0023）。",
    },
    {
      regex: `^(?!(\\.\\./){${depth + 1}}(plugin-api|ui/kit)(/|$))(\\.\\./){${outOfFolder},}`,
      message:
        "プラグイン（src/plugins/**）が import してよいのは src/plugin-api・自分のフォルダ・react・lucide-react・src/ui/kit だけ。他のプラグインやコアを直接 import しない（ADR-0023）。",
    },
  ];
}

function pluginZones() {
  const zones = [];
  for (let depth = 0; depth <= 6; depth++) {
    const dir = "src/plugins/" + (depth === 0 ? "" : "*/".repeat(depth));
    const tests = [dir + "*.test.{ts,tsx}"];
    zones.push({
      files: [dir + "*.{ts,tsx}"],
      ignores: tests,
      rules: { "no-restricted-imports": ["error", { patterns: pluginPatterns(depth, false) }] },
    });
    zones.push({
      files: tests,
      rules: { "no-restricted-imports": ["error", { patterns: pluginPatterns(depth, true) }] },
    });
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
    files: ["**/*.{ts,tsx}"],
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
  // statements only, so a comment that mentions a package name no longer fails.
  //
  // ESLint replaces the options of a rule when a later config object sets it again for the same file. So each
  // zone below lists the COMPLETE set of patterns for its own files (the shared ones plus its own), and the
  // zones do not overlap, except the generic "all of src" object, which every zone overrides.
  //
  // A `regex` pattern is matched against the import string as written ("../../renderer/sky").
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/datasource/tauri.ts"],
    rules: { "no-restricted-imports": ["error", { patterns: [TAURI] }] },
  },
  // Rule 3 (first half): the renderer does not know React.
  {
    files: ["src/renderer/**/*.{ts,tsx}"],
    rules: { "no-restricted-imports": ["error", { patterns: [TAURI, REACT] }] },
  },
  // Rule 5: src/app does not know React or the src/state hooks (type imports count too).
  {
    files: ["src/app/**/*.{ts,tsx}"],
    rules: { "no-restricted-imports": ["error", { patterns: [TAURI, REACT, STATE_HOOKS] }] },
  },
  // Rule 3 (second half, decided again in RF-1): src/ui does not import the `PointCloudRenderer` class.
  // Pure functions, constants and types of src/renderer (screen-project.ts, colormap.ts, ...) are fine.
  {
    files: ["src/ui/**/*.{ts,tsx}"],
    rules: { "no-restricted-imports": ["error", { patterns: [TAURI, RENDERER_CLASS] }] },
  },
  // `.tsx` has JSX, which imports React implicitly (jsx-runtime), so forbid it by syntax too.
  {
    files: ["src/renderer/**/*.tsx", "src/app/**/*.tsx"],
    rules: {
      "no-restricted-syntax": [
        "error",
        { selector: "JSXElement", message: "src/renderer と src/app は React を知らない（JSX を書かない）。ADR-0021" },
        { selector: "JSXFragment", message: "src/renderer と src/app は React を知らない（JSX を書かない）。ADR-0021" },
      ],
    },
  },
  // ADR-0023: a plugin (src/plugins/<id>/**) may import only src/plugin-api, its own folder, react, lucide-react
  // and src/ui/kit. The folder does not exist yet; the rule is in place for when it does.
  // How the relative imports are told apart: see pluginZones().
  ...pluginZones(),
);
