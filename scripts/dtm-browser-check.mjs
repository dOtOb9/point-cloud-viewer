// G1-T15: runs the DTM tool in a real browser (Web build): opens a COPC, makes a DTM, takes screenshots and saves the
// downloaded GeoTIFF. A developer tool, not part of CI. It needs a running `vite preview` of the Web build
// (GITHUB_PAGES_BUILD=true npm run build, then npm run preview -- --port N --strictPort --host 127.0.0.1).
//
//   node scripts/dtm-browser-check.mjs <port> <copc-file> <out-dir> [cell-size-in-display-unit] [--headed]
//
// It prints the adapter info (to tell a real GPU from SwiftShader), the time from pressing "作る" to the new layer, the
// layer rows, the text of the DTM info, and saves: dtm-dialog.png, dtm-result.png, dtm.tif (the downloaded file).
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const [port, file, outDir, cellSize = "1"] = process.argv.slice(2);
const headed = process.argv.includes("--headed");
if (!port || !file || !outDir) {
  console.error("usage: node scripts/dtm-browser-check.mjs <port> <copc-file> <out-dir> [cell-size] [--headed]");
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });
const baseUrl = `http://127.0.0.1:${port}/point-cloud-viewer/`;

const browser = await chromium.launch({
  channel: "chromium",
  headless: !headed,
  args: ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
let crashed = false;
page.on("crash", () => {
  crashed = true;
});
const logs = [];
page.on("console", (m) => logs.push(m.text()));
page.on("pageerror", (e) => logs.push(`pageerror: ${e}`));
await page.goto(baseUrl);
const adapter = await page.evaluate(async () => {
  const a = await navigator.gpu?.requestAdapter();
  if (!a) return null;
  const i = a.info;
  return { vendor: i.vendor, architecture: i.architecture, device: i.device, description: i.description };
});
console.log(JSON.stringify({ adapter }));

const chooser = page.waitForEvent("filechooser");
await page.getByTestId("open-button").click();
(await chooser).setFiles(file);
await page.getByTestId("layer-row").first().waitFor({ timeout: 120_000 });
await page.waitForTimeout(3000);
await page.screenshot({ path: join(outDir, "dtm-before.png") });

await page.getByTestId("dtm-button").click();
await page.getByTestId("dtm-cell-size").fill(cellSize);
await page.screenshot({ path: join(outDir, "dtm-dialog.png") });

const started = Date.now();
await page.getByTestId("dtm-confirm").click();
let seconds = null;
let error = null;
try {
  await page.getByTestId("layer-row").filter({ hasText: "地表 - " }).first().waitFor({ timeout: 60 * 60_000 });
  seconds = (Date.now() - started) / 1000;
} catch (e) {
  error = String(e).split("\n")[0];
}
await page.waitForTimeout(5000);
const rows = await page.getByTestId("layer-row").allInnerTexts();
const info = await page.getByTestId("dtm-info").allInnerTexts();
const errorText = await page.getByTestId("viewer-error").allInnerTexts();
await page.screenshot({ path: join(outDir, "dtm-result.png") });

let saved = null;
if (info.length > 0) {
  const downloading = page.waitForEvent("download");
  await page.getByTestId("dtm-download-geotiff").click();
  const download = await downloading;
  saved = join(outDir, "dtm.tif");
  await download.saveAs(saved);
}
console.log(JSON.stringify({ seconds, crashed, error, rows, info, errorText, saved, logsTail: logs.slice(-5) }));
await browser.close();
