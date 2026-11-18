import fs from "node:fs/promises";
import path from "node:path";
import { ffmpeg } from "./ffmpeg.mjs";

function withTimeout(promise, ms, fallbackValue) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        resolve(fallbackValue);
      }
    }, ms);
    promise.then(
      (v) => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          resolve(v);
        }
      },
      () => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          resolve(fallbackValue);
        }
      },
    );
  });
}

export async function startScreencast(page, frameDir) {
  await fs.mkdir(frameDir, { recursive: true });
  const client = await page.context().newCDPSession(page);
  const frames = [];
  let seq = 0;
  let stopped = false;

  client.on("Page.screencastFrame", (params) => {
    if (stopped) return;
    const idx = seq++;
    const filePath = path.join(frameDir, `f${String(idx).padStart(6, "0")}.png`);
    const buf = Buffer.from(params.data, "base64");
    const writePromise = fs.writeFile(filePath, buf);
    frames.push({ idx, filePath, tsMs: Date.now(), writePromise });
    withTimeout(
      client.send("Page.screencastFrameAck", { sessionId: params.sessionId }),
      3000,
      undefined,
    ).catch(() => {});
  });

  await client.send("Page.startScreencast", {
    format: "png",
    quality: 90,
    maxWidth: 1920,
    maxHeight: 1080,
    everyNthFrame: 1,
  });

  return {
    async stop() {
      stopped = true;
      await withTimeout(client.send("Page.stopScreencast"), 5000, undefined);
      await withTimeout(Promise.all(frames.map((f) => f.writePromise)), 10000, undefined);
      await withTimeout(client.detach(), 3000, undefined);
      return frames.sort((a, b) => a.idx - b.idx);
    },
  };
}

export async function framesToMp4(frames, outPath, tmpDir) {
  if (frames.length < 2) {
    throw new Error(`frames too few (${frames.length}) to build a video: ${outPath}`);
  }
  const listPath = path.join(tmpDir, `${path.basename(outPath)}.concat.txt`);
  const lines = [];
  for (let i = 0; i < frames.length; i++) {
    const dur = i < frames.length - 1 ? Math.max(1, frames[i + 1].tsMs - frames[i].tsMs) / 1000 : 1 / 30;
    lines.push(`file '${frames[i].filePath.replace(/\\/g, "/")}'`);
    lines.push(`duration ${dur.toFixed(4)}`);
  }
  lines.push(`file '${frames[frames.length - 1].filePath.replace(/\\/g, "/")}'`);
  await fs.writeFile(listPath, lines.join("\n"), "utf8");

  await ffmpeg([
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listPath,
    "-vf",
    "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,fps=30,format=yuv420p",
    "-c:v",
    "libx264",
    "-profile:v",
    "high",
    "-pix_fmt",
    "yuv420p",
    outPath,
  ]);

  const totalMs = frames[frames.length - 1].tsMs - frames[0].tsMs;
  return { frameCount: frames.length, rawDurationSec: totalMs / 1000 };
}
