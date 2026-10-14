// 内蔵GPU PC（ThinkBook）用の計測スクリプト。所有者が ThinkBook のデスクトップで
//   cd C:\pcv-bench; node bench.mjs            （小さな版: autzen・全体見下ろしだけ）
// と打つ。画面ありの Chromium を起動するので、ログイン中のデスクトップから実行すること
// （SSH から起動すると GPU が見えない。TaskSheets/BENCH-igpu-thinkbook.md 参照）。
// 点群データは C:\pcv-bench\data\ に置く（コミットしない）。
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(ROOT, "data");
const PORT = 8765;
const PAGE_URL = "https://dotob9.github.io/point-cloud-viewer/?pcvDebug";
const IDLE_SEC = Number(process.env.BENCH_IDLE_SEC ?? 30);
const DRAG_SEC = Number(process.env.BENCH_DRAG_SEC ?? 5);
const STEP_TIMEOUT_MS = 150000;

const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
const OUT = path.join(ROOT, "out", stamp);
fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log(new Date().toLocaleTimeString("ja-JP"), ...a);
const results = { stamp, steps: [], errors: [] };
const save = () => fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(results, null, 1));

// --- Range 対応・CORS 付きの配信サーバー（127.0.0.1 のみ） ---
function startServer() {
  const server = http.createServer((req, res) => {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Range, Content-Type",
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges",
      "Access-Control-Allow-Private-Network": "true", // https ページ → ループバックの取得用
    };
    if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
    const name = path.basename(decodeURIComponent(req.url.split("?")[0]));
    const file = path.join(DATA_DIR, name);
    if (!fs.existsSync(file)) { res.writeHead(404, cors); return res.end("not found"); }
    const size = fs.statSync(file).size;
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? "");
    if (m) {
      const start = m[1] === "" ? size - Number(m[2]) : Number(m[1]);
      const end = m[1] !== "" && m[2] !== "" ? Math.min(Number(m[2]), size - 1) : size - 1;
      res.writeHead(206, { ...cors, "Accept-Ranges": "bytes", "Content-Type": "application/octet-stream", "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1 });
      if (req.method === "HEAD") return res.end();
      fs.createReadStream(file, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { ...cors, "Accept-Ranges": "bytes", "Content-Type": "application/octet-stream", "Content-Length": size });
      if (req.method === "HEAD") return res.end();
      fs.createReadStream(file).pipe(res);
    }
  });
  return new Promise((resolve) => server.listen(PORT, "127.0.0.1", () => resolve(server)));
}

const withTimeout = (p, ms, label) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`タイムアウト(${ms / 1000}秒): ${label}`)), ms))]);
const median = (a) => { const b = [...a].sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : null; };
const p95 = (a) => { const b = [...a].sort((x, y) => x - y); return b.length ? b[Math.floor(b.length * 0.95)] : null; };
const frameStats = (a) => ({ n: a.length, medianMs: median(a), p95Ms: p95(a), maxMs: a.length ? Math.max(...a) : null });

// 設定の変え方: ページ内の renderer（?pcvDebug で window.__pcvRenderer に出る）のメソッドを直接呼ぶ
const CONFIGS = {
  default: async () => {},
  scale05: (page) => page.evaluate(() => window.__pcvRenderer.setRenderScale(0.5)),
  budgetQuarter: (page) => page.evaluate(() => {
    const r = window.__pcvRenderer;
    r.setAutoPointBudgetEnabled(false);
    r.setPointBudget(Math.round(r.getAutoPointBudgetMax() / 4));
  }),
};
const VIEWS = {
  overview: null, // ファイルを開いた直後の既定の視点
};

async function measure(page, file, viewName, configName) {
  const tag = `${file.replace(/\.copc\.laz$/, "")}-${viewName}-${configName}`;
  const step = { tag, file, viewName, configName };
  results.steps.push(step);
  try {
    log(`[${tag}] 開く`);
    await withTimeout(page.goto(PAGE_URL), 60000, "ページを開く");
    step.pageMeta = await page.evaluate(() => ({
      scripts: [...document.querySelectorAll("script[src]")].map((s) => s.src),
      lastModified: document.lastModified,
    }));
    step.adapter = await page.evaluate(async () => {
      if (!navigator.gpu) return "navigator.gpu なし";
      const a = await navigator.gpu.requestAdapter();
      if (!a) return "adapter なし";
      const i = a.info;
      return { vendor: i.vendor, architecture: i.architecture, device: i.device, description: i.description, isFallbackAdapter: a.isFallbackAdapter ?? i.isFallbackAdapter };
    });
    step.screen = await page.evaluate(() => ({ w: screen.width, h: screen.height, dpr: devicePixelRatio, innerW: innerWidth, innerH: innerHeight, deviceMemory: navigator.deviceMemory ?? null, pointerCoarse: matchMedia("(pointer: coarse)").matches }));
    log(`[${tag}] adapter:`, JSON.stringify(step.adapter));
    if (typeof step.adapter === "string") throw new Error("GPU が見えない: " + step.adapter);

    await page.getByText("URLから開く").first().click();
    const input = page.getByPlaceholder("https://example.com/data.copc.laz");
    await input.fill(`http://127.0.0.1:${PORT}/${file}`);
    await input.press("Enter");
    await withTimeout(page.waitForFunction(() => window.__pcvRenderer, null, { timeout: STEP_TIMEOUT_MS }), STEP_TIMEOUT_MS, "renderer 待ち");

    await page.evaluate(() => {
      const r = window.__pcvRenderer;
      const orig = r.onStats;
      r.onStats = (s) => { window.__stats = s; if (orig) orig(s); };
      window.__frames = []; window.__budgetLog = [];
      let prev = performance.now();
      const loop = (t) => { window.__frames.push({ t, d: t - prev }); prev = t; requestAnimationFrame(loop); };
      requestAnimationFrame(loop);
      setInterval(() => { window.__budgetLog.push({ t: performance.now(), b: r.getPointBudget() }); }, 250);
    });
    await withTimeout(page.waitForFunction(() => window.__stats && window.__stats.drawnPoints > 0, null, { timeout: STEP_TIMEOUT_MS }), STEP_TIMEOUT_MS, "最初の描画待ち");

    // device-profile の判定（renderer が実際に使っている値）
    step.deviceProfile = await page.evaluate(() => {
      const r = window.__pcvRenderer;
      return { isMobile: r.getIsMobile(), renderScale: r.getRenderScale(), pointShape: r.getPointShape(), edlEnabled: r.getEdlEnabled(), pointBudgetMax: r.getAutoPointBudgetMax(), pointBudgetNow: r.getPointBudget(), autoBudget: r.getAutoPointBudgetEnabled() };
    });
    log(`[${tag}] device-profile:`, JSON.stringify(step.deviceProfile));

    await CONFIGS[configName](page);
    step.configApplied = await page.evaluate(() => { const r = window.__pcvRenderer; return { renderScale: r.getRenderScale(), pointBudget: r.getPointBudget(), autoBudget: r.getAutoPointBudgetEnabled() }; });
    if (VIEWS[viewName]) await page.evaluate((cam) => { const c = window.__pcvRenderer.camera; c.target = cam.target; c.distance = cam.distance; c.pitch = cam.pitch; c.yaw = cam.yaw; }, VIEWS[viewName]);

    const snap = () => page.evaluate(() => { const s = window.__stats; return { t: performance.now(), drawn: s.drawnPoints, nodes: s.drawnNodes, loading: s.loadingNodes, queued: s.queuedNodes, fps: s.fps, budget: window.__pcvRenderer.getPointBudget(), idleBoost: s.idleBoosting }; });

    // 1. 止めたまま
    log(`[${tag}] 止めたまま ${IDLE_SEC} 秒`);
    const t0 = await page.evaluate(() => performance.now());
    const series = [];
    const deadline = Date.now() + IDLE_SEC * 1000;
    while (Date.now() < deadline) { await page.waitForTimeout(1000); series.push(await withTimeout(snap(), 20000, "snap")); }
    const idleFrames = await page.evaluate((a) => window.__frames.filter((f) => f.t >= a).map((f) => f.d), t0 + 5000);
    step.idle = { series: series.map((s) => ({ ...s, t: Math.round((s.t - t0) / 100) / 10 })), maxDrawn: Math.max(...series.map((s) => s.drawn)), frames: frameStats(idleFrames) };
    await page.screenshot({ path: path.join(OUT, `${tag}-idle.png`) });
    log(`[${tag}] 止めた: 最大 ${step.idle.maxDrawn} 点, フレーム中央値 ${step.idle.frames.medianMs?.toFixed(1)} ms, p95 ${step.idle.frames.p95Ms?.toFixed(1)} ms`);

    // 2. ドラッグ
    log(`[${tag}] ドラッグ ${DRAG_SEC} 秒`);
    const mark = await page.evaluate(() => performance.now());
    const vp = page.viewportSize();
    const cx = vp.width / 2, cy = vp.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    const n = Math.round((DRAG_SEC * 1000) / 40);
    for (let k = 1; k <= n; k++) { await page.mouse.move(cx + Math.sin(k / 15) * 200, cy + Math.cos(k / 20) * 60); await page.waitForTimeout(40); }
    await page.mouse.up();
    const dragFrames = await page.evaluate((m) => window.__frames.filter((f) => f.t >= m + 200).map((f) => f.d), mark);
    const bl = await page.evaluate((m) => window.__budgetLog.filter((b) => b.t >= m).map((b) => b.b), mark);
    const after = await snap();
    step.drag = { frames: frameStats(dragFrames), budgetMin: Math.min(...bl), budgetMax: Math.max(...bl), drawnAfter: after.drawn };
    await page.screenshot({ path: path.join(OUT, `${tag}-drag.png`) });
    log(`[${tag}] ドラッグ: フレーム中央値 ${step.drag.frames.medianMs?.toFixed(1)} ms, 最大 ${step.drag.frames.maxMs?.toFixed(1)} ms`);
    step.ok = true;
  } catch (e) {
    step.ok = false;
    step.error = String(e?.stack ?? e);
    log(`[${tag}] 失敗: ${String(e).slice(0, 300)}`);
    try { await page.screenshot({ path: path.join(OUT, `${tag}-error.png`) }); } catch {}
  }
  step.consoleErrors = results.errors.splice(0);
  save();
}

const server = await startServer();
log(`配信サーバー起動 http://127.0.0.1:${PORT}  出力先 ${OUT}`);
let browser;
let closing = false;
const started = Date.now();
try {
  browser = await chromium.launch({ headless: false, args: ["--enable-unsafe-webgpu", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", "--window-size=1300,800",
    // https のページから http://127.0.0.1 を読むと、新しい Chromium は「ローカルネットワークへのアクセス」の許可待ちで
    // 止まる（開発機で確認: 要求が1つも出ず「読み込み中」のまま）。それを切る
    "--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessSendPreflights,BlockInsecurePrivateNetworkRequests"] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.bringToFront();
  page.on("console", (m) => { if (m.type() === "error") results.errors.push(m.text()); });
  page.on("pageerror", (e) => results.errors.push("pageerror: " + String(e)));
  browser.on("disconnected", () => { if (!closing) log("ブラウザが切断された（落ちた可能性）"); });

  // 小さな版: autzen・全体見下ろし・既定の設定だけ
  await measure(page, "autzen-classified.copc.laz", "overview", "default");
} catch (e) {
  results.fatal = String(e?.stack ?? e);
  log("致命的エラー:", String(e));
} finally {
  results.totalSec = Math.round((Date.now() - started) / 1000);
  save();
  closing = true;
  try { await browser?.close(); } catch {}
  server.close();
  log(`終了（${results.totalSec} 秒）。結果: ${OUT}`);
  process.exit(0);
}
