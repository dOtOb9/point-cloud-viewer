import { defineConfig, configDefaults } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
// @ts-expect-error type error without @types/node package
import process from "node:process";
const host = process.env.TAURI_DEV_HOST;

const isGithubPagesBuild = process.env.GITHUB_PAGES_BUILD === "true";
const GITHUB_PAGES_SUBPATH = "/point-cloud-viewer/";

const AGENT_WORKTREES = ".claude/**";
const PLAYWRIGHT_SPECS = "e2e/**";

export default defineConfig(() => ({
  base: isGithubPagesBuild ? GITHUB_PAGES_SUBPATH : "/",
  plugins: [react(), tailwindcss()],

  clearScreen: false,
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
      ignored: ["**/src-tauri/**"],
    },
  },

  test: {
    exclude: [...configDefaults.exclude, AGENT_WORKTREES, PLAYWRIGHT_SPECS],
  },
}));
