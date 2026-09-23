import { defineConfig } from "vite";
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
}));
