// `test`フィールド(vitestの設定)の型を効かせるため、defineConfigは"vite"ではなく
// "vitest/config"から取る(vite本体のUserConfigに`test`を足した上位互換の型で、
// `vite build`/`vite dev`にもそのまま使える。トリプルスラッシュ参照
// (`/// <reference types="vitest/config" />`)でも同じことができるが、
// eslintの@typescript-eslint/triple-slash-referenceに引っかかるためimport形式にした)。
import { defineConfig, configDefaults } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
// @ts-expect-error type error without @types/node package
import process from "node:process";
const host = process.env.TAURI_DEV_HOST;

// GitHub Pagesはリポジトリのサブパス(https://<owner>.github.io/point-cloud-viewer/)で
// 配信されるため、そのときだけ`base`をサブパスに変える。Tauri版のビルド
// (`npm run tauri build`。frontendDistをwebviewが配信する)は既定の"/"のままでよい
// (これまでどおり動く。TaskSheets/ADR-0012-web-worker-sync-io.md参照)。
// `.github/workflows/pages.yml`がビルド時にこの環境変数を立てる。
const isGithubPagesBuild = process.env.GITHUB_PAGES_BUILD === "true";

// https://vite.dev/config/
export default defineConfig(() => ({
  base: isGithubPagesBuild ? "/point-cloud-viewer/" : "/",
  plugins: [react(), tailwindcss()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },

  test: {
    // `.claude/worktrees/`配下にエージェント用の別worktree(このリポジトリ自身の
    // フルコピー)が作られることがあり、既定のexcludeだけではそこにあるテストまで
    // 拾ってしまう(ルートでnpm testを実行すると、worktree分が二重に数えられて
    // 件数が実際より大きく出る)。vitestのconfigDefaults.excludeは指定すると
    // 丸ごと上書きされる仕様なので、既定値を展開した上で`.claude/**`を追加する
    // (既定の除外(node_modules等)を消さない)。
    exclude: [...configDefaults.exclude, ".claude/**"],
  },
}));
