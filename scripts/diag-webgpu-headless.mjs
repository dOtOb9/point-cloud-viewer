import { createServer } from "node:http";
import { chromium } from "@playwright/test";

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
