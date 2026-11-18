import { chromium } from "playwright";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const url = arg("url", "http://localhost:5297/");
const file = arg("file");
const out = arg("out");
const steps = (arg("steps", "") || "").split(",").filter(Boolean);
const USAGE = `usage: node scripts/ui-shots.mjs --file <laz/copc> --out <dir> [--url <url>] [--steps <testid,testid,...>]

Screenshots at a phone width (375x740) and a desktop width (1280x800), to look at after a UI change: tests and CI
cannot tell that a dialog covers the point cloud (TP-1 F-1).
Start the dev server first (npx vite --port 5297 --strictPort); --url defaults to http://localhost:5297/.
--steps: data-testid values clicked in order; a screenshot is taken before the first step and after each one.
Files: <out>/<width>-0-loaded.png, <width>-1-<testid>.png, ...  Open them and check that the result of each step is visible.
The browser needs WebGPU (--enable-unsafe-webgpu). Stop only the dev server you started (ADR-0016).`;

if (process.argv.includes("--help")) {
  console.log(USAGE);
  process.exit(0);
}
if (!file || !out) {
  console.error(USAGE);
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
    const errors = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    await page.goto(url, { waitUntil: "networkidle" });
    const hasWebGpu = await page.evaluate(() => "gpu" in navigator);
    if (!hasWebGpu) console.warn(`${width}px: this browser has no WebGPU (navigator.gpu); the screenshots will not show the point cloud`);
    const chooser = page.waitForEvent("filechooser");
    await page.getByTestId("open-button").click();
    await (await chooser).setFiles(file);
    try {
      await page.getByTestId("view-button").waitFor({ state: "visible", timeout: 60000 });
      await page.waitForFunction(() => !document.querySelector('[data-testid="view-button"]')?.hasAttribute("disabled"), null, { timeout: 60000 });
    } catch {
      await page.screenshot({ path: `${out}/${width}-timeout.png` });
      const why = hasWebGpu
        ? "the file did not open (read failed or still converting); see the console errors and the screenshot"
        : "this browser has no WebGPU, so the app shows its unsupported-device screen";
      console.error(`${width}px: the view button did not become usable within 60 s: ${why}. Screenshot: ${out}/${width}-timeout.png`);
      process.exitCode = 1;
      await page.close();
      continue;
    }
    await page.waitForTimeout(3000);
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
