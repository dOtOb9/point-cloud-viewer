import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.PCV_E2E_PORT ?? "4173");
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`PCV_E2E_PORT が不正です: ${process.env.PCV_E2E_PORT}`);
}
const PREVIEW_HOST = "127.0.0.1";
const baseUrl = `http://${PREVIEW_HOST}:${port}/point-cloud-viewer/`;

const WEBGPU_FLAG = "--enable-unsafe-webgpu";
const LINUX_SWIFTSHADER_FLAGS = [
  "--enable-features=Vulkan",
  "--use-vulkan=swiftshader",
  "--use-angle=swiftshader",
  "--use-webgpu-adapter=swiftshader",
];
const REUSE_EXISTING_SERVER = false;

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",

  use: {
    baseURL: baseUrl,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },

  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        channel: "chromium",
        launchOptions: {
          args: [
            WEBGPU_FLAG,
            ...(process.platform === "linux" ? LINUX_SWIFTSHADER_FLAGS : []),
          ],
        },
      },
    },
  ],

  webServer: {
    command: `npm run build && npm run preview -- --port ${port} --strictPort --host ${PREVIEW_HOST}`,
    url: baseUrl,
    env: { GITHUB_PAGES_BUILD: "true" },
    reuseExistingServer: REUSE_EXISTING_SERVER,
    timeout: 120_000,
  },
});
