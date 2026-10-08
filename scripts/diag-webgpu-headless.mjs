// ヘッドレスChromiumでWebGPUの実アダプタが取れるかを、起動フラグの組み合わせを
// 変えながら診断するスクリプト(Node、Playwrightの`chromium`を直接使う。
// `playwright.config.ts`は経由しない)。
//
// 背景(`TaskSheets/ADR-0016-e2e-web-conversion.md`参照):
// Windows(このエージェントの開発機)では`channel: "chromium"`さえ指定すれば
// 追加フラグ無しで`navigator.gpu.requestAdapter()`が成功したが、実際のCI
// (GitHub Actions、ubuntu-latest)では同じ設定で`requestAdapter()`が`null`に
// なった(CI run 37792380083、`error-context.md`で確認)。LinuxとWindowsで
// 必要なフラグが違う疑いがあり、それをCI上で確かめるための使い捨てではない
// 診断ツールとしてここに残す(`scripts/diag-sky-ray.ts`と同じ「診断スクリプトは
// 残す」慣習)。
//
// 使い方: `node scripts/diag-webgpu-headless.mjs`
// (`npx playwright install --with-deps chromium`を先に済ませておくこと)

import { createServer } from "node:http";
import { chromium } from "@playwright/test";

/** 試すフラグの組み合わせ。先頭(`baseline`)は現状の`playwright.config.ts`と
 *  同じ「追加フラグ無し」。それ以外は候補。 */
const candidates = [
  { name: "baseline(no extra flags)", args: [] },
  { name: "enable-unsafe-webgpu", args: ["--enable-unsafe-webgpu"] },
  {
    name: "vulkan+swiftshader-adapter",
    args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-webgpu-adapter=swiftshader"],
  },
  {
    name: "angle-swiftshader+vulkan-swiftshader",
    args: [
      "--enable-unsafe-webgpu",
      "--enable-features=Vulkan",
      "--use-angle=swiftshader",
      "--use-vulkan=swiftshader",
      "--use-webgpu-adapter=swiftshader",
    ],
  },
  {
    name: "ignore-gpu-blocklist追加",
    args: [
      "--enable-unsafe-webgpu",
      "--enable-features=Vulkan",
      "--use-angle=swiftshader",
      "--use-vulkan=swiftshader",
      "--use-webgpu-adapter=swiftshader",
      "--ignore-gpu-blocklist",
    ],
  },
];

/** `http://127.0.0.1`(セキュアコンテキスト扱い)で素朴に配信するだけのサーバー。
 *  `navigator.gpu`はセキュアコンテキストでしか存在しない
 *  (`data:`URL等のopaque originでは消える。実機で確認済み)。 */
async function withServer(run) {
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end('<canvas id="c" width="64" height="64"></canvas>');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  try {
    return await run(`http://127.0.0.1:${port}/`);
  } finally {
    server.close();
  }
}

async function probe(args) {
  // `channel: "chromium"`: 既定のheadless(`chrome-headless-shell`)は
  // `requestAdapter()`が常にnullを返すため使わない
  // (`TaskSheets/ADR-0016-e2e-web-conversion.md`参照)。
  const browser = await chromium.launch({ headless: true, channel: "chromium", args });
  try {
    const page = await browser.newPage();
    return await withServer(async (url) => {
      await page.goto(url);
      return page.evaluate(async () => {
        const out = { hasGpu: "gpu" in navigator };
        if (!out.hasGpu) return out;
        try {
          const adapter = await navigator.gpu.requestAdapter();
          out.adapter = adapter ? "ok" : "null";
          if (!adapter) return out;
          const device = await adapter.requestDevice();
          out.device = !!device;
          const canvas = document.getElementById("c");
          const ctx = canvas.getContext("webgpu");
          out.ctx = !!ctx;
          if (!ctx) return out;
          const format = navigator.gpu.getPreferredCanvasFormat();
          ctx.configure({ device, format, alphaMode: "opaque" });
          const encoder = device.createCommandEncoder();
          const view = ctx.getCurrentTexture().createView();
          const pass = encoder.beginRenderPass({
            colorAttachments: [{ view, loadOp: "clear", storeOp: "store", clearValue: { r: 1, g: 0, b: 0, a: 1 } }],
          });
          pass.end();
          device.queue.submit([encoder.finish()]);
          out.rendered = true;
        } catch (e) {
          out.error = String(e);
        }
        return out;
      });
    });
  } finally {
    await browser.close();
  }
}

for (const { name, args } of candidates) {
  try {
    const result = await probe(args);
    console.log(`${name}: ${JSON.stringify(result)}`);
  } catch (e) {
    console.log(`${name}: LAUNCH_FAILED ${String(e)}`);
  }
}
