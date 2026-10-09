#!/usr/bin/env node
// Web版(vite preview)をheadedのchromiumで操作し、docs/video/footage/ に
// 実機映像(mp4)を書き出す。対象は「自分たちで撮れる」とdesignで決めた5カット
// (01-hook / 04-web-convert / 05-color-modes / 06-edl / 07-center-priority)。
// Windows実機・Android実機・大規模データのカットは所有者にしか撮れないため対象外
// (docs/video/cards/*-placeholder.htmlのままになる)。
//
// 前提: `npm run build && npm run preview -- --port 4555 --strictPort --host 127.0.0.1` を
// リポジトリルートで実行済み(wasmバインディングはコミット済みなので`npm run build:wasm`は不要)。
// ポート4173ではなく4555を使うのは、同じマシンで動く別のツール(ui-forgeのpreview等)と
// 衝突したため(TaskSheets/VIDEO-intro.md参照。--strictPortを付けていても、別ポートの
// サーバーに繋いでしまい「canvasが出ない」で長時間ハマった)。
// このスクリプト自身はpreviewサーバーを起動しない(ビルド成果物の鮮度をスクリプトが
// 勝手に決めないため。起動済みか確認だけする)。
//
// WebGPUをheaded chromiumで有効にするフラグの組み合わせは事前に試して確認した
// (このファイルのCHROMIUM_ARGS。TaskSheets/VIDEO-intro.mdに記録)。
import fs from "node:fs";
import fs_p from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";
import { startScreencast, framesToMp4 } from "./lib/record.mjs";
import { FOOTAGE_DIR, AUTZEN_COPC, AUTZEN_PCD, TOKYO_SHIBUYA_COPC } from "./lib/paths.mjs";

const BASE_URL = process.env.PCV_PREVIEW_URL ?? "http://127.0.0.1:4555/";
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
  // WebGPU対応チェック画面("非対応")に落ちていないか確認。
  const unsupported = await page.locator("text=非対応").count();
  if (unsupported > 0) {
    throw new Error("UnsupportedDeviceScreenが表示された(WebGPUが使えていない)");
  }
}

/** 設定モーダルの開閉やホイール連打の後、file inputが消えている(原因未特定)ことが
 *  あったため、無ければ1回だけページを読み込み直して復旧を試みる。 */
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
  // 「開いています…」「変換しています…」ボタン文言が消え、エラーも出ていないことを待つ。
  // LayerPanel.tsxの実装通り、busy中はファイル選択inputがdisabledになるのでそれで判定する。
  // setInputFiles直後はReactの再描画がまだ反映されていないことがあるため、
  // 一呼吸置いてから監視を始める(でないとbusyになる前に「非busy」を誤検知する)。
  await page.waitForTimeout(400);
  // 第2引数はpredicateへのarg。{timeout}だけを2引数目に渡すと既定の30秒タイムアウトの
  // ままになる事故があったため、argにundefinedを明示して3引数目にoptionsを渡す。
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
  // fn()自体が固まる事故があった(center-priorityのスライダー操作で、大量のノード
  // 再優先度付けがGPU/レンダーループを詰まらせ、CDPのscreencastが応答しなくなる
  // ケースがあったと見ている。未特定)。ここで25秒の上限を設け、超えたら
  // その時点までに撮れたフレームだけで動画化する(1カットの事故で撮影全体を
  // 止めない)。
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
  // ホイールでズームイン(弱め。強くしすぎると点群を通り過ぎて何も映らない
  // 画角まで寄ってしまい、このシーンの後半や次のシーンの最初の画が真っ黒〜ほぼ空に
  // なる事故があった。TaskSheets/VIDEO-intro.md参照)。
  for (let i = 0; i < 4; i++) {
    await page.mouse.wheel(0, -80);
    await page.waitForTimeout(90);
  }
}

/** カメラ視点をautzenの既定フィット view に戻す(サンプルを開き直すだけ。
 *  openFileは毎回カメラを点群のbounding boxに合わせて再フィットするため、
 *  「ズームしすぎて何も映らない」状態から次のシーンを安全に始め直せる)。 */
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

/** 中央優先度の強さを変える。録画が始まる前に(録画の外で)呼ぶこと。
 *  強さを0以外にした直後に設定を閉じるクリックをすると、再読み込み中のノードの
 *  優先度再計算が重くなりJSのメインスレッドが長時間ブロックされて、Playwrightの
 *  クリックが数十秒固まる事故が繰り返し起きた(未確定・未調査。
 *  TaskSheets/VIDEO-intro.md参照)。録画していない間にこの関数で値を変えておき、
 *  録画中は視点操作だけを行う設計にすることで回避する。 */
async function setCenterPriorityStrength(page, value) {
  await openSettings(page);
  await page.waitForSelector("#center-priority-strength", { state: "visible", timeout: 10_000 });
  const slider = page.locator("#center-priority-strength");
  await slider.evaluate(setRangeValue, value);
  await page.waitForTimeout(300);
  await closeSettings(page);
  await page.waitForTimeout(300);
}

/** カメラをホイールで軽く動かしてLODの再読み込みを起こす(視点は実質同じ場所へ戻る)。 */
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

  // つかみの場面(01-hook)は、数億点規模の公開データ(東京都デジタルツイン実現
  // プロジェクト 区部点群データ)が用意できていればそれを使う。無ければautzenのまま
  // (誇張しない言い回しでscenes.jsonを書いてある。TaskSheets/VIDEO-intro.md参照)。
  const hookSourceFile = fs.existsSync(TOKYO_SHIBUYA_COPC) ? TOKYO_SHIBUYA_COPC : AUTZEN_COPC;
  console.log(`01-hookの撮影に使うファイル: ${hookSourceFile}`);

  const browser = await chromium.launch({ headless: false, args: CHROMIUM_ARGS });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });

  const results = {};

  try {
    await page.goto(BASE_URL, { waitUntil: "load" });
    await waitForCanvasReady(page);

    // --- 01-hook: 開いて回す・寄る(大規模データがあればそれを、無ければautzenを使う) ---
    console.log("=== 01-hook ===");
    await openFile(page, hookSourceFile);
    await waitForOpenDone(page, 60_000);
    await page.waitForTimeout(800); // 初期ロードの詰まりを少し見せる
    results["01-hook"] = await record(page, "01-hook", async () => {
      await orbitAndZoom(page);
    });

    // --- 05-color-modes: 標高→強度→分類→RGB ---
    console.log("=== 05-color-modes ===");
    // 01-hookのズームでカメラが点群を通り過ぎている可能性があるため、視点を戻してから撮る。
    await resetView(page);
    // "着色"ラベルの隣のselectを取る(LayerPanel.tsxの構造: <label>着色</label><select>...)
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

    // --- 06-edl: EDLオン/オフ ---
    console.log("=== 06-edl ===");
    await resetView(page);
    results["06-edl"] = await record(page, "06-edl", async () => {
      await openSettings(page);
      const edlCheckbox = page.locator('label:has-text("EDL（陰影") input[type="checkbox"]');
      const wasChecked = await edlCheckbox.isChecked();
      await edlCheckbox.click(); // オフ(既定オンのはずなので)
      await closeSettings(page);
      await page.waitForTimeout(1500);
      await openSettings(page);
      await edlCheckbox.click(); // 元に戻す(オン)
      await closeSettings(page);
      await page.waitForTimeout(1500);
      console.log(`  [06-edl] 既定チェック状態: ${wasChecked}`);
    });

    // --- 07-center-priority: 強さ0と4で同じ視点から読み込み直す ---
    // 値の変更(設定画面の開閉)は録画の外で行い、録画中はホイール操作だけにする
    // (理由はsetCenterPriorityStrengthのコメント参照)。0の場面と4の場面を別々に
    // 録画し、最後に連結する。
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

    // --- 04-web-convert: autzen.pcdをブラウザだけで変換 ---
    console.log("=== 04-web-convert ===");
    results["04-web-convert"] = await record(page, "04-web-convert", async () => {
      await openFile(page, AUTZEN_PCD);
      await waitForOpenDone(page, 600_000); // ブラウザでのPCD変換は実測で3分を超えることがあった
      await page.waitForTimeout(500);
      // 変換の内訳パネルが出ていれば少し見せる
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
