// build-report.jsonの各シーンの尺から、完成した intro-draft.mp4 の中で
// そのシーンの「真ん中」にあたる時刻を計算し、1枚ずつ静止画として書き出す。
// 検証(各シーンが実際に映っているか目視確認)専用の使い捨てスクリプト。
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import { OUT_DIR, FINAL_MP4 } from "./paths.mjs";

const outDir = process.argv[2];
if (!outDir) {
  console.error("usage: node extract-frames.mjs <outDir>");
  process.exit(2);
}
await fs.mkdir(outDir, { recursive: true });

const report = JSON.parse(await fs.readFile(path.join(OUT_DIR, "build-report.json"), "utf8"));

let t = 0;
for (const scene of report.scenes) {
  const mid = t + scene.sceneDurSec / 2;
  const outPath = path.join(outDir, `${scene.id}.png`);
  await new Promise((resolve, reject) => {
    const child = spawn(
      ffmpegPath,
      ["-y", "-hide_banner", "-loglevel", "error", "-ss", mid.toFixed(3), "-i", FINAL_MP4, "-frames:v", "1", outPath],
      { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(stderr))));
  });
  console.log(`${scene.id}: t=${mid.toFixed(2)}s -> ${outPath}`);
  t += scene.sceneDurSec;
}
