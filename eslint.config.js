import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

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
  regex: String.raw`(^|/)renderer/point-cloud-renderer(\.[cm]?[jt]sx?)?$`,
  message:
    "src/ui は PointCloudRenderer クラスを import しない（規約3）。純粋な関数・定数・型（screen-project.ts、colormap.ts など）はよい。操作は src/app の関数を呼ぶ。",
};
const UNNORMALIZED = {
  regex: String.raw`/\.(/|$)|^\./\.|(^|/)(?!\.\.?(/|$))[^/]+/\.\.(/|$)`,
  message: "正規化していないパス（./.. や x/../y など）は import しない。層の検査をすり抜けるため。",
};
const JSX_SYNTAX = ["JSXElement", "JSXFragment"].map((selector) => ({
  selector,
  message: "src/renderer と src/app は React を知らない（JSX を書かない）。ADR-0021",
}));
const MODULE_STATE_MESSAGE =
  "src/app のモジュールの最上位に状態を置かない（let・var・createStore）。ストアは生成関数の中で作り、文脈で渡す（ADR-0021、CM-F1 の F-2）。";
const MODULE_STATE_SYNTAX = ["Program", "Program > ExportNamedDeclaration"].flatMap((parent) => [
  { selector: `${parent} > VariableDeclaration[kind!="const"]`, message: MODULE_STATE_MESSAGE },
  {
    selector: `${parent} > VariableDeclaration > VariableDeclarator > CallExpression[callee.name="createStore"]`,
    message: MODULE_STATE_MESSAGE,
  },
]);

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

const AGENT_WORKTREES = ".claude";

export default tseslint.config(
  { ignores: ["dist", "src-tauri", "target", AGENT_WORKTREES, "**/*.generated.tsx"] },
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
  { files: SRC_FILES, ignores: ["src/datasource/tauri.ts", GENERATED_WASM], rules: layerRules([TAURI]) },
  { files: ["src/renderer/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"], rules: layerRules([TAURI, REACT], JSX_SYNTAX) },
  { files: ["src/app/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"], rules: layerRules([TAURI, REACT, STATE_HOOKS, UNNORMALIZED], [...JSX_SYNTAX, ...MODULE_STATE_SYNTAX]) },
  { files: ["src/ui/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"], rules: layerRules([TAURI, RENDERER_CLASS]) },
  ...pluginZones(),
);
