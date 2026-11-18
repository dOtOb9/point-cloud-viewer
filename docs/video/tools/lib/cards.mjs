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

export async function renderCardToPng(cardFileName, pngPath) {
  const browser = await getBrowser();
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  try {
    const url = "file:///" + path.join(CARDS_DIR, cardFileName).replace(/\\/g, "/");
    await page.goto(url, { waitUntil: "load" });
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
