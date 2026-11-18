import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.PCV_E2E_PORT ?? "4173");
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`PCV_E2E_PORT が不正です: ${process.env.PCV_E2E_PORT}`);
}
const PREVIEW_HOST_IPV4_BECAUSE_VITE_MAY_BIND_ONLY_IPV6 = "127.0.0.1";
const baseUrl = `http://${PREVIEW_HOST_IPV4_BECAUSE_VITE_MAY_BIND_ONLY_IPV6}:${port}/point-cloud-viewer/`;

const WEBGPU_IN_HEADLESS_CHROMIUM_ON_WINDOWS_AND_LINUX = "--enable-unsafe-webgpu";
const LINUX_SWIFTSHADER_FLAGS_AGAINST_GPU_PROCESS_CRASHES = [
  "--enable-features=Vulkan",
  "--use-vulkan=swiftshader",
  "--use-angle=swiftshader",
  "--use-webgpu-adapter=swiftshader",
];
const NEVER_TEST_A_STALE_PREVIEW_SERVER = false;

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
            WEBGPU_IN_HEADLESS_CHROMIUM_ON_WINDOWS_AND_LINUX,
            ...(process.platform === "linux" ? LINUX_SWIFTSHADER_FLAGS_AGAINST_GPU_PROCESS_CRASHES : []),
          ],
        },
      },
    },
  ],

  webServer: {
    command: `npm run build && npm run preview -- --port ${port} --strictPort --host ${PREVIEW_HOST_IPV4_BECAUSE_VITE_MAY_BIND_ONLY_IPV6}`,
    url: baseUrl,
    env: { GITHUB_PAGES_BUILD: "true" },
    reuseExistingServer: NEVER_TEST_A_STALE_PREVIEW_SERVER,
    timeout: 120_000,
  },
});
