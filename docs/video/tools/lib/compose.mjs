import fs from "node:fs";
import fs_p from "node:fs/promises";
import path from "node:path";
import { ffmpeg, probeDurationSec } from "./ffmpeg.mjs";
import { buildCaptionFilter, buildSpeedBadgeFilter } from "./captions.mjs";
import { renderCardToPng } from "./cards.mjs";
import { CARDS_DIR, FOOTAGE_DIR } from "./paths.mjs";

const FPS = 30;
const WIDTH = 1920;
const HEIGHT = 1080;
const SCALE_PAD = `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease,pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2`;

async function buildStillVisual(cardFileName, durationSec, tmpDir, key) {
  const pngPath = path.join(tmpDir, `${key}.png`);
  await renderCardToPng(cardFileName, pngPath);
  const outPath = path.join(tmpDir, `${key}.visual.mp4`);
  await ffmpeg([
    "-loop",
    "1",
    "-i",
    pngPath,
    "-t",
    durationSec.toFixed(3),
    "-vf",
    `${SCALE_PAD},format=yuv420p`,
    "-r",
    String(FPS),
    "-an",
    "-c:v",
    "libx264",
    "-profile:v",
    "high",
    "-pix_fmt",
    "yuv420p",
    outPath,
  ]);
  return { path: outPath, speedUp: false };
}

async function buildFootageVisual(footageFileName, durationSec, tmpDir, key) {
  const srcPath = path.join(FOOTAGE_DIR, footageFileName);
  const srcDur = await probeDurationSec(srcPath);
  const outPath = path.join(tmpDir, `${key}.visual.mp4`);
  let speedUp = false;

  if (srcDur >= durationSec * 0.98) {
    const factor = srcDur / durationSec;
    speedUp = factor > 1.05;
    await ffmpeg([
      "-i",
      srcPath,
      "-vf",
      `setpts=PTS*${(1 / factor).toFixed(6)},${SCALE_PAD},format=yuv420p,fps=${FPS}`,
      "-t",
      durationSec.toFixed(3),
      "-an",
      "-c:v",
      "libx264",
      "-profile:v",
      "high",
      "-pix_fmt",
      "yuv420p",
      outPath,
    ]);
  } else {
    await ffmpeg([
      "-stream_loop",
      "-1",
      "-i",
      srcPath,
      "-t",
      durationSec.toFixed(3),
      "-vf",
      `${SCALE_PAD},format=yuv420p,fps=${FPS}`,
      "-an",
      "-c:v",
      "libx264",
      "-profile:v",
      "high",
      "-pix_fmt",
      "yuv420p",
      outPath,
    ]);
  }
  return { path: outPath, speedUp };
}

function resolveVisualSource(visual) {
  if (visual.kind === "card") {
    return { kind: "card", file: visual.file };
  }
  if (visual.kind === "footage") {
    const p = path.join(FOOTAGE_DIR, visual.file);
    if (fs.existsSync(p)) {
      return { kind: "footage", file: visual.file };
    }
    return { kind: "card", file: visual.placeholder, isFallback: true };
  }
  throw new Error(`unknown visual kind: ${visual.kind}`);
}

async function buildVisualTrack(scene, durationSec, tmpDir) {
  const n = scene.visuals.length;
  const sliceDur = durationSec / n;
  const parts = [];
  const resolvedSources = [];
  let speedUpUsed = false;

  for (let i = 0; i < n; i++) {
    const resolved = resolveVisualSource(scene.visuals[i]);
    resolvedSources.push(resolved);
    const thisDur = i === n - 1 ? durationSec - sliceDur * (n - 1) : sliceDur;
    const key = `${scene.id}-v${i}`;
    if (resolved.kind === "card") {
      parts.push(await buildStillVisual(resolved.file, thisDur, tmpDir, key));
    } else {
      const r = await buildFootageVisual(resolved.file, thisDur, tmpDir, key);
      if (r.speedUp) speedUpUsed = true;
      parts.push(r);
    }
  }

  if (parts.length === 1) {
    return { path: parts[0].path, speedUpUsed, resolvedSources };
  }

  const listPath = path.join(tmpDir, `${scene.id}-concat.txt`);
  const listContent = parts.map((p) => `file '${p.path.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`).join("\n");
  await fs_p.writeFile(listPath, listContent, "utf8");
  const outPath = path.join(tmpDir, `${scene.id}-visual-concat.mp4`);
  await ffmpeg(["-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", outPath]);
  return { path: outPath, speedUpUsed, resolvedSources };
}

export async function composeScene(scene, narrationWavPath, narrationDurSec, opts) {
  const { paddingHeadSec, paddingTailSec, minSceneSec, tmpDir, outPath } = opts;
  await fs_p.mkdir(tmpDir, { recursive: true });

  const rawDuration = narrationDurSec + paddingHeadSec + paddingTailSec;
  const durationSec = Math.max(rawDuration, minSceneSec);

  const { path: visualPath, speedUpUsed, resolvedSources } = await buildVisualTrack(scene, durationSec, tmpDir);

  const captionFilter = await buildCaptionFilter(scene.caption, tmpDir, scene.id);
  const filters = [captionFilter];
  if (speedUpUsed) {
    filters.push(await buildSpeedBadgeFilter(tmpDir, scene.id));
  }
  const captionedPath = path.join(tmpDir, `${scene.id}-captioned.mp4`);
  await ffmpeg([
    "-i",
    visualPath,
    "-vf",
    filters.join(","),
    "-c:v",
    "libx264",
    "-profile:v",
    "high",
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(FPS),
    "-an",
    captionedPath,
  ]);

  const delayMs = Math.round(paddingHeadSec * 1000);
  await ffmpeg([
    "-i",
    captionedPath,
    "-i",
    narrationWavPath,
    "-filter_complex",
    `[1:a]adelay=${delayMs}|${delayMs},apad[aout]`,
    "-map",
    "0:v",
    "-map",
    "[aout]",
    "-t",
    durationSec.toFixed(3),
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-ar",
    "48000",
    "-ac",
    "2",
    "-b:a",
    "192k",
    outPath,
  ]);

  return { durationSec, speedUpUsed, resolvedSources };
}
