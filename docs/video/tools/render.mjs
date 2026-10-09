#!/usr/bin/env node
// docs/video/scenes.json から docs/video/out/intro-draft.mp4 を作り直すメインスクリプト。
// `npm run build`(= `node render.mjs`)で実行する。
//
// 流れ: シーンごとに (1) ナレーションwavをTTSで用意 → (2) 画面素材(card/footage/placeholder)を
// シーン尺に合わせて切り出し・ループ・早送り → (3) 字幕を焼き込む → (4) ナレーションを乗せる
// → 最後に全シーンを連結する。
import fs from "node:fs/promises";
import path from "node:path";
import { synthesizeNarration } from "./lib/tts.mjs";
import { probeDurationSec, ffmpeg, probeJson } from "./lib/ffmpeg.mjs";
import { composeScene } from "./lib/compose.mjs";
import { closeCardBrowser } from "./lib/cards.mjs";
import { SCENES_JSON, OUT_DIR, SCENES_OUT_DIR, FINAL_MP4 } from "./lib/paths.mjs";

async function main() {
  const force = process.argv.includes("--force");
  const manifest = JSON.parse(await fs.readFile(SCENES_JSON, "utf8"));
  const { paddingHeadSec, paddingTailSec, minSceneSec, scenes } = manifest;

  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.mkdir(SCENES_OUT_DIR, { recursive: true });
  const tmpDir = path.join(OUT_DIR, "tmp");
  await fs.mkdir(tmpDir, { recursive: true });

  const report = [];
  const sceneMp4s = [];

  for (const scene of scenes) {
    process.stdout.write(`\n=== scene ${scene.id} ===\n`);
    const wavPath = await synthesizeNarration(scene.id, scene.narration, { force });
    const narrationDurSec = await probeDurationSec(wavPath);
    const outPath = path.join(SCENES_OUT_DIR, `${scene.id}.mp4`);

    const result = await composeScene(scene, wavPath, narrationDurSec, {
      paddingHeadSec,
      paddingTailSec,
      minSceneSec,
      tmpDir: path.join(tmpDir, scene.id),
      outPath,
    });

    console.log(
      `  narration: ${narrationDurSec.toFixed(2)}s / scene: ${result.durationSec.toFixed(2)}s / ` +
        `speedUp: ${result.speedUpUsed} / sources: ${JSON.stringify(result.resolvedSources)}`,
    );

    report.push({
      id: scene.id,
      narrationDurSec,
      sceneDurSec: result.durationSec,
      speedUpUsed: result.speedUpUsed,
      sources: result.resolvedSources,
    });
    sceneMp4s.push(outPath);
  }

  await closeCardBrowser();

  // 全シーンを連結する。concat demuxerはすべて同じコーデック設定(libx264/yuv420p/30fps,
  // aac/48kHz/stereo)で作っているのでそのまま繋がるはずだが、確実性を優先して
  // 最終段だけ明示的に再エンコードする(1回の動画ビルドでかかる時間より、
  // 「繋がらなかった」を後から調べる時間の方が高くつくため)。
  const listPath = path.join(tmpDir, "final-concat.txt");
  const listContent = sceneMp4s.map((p) => `file '${p.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`).join("\n");
  await fs.writeFile(listPath, listContent, "utf8");

  await ffmpeg([
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listPath,
    "-c:v",
    "libx264",
    "-profile:v",
    "high",
    "-pix_fmt",
    "yuv420p",
    "-r",
    "30",
    "-c:a",
    "aac",
    "-ar",
    "48000",
    "-ac",
    "2",
    "-b:a",
    "192k",
    FINAL_MP4,
  ]);

  const finalProbe = await probeJson(FINAL_MP4);
  const totalDurSec = Number.parseFloat(finalProbe.format.duration);

  console.log("\n=== 完成 ===");
  console.log(`出力: ${FINAL_MP4}`);
  console.log(`合計時間: ${totalDurSec.toFixed(2)}s (${Math.floor(totalDurSec / 60)}:${String(Math.floor(totalDurSec % 60)).padStart(2, "0")})`);

  const reportPath = path.join(OUT_DIR, "build-report.json");
  await fs.writeFile(
    reportPath,
    JSON.stringify({ builtAt: new Date().toISOString(), totalDurSec, scenes: report }, null, 2),
    "utf8",
  );
  console.log(`レポート: ${reportPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
