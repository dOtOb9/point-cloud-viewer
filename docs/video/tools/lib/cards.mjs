// docs/video/cards/*.html を1920x1080のPNGにスクリーンショットする。
// カード(タイトル・図・表・プレースホルダ)はWebGPUもJSの動きも要らない静的なHTMLなので、
// headlessのchromiumで十分(capture-app.mjsのアプリ撮影とは別。あちらはWebGPUが要るためheaded)。
import path from "node:path";
import { chromium } from "playwright-core";
import { CARDS_DIR } from "./paths.mjs";

let browserPromise = null;
function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({ headless: true });
  }
  return browserPromise;
}

/** カードHTML(docs/video/cards/<name>)をPNGにして返す(pngPathへ書き出す)。 */
export async function renderCardToPng(cardFileName, pngPath) {
  const browser = await getBrowser();
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  try {
    const url = "file:///" + path.join(CARDS_DIR, cardFileName).replace(/\\/g, "/");
    await page.goto(url, { waitUntil: "load" });
    // Google Fontsを使っていないので待つ必要は基本無いが、システムフォント読み込みの
    // 揺らぎを避けるため少しだけ待つ。
    await page.waitForTimeout(80);
    await page.screenshot({ path: pngPath });
  } finally {
    await page.close();
  }
}

export async function closeCardBrowser() {
  if (browserPromise) {
    const browser = await browserPromise;
    await browser.close();
    browserPromise = null;
  }
}
