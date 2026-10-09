// 07-center-priorityだけを撮り直すための単独スクリプト。
//
// 最初の実装は「録画しながら設定画面を開いてスライダーを変える」を2回繰り返す
// 形だったが、スライダーを0以外(4)にした直後に閉じるボタンのクリックが数十秒
// 固まる事故が何度も起きた(centerPriorityStrengthを上げた直後、再読み込み中の
// ノードの優先度計算が重くなりJSのメインスレッドが長時間ブロックされ、
// Playwrightのクリックが処理されなくなっていると見ている。未確定・未調査)。
//
// 対策として、**設定の変更とUIクリックは録画していない間に済ませ**、録画中は
// カメラのホイール操作だけを行う形に作り直した。強さ0の場面と4の場面を
// 別々に録画し、最後にffmpegで連結して1本のfootageにする
// (TaskSheets/VIDEO-intro.md参照)。
import fs from "node:fs";
import fs_p from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";
import { startScreencast, framesToMp4 } from "./record.mjs";
import { ffmpeg } from "./ffmpeg.mjs";
import { FOOTAGE_DIR, AUTZEN_COPC } from "./paths.mjs";

const BASE_URL = process.env.PCV_PREVIEW_URL ?? "http://127.0.0.1:4555/";
const TMP_FRAMES = path.join(process.env.TEMP ?? "C:\\Windows\\Temp", "pcv-video-capture");

const CHROMIUM_ARGS = [
  "--enable-unsafe-webgpu",
  "--enable-features=Vulkan,WebGPU,WebGPUDeveloperFeatures",
  "--use-angle=d3d11",
  "--disable-gpu-sandbox",
  "--ignore-gpu-blocklist",
];

function setRangeValue(el, v) {
  const proto = Object.getPrototypeOf(el);
  const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
  setter.call(el, v);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

/** strengthを設定画面のUI操作無しで直接スライダーへ反映し、設定画面は開かない
 *  (開閉のクリックそのものが固まる事故を避けるため、DOM操作だけで完結させる)。
 *  SettingsModalは`open`がfalseだとDOMから消えるコンポーネントなので、
 *  スライダーを操作するにはモーダルを開く必要はある。ただし「開く→評価→閉じる」を
 *  録画の外(このヘルパー関数内)だけで完結させ、録画中には一切触らない。 */
async function setCenterPriorityStrength(page, value) {
  await page.locator('[data-ui-id="settings_button"]').click();
  await page.waitForSelector("#center-priority-strength", { state: "visible", timeout: 10_000 });
  const slider = page.locator("#center-priority-strength");
  await slider.evaluate(setRangeValue, value);
  await page.waitForTimeout(300);
  await page.locator('button[aria-label="設定を閉じる"]').click();
  await page.waitForTimeout(300);
}

/** カメラをホイールで動かしてLODの再読み込みを起こしつつ、durationMsだけ録画する。 */
async function recordReload(page, label, durationMs) {
  const frameDir = path.join(TMP_FRAMES, label);
  await fs_p.rm(frameDir, { recursive: true, force: true });
  const rec = await startScreencast(page, frameDir);
  await page.mouse.wheel(0, 300);
  await page.waitForTimeout(150);
  await page.mouse.wheel(0, -300);
  await page.waitForTimeout(durationMs);
  const frames = await rec.stop();
  console.log(`  [${label}] ${frames.length}フレーム`);
  const outPath = path.join(TMP_FRAMES, `${label}.mp4`);
  await framesToMp4(frames, outPath, TMP_FRAMES);
  return outPath;
}

async function main() {
  if (!fs.existsSync(AUTZEN_COPC)) throw new Error(`データが無い: ${AUTZEN_COPC}`);
  await fs_p.mkdir(FOOTAGE_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: false, args: CHROMIUM_ARGS });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  page.on("pageerror", (err) => console.log("[pageerror]", String(err)));

  let clip0;
  let clip4;
  try {
    await page.goto(BASE_URL, { waitUntil: "load" });
    await page.waitForSelector("canvas", { state: "visible", timeout: 15000 });

    const input = page.locator('input[type="file"]');
    await input.setInputFiles(AUTZEN_COPC);
    await page.waitForTimeout(400);
    await page.waitForFunction(
      () => {
        const el = document.querySelector('input[type="file"]');
        return el && !el.disabled;
      },
      undefined,
      { timeout: 30_000 },
    );
    await page.waitForTimeout(800);
    console.log("autzen opened");

    await setCenterPriorityStrength(page, "0");
    console.log("strength=0 set (録画の外)");
    clip0 = await recordReload(page, "07-center-priority-0", 1800);

    await setCenterPriorityStrength(page, "4");
    console.log("strength=4 set (録画の外)");
    clip4 = await recordReload(page, "07-center-priority-4", 1800);
  } finally {
    await browser.close();
  }

  const listPath = path.join(TMP_FRAMES, "07-center-priority-concat.txt");
  await fs_p.writeFile(
    listPath,
    [`file '${clip0.replace(/\\/g, "/")}'`, `file '${clip4.replace(/\\/g, "/")}'`].join("\n"),
    "utf8",
  );
  const outPath = path.join(FOOTAGE_DIR, "07-center-priority.mp4");
  await ffmpeg(["-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", outPath]);
  console.log("->", outPath);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
