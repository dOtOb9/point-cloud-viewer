import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // .claude/worktrees/配下にエージェント用の別worktree(このリポジトリ自身の
  // フルコピー)が作られることがある。無視しないと、ルートでのlintがworktree内の
  // ファイルまで二重に検査してしまう。
  //
  // `**/*.generated.tsx`(I-1, ADR-0014): ui-forgeが`.ui`から生成するTSX。
  // 人間が手で直さないファイルなのでlintの対象から外す(整形・内容の正しさは
  // `npm run ui:check`がCIで見る。実装記録に理由を記載)。
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
);
