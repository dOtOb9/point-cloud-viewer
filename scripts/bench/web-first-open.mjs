import { createRequire } from "node:module";
import { spawn, execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const require = createRequire(new URL("../../package.json", import.meta.url));
const { chromium } = require("@playwright/test");

const USAGE = `usage: PCV_BENCH_OUT=<dir> node scripts/bench/web-first-open.mjs <scenario> <timeoutSec> <file> [file...]

Opens the files in the built app (vite preview, port PCV_BENCH_PORT, default 5311) in a headed Chromium with the real
GPU, and records the first-draw / settled times and the private memory of the browser's process tree.
Start the app first: GITHUB_PAGES_BUILD=true npm run build && npm run preview -- --port <PCV_BENCH_PORT> --strictPort
Pin node to the P cores (ProcessorAffinity 0xFFF, TaskSheets/BENCH-measurement-cores.md); Chromium inherits it.
PCV_BENCH_OUT: a directory outside the repository (the profile and the CSV can be large).
Result: <dir>/web-<scenario>.json. Read ranges with scripts/bench/summarize-runs.mjs, not by eye.`;

const [scenario, timeoutSecStr, ...files] = process.argv.slice(2);
if (!scenario || !timeoutSecStr || files.length === 0) {
  console.error(USAGE);
  process.exit(2);
}
const timeoutMs = Number(timeoutSecStr) * 1000;
const PORT = Number(process.env.PCV_BENCH_PORT ?? "5311");
const OUT_DIR = process.env.PCV_BENCH_OUT;
if (!OUT_DIR) throw new Error("set PCV_BENCH_OUT to a directory outside the repository");
const OUT = `${OUT_DIR}\\web-${scenario}`;
const userDir = `${OUT_DIR}\\profile-${scenario}`;

const ctx = await chromium.launchPersistentContext(userDir, {
  headless: false,
  viewport: { width: 1280, height: 720 },
  args: ["--enable-unsafe-webgpu", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", "--window-size=1300,800"],
});
const browserPid = (ctx.browser()?.process?.()?.pid) ?? null;
let rootPid = browserPid;
if (!rootPid) {
  const out = execFileSync("powershell", ["-NoProfile", "-Command",
    `(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*${userDir}*' -and $_.CommandLine -notlike '*--type=*' } | Select-Object -First 1).ProcessId`]).toString().trim();
  rootPid = Number(out);
}
const affinity = execFileSync("powershell", ["-NoProfile", "-Command", `(Get-Process -Id ${rootPid}).ProcessorAffinity.ToInt64()`]).toString().trim();
const sampler = spawn("powershell", ["-NoProfile", "-File", fileURLToPath(new URL("./sampler.ps1", import.meta.url)), "-RootPid", String(rootPid), "-Csv", `${OUT}.mem.csv`], { stdio: "ignore" });

const page = ctx.pages()[0] ?? (await ctx.newPage());
const consoleLines = [];
const errors = [];
page.on("console", (m) => { consoleLines.push(m.text()); if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push("pageerror: " + String(e)));

await page.addInitScript(() => {
  window.__ev = [];
  window.__stat = [];
  window.__counts = { reads: 0, readMsSum: 0, readBytes: 0, nodeLoaded: 0 };
  const ev = (name, extra) => window.__ev.push({ t: performance.now(), name, ...extra });
  document.addEventListener("change", (e) => { if (e.target && e.target.type === "file") ev("file-selected"); }, true);
  const origLog = console.log.bind(console);
  console.log = (...a) => { const s = a.join(" "); if (s.startsWith("[M1] opened")) ev("opened-log", { s }); origLog(...a); };
  let r;
  Object.defineProperty(window, "__pcvRenderer", {
    configurable: true,
    get() { return r; },
    set(v) {
      r = v;
      const addLayer = v.addLayer.bind(v);
      v.addLayer = (...a) => { ev("addLayer"); return addLayer(...a); };
      const readNode = v.readLayerNode.bind(v);
      v.readLayerNode = (key) => {
        const t0 = performance.now(); window.__counts.reads++;
        return readNode(key).then((buf) => { window.__counts.readMsSum += performance.now() - t0; window.__counts.readBytes += buf.byteLength; if (window.__counts.reads === 1 || !window.__firstRead) { window.__firstRead = true; ev("first-node-read-done", { ms: performance.now() - t0 }); } return buf; });
      };
      const loaded = v.handleNodeLoaded.bind(v);
      v.handleNodeLoaded = (k, n) => { const t0 = performance.now(); const x = loaded(k, n); window.__counts.nodeLoaded++; if (window.__counts.nodeLoaded === 1) ev("first-node-loaded", { handleMs: performance.now() - t0 }); return x; };
      const onStats = v.onStatsUpdate.bind(v);
      v.onStatsUpdate = (cb) => onStats((s) => { window.__stat.push({ t: performance.now(), d: s.drawnPoints, n: s.drawnNodes, l: s.loadingNodes, q: s.queuedNodes, fps: s.fps }); cb(s); });
    },
  });
});

await page.goto(`http://127.0.0.1:${PORT}/point-cloud-viewer/?pcvDebug`);
const adapter = await page.evaluate(async () => {
  if (!navigator.gpu) return "no navigator.gpu";
  const a = await navigator.gpu.requestAdapter();
  if (!a) return "no adapter";
  const i = a.info;
  return { vendor: i.vendor, architecture: i.architecture, device: i.device, description: i.description, isFallbackAdapter: a.isFallbackAdapter ?? i.isFallbackAdapter };
});
console.log("adapter", JSON.stringify(adapter), "root pid", rootPid, "affinity", affinity);
if (typeof adapter === "string" || adapter.isFallbackAdapter || /swiftshader/i.test(JSON.stringify(adapter))) { console.log("NOT A REAL GPU, abort"); await ctx.close(); process.exit(3); }

const openButton = page.getByTestId("open-button");
await openButton.waitFor({ timeout: 30000 });
await page.waitForFunction(() => window.__pcvRenderer, null, { timeout: 30000 });
const chooserP = page.waitForEvent("filechooser");
await openButton.click();
const chooser = await chooserP;
const t0page = await page.evaluate(() => { const t = performance.now(); window.__ev.push({ t, name: "file-selected" }); return t; });
const wall0 = Date.now();
await chooser.setFiles(files);

const t = async () => page.evaluate(() => ({ now: performance.now(), ev: window.__ev, stat: window.__stat.slice(-6), counts: window.__counts }));
let result = { scenario, files, adapter, affinity, outcome: "timeout" };
const deadline = Date.now() + timeoutMs;
const isConversion = !files.every((f) => /\.copc\.laz$/i.test(f));
let snap;
while (Date.now() < deadline) {
  await page.waitForTimeout(500);
  snap = await t();
  const hasOpened = snap.ev.some((e) => e.name === "opened-log");
  const last = snap.stat.slice(-2);
  const settled = last.length === 2 && last.every((s) => s.d > 0 && s.l === 0 && s.q === 0);
  if (await page.getByTestId("viewer-error").count()) { result.outcome = "viewer-error: " + (await page.getByTestId("viewer-error").first().innerText()); break; }
  if (settled && (!isConversion || hasOpened)) { result.outcome = "settled"; break; }
}
const all = await page.evaluate(() => ({ ev: window.__ev, stat: window.__stat, counts: window.__counts }));
const sel = all.ev.find((e) => e.name === "file-selected")?.t;
const rel = (x) => (x == null || sel == null ? null : +((x - sel) / 1000).toFixed(3));
const firstDraw = all.stat.find((s) => s.d > 0);
const settledStat = (() => { for (let i = 0; i < all.stat.length - 1; i++) { const a = all.stat[i], b = all.stat[i + 1]; if (a.d > 0 && a.l === 0 && a.q === 0 && b.d > 0 && b.l === 0 && b.q === 0) return a; } return null; })();
result = {
  ...result,
  t_addLayer_s: rel(all.ev.find((e) => e.name === "addLayer")?.t),
  t_opened_log_s: rel(all.ev.find((e) => e.name === "opened-log")?.t),
  t_first_node_read_s: rel(all.ev.find((e) => e.name === "first-node-read-done")?.t),
  first_node_read_ms: all.ev.find((e) => e.name === "first-node-read-done")?.ms,
  t_first_node_loaded_s: rel(all.ev.find((e) => e.name === "first-node-loaded")?.t),
  first_node_handle_ms: all.ev.find((e) => e.name === "first-node-loaded")?.handleMs,
  t_first_draw_s: rel(firstDraw?.t),
  first_draw_points: firstDraw?.d,
  t_settled_s: rel(settledStat?.t),
  settled_points: settledStat?.d, settled_nodes: settledStat?.n, fps_at_end: all.stat.at(-1)?.fps,
  counts: all.counts,
  opened_line: all.ev.find((e) => e.name === "opened-log")?.s,
  wall_since_select_s: +((Date.now() - wall0) / 1000).toFixed(1),
  errors: errors.slice(0, 10),
  breakdown: await page.getByTestId("conversion-breakdown").count() ? await page.getByTestId("conversion-breakdown").innerText() : null,
};
writeFileSync(`${OUT}.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
await ctx.close();
sampler.kill();
