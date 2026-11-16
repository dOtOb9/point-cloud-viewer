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

const browser = await chromium.launch({ channel: "chromium", args: ["--enable-unsafe-webgpu"] });
try {
  for (const { width, height } of sizes) {
    const page = await browser.newPage({ viewport: { width, height }, hasTouch: width < 500, isMobile: width < 500 });
    const errors = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    await page.goto(url, { waitUntil: "networkidle" });
    const chooser = page.waitForEvent("filechooser");
    await page.getByTestId("open-button").click();
    await (await chooser).setFiles(file);
    await page.waitForTimeout(12000);
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
