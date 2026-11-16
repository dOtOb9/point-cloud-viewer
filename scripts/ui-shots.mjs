// Screenshots of the UI at a phone width (375x740) and a desktop width (1280x800), to LOOK at after a UI change.
// Needed because tests and CI cannot tell that a dialog covers the point cloud (TP-1 F-1).
//
// Usage (start the dev server first: `npx vite --port 5297 --strictPort`):
//   node scripts/ui-shots.mjs --file C:/rust/point-cloud-viewer/data/autzen-classified.copc.laz --out <dir> \
//        [--url http://localhost:5297/] [--steps view-button,view-preset-top,view-preset-isometric]
// --steps is a list of data-testid values clicked in order; a screenshot is taken before the first step and after each one.
// Files: <out>/<width>-0-loaded.png, <width>-1-<testid>.png, ...  Open them and check that the result of the step is visible.
// Playwright must be installed (it is a dev dependency); the browser needs WebGPU (`--enable-unsafe-webgpu`).
// Stop only the dev server you started (check the command line first; never kill all node processes, ADR-0016).
import { chromium } from "playwright";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const url = arg("url", "http://localhost:5297/");
const file = arg("file");
const out = arg("out");
const steps = (arg("steps", "") || "").split(",").filter(Boolean);
if (!file || !out) {
  console.error("usage: node scripts/ui-shots.mjs --file <laz/copc> --out <dir> [--url <url>] [--steps <testid,testid,...>]");
  process.exit(2);
}

const sizes = [
  { width: 375, height: 740 },
  { width: 1280, height: 800 },
];

if (!(await import("node:fs")).existsSync(file)) {
  console.error(`file not found: ${file}`);
  process.exit(2);
}

const browser = await chromium.launch({ channel: "chromium", args: ["--enable-unsafe-webgpu"] });
try {
  for (const { width, height } of sizes) {
    const page = await browser.newPage({ viewport: { width, height }, hasTouch: width < 500, isMobile: width < 500 });
    // Without WebGPU the app shows its "unsupported device" screen and the view button never enables (the wait below times out).
    if (!(await page.evaluate(() => "gpu" in navigator))) console.warn(`${width}px: this browser has no WebGPU (navigator.gpu); the screenshots will not show the point cloud`);
    const errors = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    await page.goto(url, { waitUntil: "networkidle" });
    const chooser = page.waitForEvent("filechooser");
    await page.getByTestId("open-button").click();
    await (await chooser).setFiles(file);
    // The view button is enabled once a point cloud is open (a fixed wait would be too short or too long).
    await page.getByTestId("view-button").waitFor({ state: "visible", timeout: 60000 });
    await page.waitForFunction(() => !document.querySelector('[data-testid="view-button"]')?.hasAttribute("disabled"), null, { timeout: 60000 });
    await page.waitForTimeout(3000); // let the nodes stream in
    await page.screenshot({ path: `${out}/${width}-0-loaded.png` });
    let n = 1;
    for (const id of steps) {
      await page.getByTestId(id).click();
      await page.waitForTimeout(1500);
      await page.screenshot({ path: `${out}/${width}-${n++}-${id}.png` });
    }
    console.log(`${width}x${height}: ${n} screenshots, console errors: ${errors.length}`);
    await page.close();
  }
} finally {
  await browser.close();
}
