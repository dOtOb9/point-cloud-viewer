// G3-T16: times thinning / ROR / SOR in a real browser (Web build) and takes screenshots.
// A developer tool, not part of CI. It needs a running `vite preview` of the Web build
// (GITHUB_PAGES_BUILD=true npm run build, then npm run preview -- --port N --strictPort --host 127.0.0.1).
//
//   node scripts/thin-filter-browser-bench.mjs <port> <copc-file> <out-dir> <op>[,<op>...] [--headed]
//
// ops: grid1ft | ror | sor (autzen, ft) | voxel05m | ror05m | sordefault (metre files)    (lengths are the ones G3-T7 used on autzen: 1 ft, r = 3 ft with m = 4,
//                              k = 8 / n = 2 / R = 15 ft; typed in metres, so the file's ft are exact)
// Each op opens the file in a fresh page, runs the tool from the toolbar button and waits for the new layer.
// It prints one JSON line per op: wall time from pressing the button to the new layer's row, kept points shown, crash flag.
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const [port, file, outDir, opList] = process.argv.slice(2);
const headed = process.argv.includes("--headed");
if (!port || !file || !outDir || !opList) {
  console.error("usage: node scripts/thin-filter-browser-bench.mjs <port> <copc-file> <out-dir> <ops> [--headed]");
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });
const baseUrl = `http://127.0.0.1:${port}/point-cloud-viewer/`;

const OPS = {
  // Failure paths on a metre file: zero points left (a huge neighbour count), and a cancel 5 s after the start.
  zero: { button: "filter-button", confirm: "filter-confirm", prefix: "フィルタ - ", expectText: "残る点がありません", fill: { "filter-radius": "0.5", "filter-min-neighbors": "100000" }, fillUnknownUnit: { "filter-radius": "0.5", "filter-min-neighbors": "100000" } },
  cancelror: { button: "filter-button", confirm: "filter-confirm", prefix: "フィルタ - ", expectText: "をキャンセルしました", cancelAfterMs: 5000, fill: { "filter-radius": "0.5", "filter-min-neighbors": "4" }, fillUnknownUnit: { "filter-radius": "0.5", "filter-min-neighbors": "4" } },
  // Metre files (the Shibuya cut): sizes typed as they are. The SOR search range is left at its default (the estimate).
  voxel05m: { button: "thin-button", confirm: "thin-confirm", prefix: "間引き - ", methodName: "thin-method", method: "voxel", fill: { "thin-size": "0.5" }, fillUnknownUnit: { "thin-size": "0.5" } },
  ror05m: { button: "filter-button", confirm: "filter-confirm", prefix: "フィルタ - ", fill: { "filter-radius": "0.5", "filter-min-neighbors": "4" }, fillUnknownUnit: { "filter-radius": "0.5", "filter-min-neighbors": "4" } },
  sordefault: { button: "filter-button", confirm: "filter-confirm", prefix: "フィルタ - ", method: "sor", fill: {}, fillUnknownUnit: {} },
  grid1ft: { button: "thin-button", confirm: "thin-confirm", prefix: "間引き - ", fill: { "thin-size": "0.3048" }, fillUnknownUnit: { "thin-size": "1" } },
  ror: {
    button: "filter-button",
    confirm: "filter-confirm",
    prefix: "フィルタ - ",
    fill: { "filter-radius": "0.9144", "filter-min-neighbors": "4" },
    fillUnknownUnit: { "filter-radius": "3", "filter-min-neighbors": "4" },
  },
  sor: {
    button: "filter-button",
    confirm: "filter-confirm",
    prefix: "フィルタ - ",
    method: "sor",
    fill: { "filter-k": "8", "filter-n-sigma": "2", "filter-search-radius": "4.572" },
    fillUnknownUnit: { "filter-k": "8", "filter-n-sigma": "2", "filter-search-radius": "15" },
  },
};

const browser = await chromium.launch({
  channel: "chromium",
  headless: !headed,
  args: ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist"],
});

for (const opName of opList.split(",")) {
  const op = OPS[opName];
  if (!op) throw new Error(`unknown op: ${opName}`);
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
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
  console.log(JSON.stringify({ op: opName, adapter }));

  const chooser = page.waitForEvent("filechooser");
  await page.getByTestId("open-button").click();
  (await chooser).setFiles(file);
  await page.getByTestId("layer-row").first().waitFor({ timeout: 120_000 });
  await page.waitForTimeout(3000);

  await page.getByTestId(op.button).click();
  if (op.method) await page.locator(`input[name="${op.methodName ?? "filter-method"}"][value="${op.method}"]`).check();
  const dialogText = (await page.getByRole("dialog").innerText()).replace(/\s+/g, " ");
  const unknownUnit = dialogText.includes("座標の単位");
  for (const [id, value] of Object.entries(unknownUnit ? op.fillUnknownUnit : op.fill)) {
    await page.getByTestId(id).fill(value);
  }
  await page.screenshot({ path: join(outDir, `${opName}-dialog.png`) });

  const started = Date.now();
  await page.getByTestId(op.confirm).click();
  let seconds = null;
  let error = null;
  try {
    if (op.cancelAfterMs) {
      await page.waitForTimeout(op.cancelAfterMs);
      await page.getByTestId("tool-cancel").click();
    }
    // `expectText`: the run must END with this message in the error log and no new layer (zero points, cancel).
    const done = op.expectText ? page.getByText(op.expectText).first() : page.getByTestId("layer-row").filter({ hasText: op.prefix }).first();
    await done.waitFor({ timeout: 40 * 60_000 });
    seconds = (Date.now() - started) / 1000;
  } catch (e) {
    error = String(e).split("\n")[0];
  }
  await page.waitForTimeout(4000);
  const rows = await page.getByTestId("layer-row").allInnerTexts();
  await page.screenshot({ path: join(outDir, `${opName}-result.png`) });
  const errorText = await page.getByTestId("viewer-error").allInnerTexts();
  console.log(JSON.stringify({ op: opName, unknownUnit, seconds, crashed, error, rows, errorText, logsTail: logs.slice(-5) }));
  await page.close();
}
await browser.close();
