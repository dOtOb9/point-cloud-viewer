// 内蔵GPU PC（ThinkBook）用の計測スクリプト（完全版）。所有者が ThinkBook のデスクトップで
//   cd C:\pcv-bench; node bench.mjs                 （完全版。15分以内）
//   cd C:\pcv-bench; node bench.mjs autzen-default  （名前に一致するセッションだけ。動作確認用）
// と打つ。画面ありの Chromium を起動するので、ログイン中のデスクトップから実行すること
// （SSH から起動すると GPU が見えない。TaskSheets/BENCH-igpu-thinkbook.md 参照）。
// 点群データは C:\pcv-bench\data\ に置く（コミットしない）。
//
// 構成: 「セッション」= データ1つ + 設定1つ。セッションごとにブラウザを起動し直す（GPU が落ちても次へ進める）。
// 1セッションの中で、視点3つ（全体見下ろし・街区・通り）を、止めたまま N 秒 → ドラッグ 5 秒で測る。
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(ROOT, "data");
const PORT = 8765;
const PAGE_URL = "https://dotob9.github.io/point-cloud-viewer/?pcvDebug";
const DRAG_SEC = Number(process.env.BENCH_DRAG_SEC ?? 5);
const LOAD_TIMEOUT_MS = 120000;
const SESSION_TIMEOUT_MS = 240000; // 1セッションの上限。超えたら記録してブラウザを閉じ、次へ
const TOTAL_BUDGET_MS = 14 * 60 * 1000; // これを超えたら残りのセッションは始めない
const FILTER = process.argv[2] ?? "";

const AUTZEN = "autzen-classified.copc.laz";
const SHIBUYA = "tokyo-shibuya-merged-v2.copc.laz";

// 設定の変え方: ページ内の renderer（?pcvDebug で window.__pcvRenderer に出る）のメソッドを直接呼ぶ。
// big = 窓を ThinkBook の実画面の大きさにする（解像度は既定の 1.0 のまま）。画素数を変えたときの違いを見るため。
const CONFIGS = {
  default: { idleSec: 25, note: "既定のまま。窓 1280x720" },
  scale05: { idleSec: 12, scale: 0.5, note: "解像度 0.5（画素数 1/4）。窓 1280x720" },
  budgetQuarter: { idleSec: 12, budgetQuarter: true, note: "自動調整を切り、点予算を上限の 1/4 に固定。窓 1280x720" },
  big: { idleSec: 12, big: true, note: "解像度 1.0 のまま、窓を画面いっぱいにする（画素数が増える）" },
  edloff: { idleSec: 12, edlOff: true, note: "EDL オフ。窓 1280x720" },
};
// 時間の見積り: autzen 約 4 分、渋谷 約 6.5 分、合計 約 10〜11 分（読み込み待ちを含む）
const SESSIONS = [
  { file: AUTZEN, cfg: "default" },
  { file: AUTZEN, cfg: "scale05" },
  { file: AUTZEN, cfg: "big" },
  { file: SHIBUYA, cfg: "default" },
  { file: SHIBUYA, cfg: "scale05" },
  { file: SHIBUYA, cfg: "big" },
  { file: SHIBUYA, cfg: "budgetQuarter" },
  { file: SHIBUYA, cfg: "edloff" },
].filter((s) => `${s.file === SHIBUYA ? "shibuya" : "autzen"}-${s.cfg}`.includes(FILTER));

// 視点。渋谷は HQ-0 と同じ世界座標。autzen は座標を知らないので、開いた直後のカメラからの相対で決める。
const VIEW_NAMES = ["overview", "block", "street"];
function viewFor(file, name, initial) {
  if (name === "overview") return null; // 開いた直後の視点に戻す
  if (file === SHIBUYA) {
    const t = [-12000, -37800, 40];
    return name === "block" ? { target: t, distance: 400, pitch: 0.6, yaw: 2.0 } : { target: t, distance: 40, pitch: 0.1, yaw: 0.5 };
  }
  return name === "block"
    ? { target: initial.target, distance: initial.distance * 0.3, pitch: 0.6, yaw: 2.0 }
    : { target: initial.target, distance: initial.distance * 0.05, pitch: 0.1, yaw: 0.5 };
}

const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
const OUT = path.join(ROOT, "out", stamp);
fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log(new Date().toLocaleTimeString("ja-JP"), ...a);
const results = { stamp, filter: FILTER, sessions: [], skipped: [] };
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
const short = (f) => (f === SHIBUYA ? "shibuya" : "autzen");

async function runSession(sess, session, consoleErrors) {
  const { file, cfg } = sess;
  const conf = CONFIGS[cfg];
  const sid = `${short(file)}-${cfg}`;
  let browser;
  const closeBrowser = async () => { try { await browser?.close(); } catch {} };
  const body = async () => {
    log(`[${sid}] ブラウザを起動`);
    browser = await chromium.launch({
      headless: false,
      args: [
        "--enable-unsafe-webgpu", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
        conf.big ? "--start-maximized" : "--window-size=1300,800",
        // https のページから http://127.0.0.1 を読むと、新しい Chromium は「ローカルネットワークへのアクセス」の許可待ちで
        // 止まる（開発機で確認）。それを切る
        "--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessSendPreflights,BlockInsecurePrivateNetworkRequests",
      ],
    });
    // big は窓を最大化し、ビューポートの固定をやめる（実際の画面の大きさで描かせる）
    const page = await browser.newPage({ viewport: conf.big ? null : { width: 1280, height: 720 } });
    await page.bringToFront();
    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
    page.on("pageerror", (e) => consoleErrors.push("pageerror: " + String(e)));

    await withTimeout(page.goto(PAGE_URL), 60000, "ページを開く");
    session.pageMeta = await page.evaluate(() => ({ scripts: [...document.querySelectorAll("script[src]")].map((s) => s.src), lastModified: document.lastModified }));
    session.adapter = await page.evaluate(async () => {
      if (!navigator.gpu) return "navigator.gpu なし";
      const a = await navigator.gpu.requestAdapter();
      if (!a) return "adapter なし";
      const i = a.info;
      return { vendor: i.vendor, architecture: i.architecture, device: i.device, description: i.description, isFallbackAdapter: a.isFallbackAdapter ?? i.isFallbackAdapter };
    });
    session.screen = await page.evaluate(() => ({ w: screen.width, h: screen.height, availW: screen.availWidth, availH: screen.availHeight, dpr: devicePixelRatio, deviceMemory: navigator.deviceMemory ?? null, pointerCoarse: matchMedia("(pointer: coarse)").matches }));
    log(`[${sid}] adapter:`, JSON.stringify(session.adapter), " 画面:", JSON.stringify(session.screen));
    if (typeof session.adapter === "string") throw new Error("GPU が見えない: " + session.adapter);

    await page.getByText("URLから開く").first().click();
    const input = page.getByPlaceholder("https://example.com/data.copc.laz");
    await input.fill(`http://127.0.0.1:${PORT}/${file}`);
    await input.press("Enter");
    log(`[${sid}] ${file} を読み込み中`);
    await withTimeout(page.waitForFunction(() => window.__pcvRenderer, null, { timeout: LOAD_TIMEOUT_MS }), LOAD_TIMEOUT_MS, "renderer 待ち");
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
    await withTimeout(page.waitForFunction(() => window.__stats && window.__stats.drawnPoints > 0, null, { timeout: LOAD_TIMEOUT_MS }), LOAD_TIMEOUT_MS, "最初の描画待ち");
    await page.waitForTimeout(3000);

    session.deviceProfile = await page.evaluate(() => {
      const r = window.__pcvRenderer;
      return { isMobile: r.getIsMobile(), renderScale: r.getRenderScale(), pointShape: r.getPointShape(), edlEnabled: r.getEdlEnabled(), pointBudgetMax: r.getAutoPointBudgetMax(), pointBudgetNow: r.getPointBudget(), autoBudget: r.getAutoPointBudgetEnabled() };
    });
    log(`[${sid}] device-profile:`, JSON.stringify(session.deviceProfile));

    // 設定を変える
    await page.evaluate((c) => {
      const r = window.__pcvRenderer;
      if (c.scale) r.setRenderScale(c.scale);
      if (c.edlOff) r.setEdlEnabled(false);
      if (c.budgetQuarter) { r.setAutoPointBudgetEnabled(false); r.setPointBudget(Math.round(r.getAutoPointBudgetMax() / 4)); }
    }, conf);
    await page.waitForTimeout(1500);
    const initialCam = await page.evaluate(() => { const c = window.__pcvRenderer.camera; return { target: [...c.target], distance: c.distance, pitch: c.pitch, yaw: c.yaw }; });
    session.initialCamera = initialCam;
    session.configApplied = await page.evaluate(() => {
      const r = window.__pcvRenderer; const cv = document.querySelector("canvas");
      return { renderScale: r.getRenderScale(), edl: r.getEdlEnabled(), pointBudget: r.getPointBudget(), autoBudget: r.getAutoPointBudgetEnabled(), viewport: [innerWidth, innerHeight], canvasPx: cv ? [cv.width, cv.height] : null };
    });
    log(`[${sid}] 設定:`, conf.note, JSON.stringify(session.configApplied));

    const snap = () => page.evaluate(() => { const s = window.__stats; return { t: performance.now(), drawn: s.drawnPoints, nodes: s.drawnNodes, loading: s.loadingNodes, queued: s.queuedNodes, fps: s.fps, budget: window.__pcvRenderer.getPointBudget(), idleBoost: s.idleBoosting }; });

    for (const viewName of VIEW_NAMES) {
      const tag = `${sid}-${viewName}`;
      const vr = { view: viewName };
      session.views.push(vr);
      try {
        const cam = viewFor(file, viewName, initialCam) ?? initialCam;
        vr.camera = cam;
        await page.evaluate((cam) => { const c = window.__pcvRenderer.camera; c.target = [...cam.target]; c.distance = cam.distance; c.pitch = cam.pitch; c.yaw = cam.yaw; }, cam);
        log(`[${tag}] 止めたまま ${conf.idleSec} 秒`);
        const t0 = await page.evaluate(() => performance.now());
        const series = [];
        const deadline = Date.now() + conf.idleSec * 1000;
        while (Date.now() < deadline) { await page.waitForTimeout(1000); series.push(await withTimeout(snap(), 20000, "snap")); }
        const skip = Math.min(8000, (conf.idleSec * 1000) / 3);
        const idleFrames = await page.evaluate((a) => window.__frames.filter((f) => f.t >= a).map((f) => f.d), t0 + skip);
        vr.idle = { series: series.map((s) => ({ ...s, t: Math.round((s.t - t0) / 100) / 10 })), maxDrawn: Math.max(...series.map((s) => s.drawn)), lastDrawn: series[series.length - 1].drawn, frames: frameStats(idleFrames) };
        await page.screenshot({ path: path.join(OUT, `${tag}-idle.png`) });
        log(`[${tag}] 止めた: 描画 ${vr.idle.lastDrawn} 点, フレーム中央値 ${vr.idle.frames.medianMs?.toFixed(1)} ms, p95 ${vr.idle.frames.p95Ms?.toFixed(1)} ms`);

        log(`[${tag}] ドラッグ ${DRAG_SEC} 秒`);
        const mark = await page.evaluate(() => performance.now());
        const vp = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
        const cx = vp.width / 2, cy = vp.height / 2;
        await page.mouse.move(cx, cy);
        await page.mouse.down();
        const n = Math.round((DRAG_SEC * 1000) / 40);
        for (let k = 1; k <= n; k++) { await page.mouse.move(cx + Math.sin(k / 15) * 200, cy + Math.cos(k / 20) * 60); await page.waitForTimeout(40); }
        await page.mouse.up();
        const dragFrames = await page.evaluate((m) => window.__frames.filter((f) => f.t >= m + 200).map((f) => f.d), mark);
        const bl = await page.evaluate((m) => window.__budgetLog.filter((b) => b.t >= m).map((b) => b.b), mark);
        const after = await snap();
        vr.drag = { frames: frameStats(dragFrames), budgetMin: Math.min(...bl), budgetMax: Math.max(...bl), drawnAfter: after.drawn };
        await page.screenshot({ path: path.join(OUT, `${tag}-drag.png`) });
        log(`[${tag}] ドラッグ: フレーム中央値 ${vr.drag.frames.medianMs?.toFixed(1)} ms, p95 ${vr.drag.frames.p95Ms?.toFixed(1)} ms, 最大 ${vr.drag.frames.maxMs?.toFixed(1)} ms, 点予算 ${vr.drag.budgetMin}〜${vr.drag.budgetMax}`);
        vr.ok = true;
      } catch (e) {
        vr.ok = false; vr.error = String(e?.stack ?? e);
        log(`[${tag}] 失敗: ${String(e).slice(0, 300)}`);
        try { await withTimeout(page.screenshot({ path: path.join(OUT, `${tag}-error.png`) }), 10000, "screenshot"); } catch {}
        if (/タイムアウト|crash|closed|disconnected/i.test(String(e))) throw e; // 固まった・落ちたらセッションを打ち切る
      }
      save();
    }
  };
  try {
    await withTimeout(body(), SESSION_TIMEOUT_MS, `セッション ${sid} 全体（固まった可能性）`);
    session.ok = true;
  } catch (e) {
    session.ok = false;
    session.error = String(e?.stack ?? e);
    log(`[${sid}] セッション失敗: ${String(e).slice(0, 300)}`);
  }
  await closeBrowser();
}

const server = await startServer();
log(`配信サーバー起動 http://127.0.0.1:${PORT}  出力先 ${OUT}`);
log(`セッション ${SESSIONS.length} 個（全体で 10〜11 分の見込み。ウィンドウには触らないでください）`);
const started = Date.now();
try {
  for (const sess of SESSIONS) {
    const elapsed = Date.now() - started;
    if (elapsed > TOTAL_BUDGET_MS) {
      results.skipped.push(`${short(sess.file)}-${sess.cfg}（全体の上限 ${TOTAL_BUDGET_MS / 60000} 分を超えたため）`);
      log(`スキップ: ${short(sess.file)}-${sess.cfg}`);
      continue;
    }
    if (!fs.existsSync(path.join(DATA_DIR, sess.file))) {
      results.skipped.push(`${short(sess.file)}-${sess.cfg}（データが無い）`);
      log(`スキップ（データが無い）: ${sess.file}`);
      continue;
    }
    const session = { file: sess.file, cfg: sess.cfg, note: CONFIGS[sess.cfg].note, startedAtSec: Math.round(elapsed / 1000), views: [] };
    results.sessions.push(session);
    const consoleErrors = [];
    await runSession(sess, session, consoleErrors);
    session.consoleErrors = consoleErrors;
    save();
  }
} catch (e) {
  results.fatal = String(e?.stack ?? e);
  log("致命的エラー:", String(e));
} finally {
  results.totalSec = Math.round((Date.now() - started) / 1000);
  save();
  server.close();
  log(`終了（${results.totalSec} 秒）。結果: ${OUT}`);
  process.exit(0);
}
