#!/usr/bin/env node
import fs from "node:fs";
import fs_p from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";
import { startScreencast, framesToMp4 } from "./lib/record.mjs";
import { FOOTAGE_DIR, AUTZEN_COPC, AUTZEN_PCD, TOKYO_SHIBUYA_COPC } from "./lib/paths.mjs";

const BASE_URL = process.env.PCV_PREVIEW_URL ?? "http://127.0.0.1:4555/";
const FIRST_LOAD_PAUSE_MS = 800;
const PCD_CONVERSION_TIMEOUT_MS = 600_000;
const TMP_FRAMES = path.join(process.env.TEMP ?? "C:\\Windows\\Temp", "pcv-video-capture");

const CHROMIUM_ARGS = [
  "--enable-unsafe-webgpu",
  "--enable-features=Vulkan,WebGPU,WebGPUDeveloperFeatures",
  "--use-angle=d3d11",
  "--disable-gpu-sandbox",
  "--ignore-gpu-blocklist",
];

async function assertPreviewRunning() {
  try {
    const res = await fetch(BASE_URL);
    if (!res.ok) throw new Error(`status ${res.status}`);
  } catch (err) {
    throw new Error(
      `${BASE_URL} に接続できない。先にリポジトリルートで ` +
        `"npm run build && npm run preview -- --port 4555 --strictPort --host 127.0.0.1" を実行しておくこと。(${err})`,
    );
  }
}

async function waitForCanvasReady(page) {
  await page.waitForSelector("canvas", { state: "visible", timeout: 15000 });
  const unsupported = await page.locator("text=非対応").count();
  if (unsupported > 0) {
    throw new Error("UnsupportedDeviceScreenが表示された(WebGPUが使えていない)");
  }
}

async function ensureFileInputPresent(page) {
  const count = await page.locator('input[type="file"]').count();
  if (count > 0) return;
  console.log("  [recover] file inputが見当たらないためページを再読み込みする");
  await page.goto(BASE_URL, { waitUntil: "load" });
  await waitForCanvasReady(page);
}

async function openFile(page, absPath) {
  await ensureFileInputPresent(page);
  const input = page.locator('input[type="file"]');
  await input.setInputFiles(absPath);
}

async function waitForOpenDone(page, timeoutMs) {
  await page.waitForTimeout(400);
  await page.waitForFunction(
    () => {
      const input = document.querySelector('input[type="file"]');
      return input && !input.disabled;
    },
    undefined,
    { timeout: timeoutMs },
  );
  const errorText = await page.locator("text=失敗").count();
  if (errorText > 0) {
    throw new Error("画面にエラー(「失敗」を含む文言)が出ている");
  }
}

async function record(page, label, fn) {
  const frameDir = path.join(TMP_FRAMES, label);
  await fs_p.rm(frameDir, { recursive: true, force: true });
  const rec = await startScreencast(page, frameDir);
  console.log(`  [${label}] 録画開始`);
  const fnResult = await Promise.race([
    fn().then(() => "ok"),
    new Promise((resolve) => setTimeout(() => resolve("timeout"), 25_000)),
  ]);
  if (fnResult === "timeout") {
    console.log(`  [${label}] 操作が25秒で終わらなかったため、ここまでのフレームで打ち切る`);
  }
  const frames = await rec.stop();
  console.log(`  [${label}] 録画終了: ${frames.length}フレーム`);
  const outPath = path.join(FOOTAGE_DIR, `${label}.mp4`);
  await fs_p.mkdir(FOOTAGE_DIR, { recursive: true });
  const info = await framesToMp4(frames, outPath, TMP_FRAMES);
  console.log(`  [${label}] -> ${outPath} (生の尺: ${info.rawDurationSec.toFixed(2)}s)`);
  return outPath;
}

async function orbitAndZoom(page) {
  const box = await page.locator("canvas").boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  const steps = 24;
  const radius = Math.min(box.width, box.height) * 0.22;
  for (let i = 0; i <= steps; i++) {
    const angle = (i / steps) * Math.PI * 1.4;
    await page.mouse.move(cx + Math.cos(angle) * radius, cy - 80 + Math.sin(angle) * radius * 0.5, { steps: 2 });
    await page.waitForTimeout(60);
  }
  await page.mouse.up();
  for (let i = 0; i < 4; i++) {
    await page.mouse.wheel(0, -80);
    await page.waitForTimeout(90);
  }
}

async function resetView(page) {
  await openFile(page, AUTZEN_COPC);
  await waitForOpenDone(page, 30_000);
  await page.waitForTimeout(500);
}

async function openSettings(page) {
  await page.locator('[data-ui-id="settings_button"]').click();
  await page.waitForSelector("text=設定", { state: "visible" });
}

async function closeSettings(page) {
  await page.locator('button[aria-label="設定を閉じる"]').click();
}

function setRangeValue(el, v) {
  const proto = Object.getPrototypeOf(el);
  const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
  setter.call(el, v);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

async function setCenterPriorityStrength(page, value) {
  await openSettings(page);
  await page.waitForSelector("#center-priority-strength", { state: "visible", timeout: 10_000 });
  const slider = page.locator("#center-priority-strength");
  await slider.evaluate(setRangeValue, value);
  await page.waitForTimeout(300);
  await closeSettings(page);
  await page.waitForTimeout(300);
}

async function reloadByWheel(page) {
  await page.mouse.wheel(0, 300);
  await page.waitForTimeout(150);
  await page.mouse.wheel(0, -300);
  await page.waitForTimeout(1500);
}

async function main() {
  await assertPreviewRunning();
  await fs_p.mkdir(FOOTAGE_DIR, { recursive: true });
  await fs_p.mkdir(TMP_FRAMES, { recursive: true });

  if (!fs.existsSync(AUTZEN_COPC)) throw new Error(`データが無い: ${AUTZEN_COPC}`);
  if (!fs.existsSync(AUTZEN_PCD)) throw new Error(`データが無い: ${AUTZEN_PCD}`);

  const hookSourceFile = fs.existsSync(TOKYO_SHIBUYA_COPC) ? TOKYO_SHIBUYA_COPC : AUTZEN_COPC;
  console.log(`01-hookの撮影に使うファイル: ${hookSourceFile}`);

  const browser = await chromium.launch({ headless: false, args: CHROMIUM_ARGS });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });

  const results = {};

  try {
    await page.goto(BASE_URL, { waitUntil: "load" });
    await waitForCanvasReady(page);

    console.log("=== 01-hook ===");
    await openFile(page, hookSourceFile);
    await waitForOpenDone(page, 60_000);
    await page.waitForTimeout(FIRST_LOAD_PAUSE_MS);
    results["01-hook"] = await record(page, "01-hook", async () => {
      await orbitAndZoom(page);
    });

    console.log("=== 05-color-modes ===");
    await resetView(page);
    const colorSelect = page.locator('label:has-text("着色") + select');
    const rgbDisabled = await colorSelect.locator('option[value="rgb"]').getAttribute("disabled");
    results["05-color-modes"] = await record(page, "05-color-modes", async () => {
      for (const mode of ["elevation", "intensity", "classification"]) {
        await colorSelect.selectOption(mode);
        await page.waitForTimeout(1100);
      }
      if (rgbDisabled === null) {
        await colorSelect.selectOption("rgb");
        await page.waitForTimeout(1100);
      } else {
        console.log("  [05-color-modes] autzenはRGBを持たないためRGB選択はスキップ(disabled)");
      }
    });

    console.log("=== 06-edl ===");
    await resetView(page);
    results["06-edl"] = await record(page, "06-edl", async () => {
      await openSettings(page);
      const edlCheckbox = page.locator('label:has-text("EDL（陰影") input[type="checkbox"]');
      const wasChecked = await edlCheckbox.isChecked();
      const turnEdlOff = () => edlCheckbox.click();
      const turnEdlBackOn = () => edlCheckbox.click();
      await turnEdlOff();
      await closeSettings(page);
      await page.waitForTimeout(1500);
      await openSettings(page);
      await turnEdlBackOn();
      await closeSettings(page);
      await page.waitForTimeout(1500);
      console.log(`  [06-edl] 既定チェック状態: ${wasChecked}`);
    });

    console.log("=== 07-center-priority ===");
    await resetView(page);
    await setCenterPriorityStrength(page, "0");
    const cp0 = await record(page, "07-center-priority-0", async () => {
      await reloadByWheel(page);
    });
    await setCenterPriorityStrength(page, "4");
    const cp4 = await record(page, "07-center-priority-4", async () => {
      await reloadByWheel(page);
    });
    {
      const { ffmpeg } = await import("./lib/ffmpeg.mjs");
      const listPath = path.join(TMP_FRAMES, "07-center-priority-concat.txt");
      await fs_p.writeFile(
        listPath,
        [`file '${cp0.replace(/\\/g, "/")}'`, `file '${cp4.replace(/\\/g, "/")}'`].join("\n"),
        "utf8",
      );
      const outPath = path.join(FOOTAGE_DIR, "07-center-priority.mp4");
      await ffmpeg(["-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", outPath]);
      await fs_p.rm(cp0, { force: true });
      await fs_p.rm(cp4, { force: true });
      results["07-center-priority"] = outPath;
    }

    console.log("=== 04-web-convert ===");
    results["04-web-convert"] = await record(page, "04-web-convert", async () => {
      await openFile(page, AUTZEN_PCD);
      await waitForOpenDone(page, PCD_CONVERSION_TIMEOUT_MS);
      await page.waitForTimeout(500);
      const breakdown = page.locator("text=変換の内訳");
      if ((await breakdown.count()) > 0) {
        await breakdown.scrollIntoViewIfNeeded().catch(() => {});
        await page.waitForTimeout(2000);
      }
      await page.waitForTimeout(1500);
    });
  } finally {
    await browser.close();
  }

  console.log("\n=== 撮影結果 ===");
  for (const [k, v] of Object.entries(results)) console.log(`${k}: ${v}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
