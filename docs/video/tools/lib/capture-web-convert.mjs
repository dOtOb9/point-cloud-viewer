import fs from "node:fs";
import fs_p from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";
import { startScreencast, framesToMp4 } from "./record.mjs";
import { ffmpeg } from "./ffmpeg.mjs";
import { FOOTAGE_DIR, AUTZEN_PCD } from "./paths.mjs";

const BASE_URL = process.env.PCV_PREVIEW_URL ?? "http://127.0.0.1:4555/";
const TMP_FRAMES = path.join(process.env.TEMP ?? "C:\\Windows\\Temp", "pcv-video-capture");

const CHROMIUM_ARGS = [
  "--enable-unsafe-webgpu",
  "--enable-features=Vulkan,WebGPU,WebGPUDeveloperFeatures",
  "--use-angle=d3d11",
  "--disable-gpu-sandbox",
  "--ignore-gpu-blocklist",
];

async function isBusy(page) {
  return page.evaluate(() => {
    const el = document.querySelector('input[type="file"]');
    return !!(el && el.disabled);
  });
}

async function recordClip(page, label, durationMs) {
  const frameDir = path.join(TMP_FRAMES, label);
  await fs_p.rm(frameDir, { recursive: true, force: true });
  const rec = await startScreencast(page, frameDir);
  await page.waitForTimeout(durationMs);
  const frames = await rec.stop();
  console.log(`  [${label}] ${frames.length}フレーム`);
  const outPath = path.join(TMP_FRAMES, `${label}.mp4`);
  await framesToMp4(frames, outPath, TMP_FRAMES);
  return outPath;
}

async function main() {
  if (!fs.existsSync(AUTZEN_PCD)) throw new Error(`データが無い: ${AUTZEN_PCD}`);
  await fs_p.mkdir(FOOTAGE_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: false, args: CHROMIUM_ARGS });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  page.on("pageerror", (err) => console.log("[pageerror]", String(err)));

  let clipStart;
  let clipEnd;
  try {
    await page.goto(BASE_URL, { waitUntil: "load" });
    await page.waitForSelector("canvas", { state: "visible", timeout: 15000 });

    const input = page.locator('input[type="file"]');
    await input.setInputFiles(AUTZEN_PCD);
    await page.waitForTimeout(400);

    clipStart = await recordClip(page, "04-web-convert-start", 4000);

    console.log("  変換の完了を待機中(録画なし)…");
    const startWait = Date.now();
    let busy = await isBusy(page);
    while (busy) {
      await page.waitForTimeout(1000);
      busy = await isBusy(page);
      if (Date.now() - startWait > 600_000) {
        throw new Error("変換が10分経っても終わらない(録画なしでも)");
      }
    }
    const waitedSec = (Date.now() - startWait) / 1000;
    console.log(`  変換完了まで(録画なし): ${waitedSec.toFixed(1)}秒`);

    const errorText = await page.locator("text=失敗").count();
    if (errorText > 0) throw new Error("画面にエラーが出ている");

    await page.waitForTimeout(500);
    const breakdown = page.locator("text=変換の内訳");
    if ((await breakdown.count()) > 0) {
      await breakdown.scrollIntoViewIfNeeded().catch(() => {});
    }

    clipEnd = await recordClip(page, "04-web-convert-end", 4000);
  } finally {
    await browser.close();
  }

  const listPath = path.join(TMP_FRAMES, "04-web-convert-concat.txt");
  await fs_p.writeFile(
    listPath,
    [`file '${clipStart.replace(/\\/g, "/")}'`, `file '${clipEnd.replace(/\\/g, "/")}'`].join("\n"),
    "utf8",
  );
  const outPath = path.join(FOOTAGE_DIR, "04-web-convert.mp4");
  await ffmpeg(["-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", outPath]);
  console.log("->", outPath);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
