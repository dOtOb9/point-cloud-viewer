// CDPのPage.startScreencastでchromiumの描画をPNG連番として受け取り、
// 可変フレーム間隔のままffmpegのconcat demuxer(各フレームにduration指定)で
// 30fps CFRの動画に組み直す。
//
// なぜrecordVideo(Playwright標準)でもscreenshot()の定間隔ループでもないか:
// - recordVideoは内部でソフトウェアエンコードしており画質が粗い(タスクの指示どおり、
//   ここでは採用しない)
// - screenshot()を33ms間隔で回す方法も試せるが、1920x1080のcaptureScreenshotは
//   1回ごとに50〜150ms程度かかり律速になる。startScreencastはchromium側が
//   実際にフレームが変わったときだけ非同期で送ってくるため、操作(ドラッグ・ホイール)に
//   対して取りこぼしが少ない
import fs from "node:fs/promises";
import path from "node:path";
import { ffmpeg } from "./ffmpeg.mjs";

/** promiseがmsミリ秒以内に終わらなければfallbackValueで諦める。
 *  CDPの`Page.stopScreencast`がまれに応答を返さないまま固まる事故が実際にあった
 *  (設定モーダルの開閉のように短時間に大きな画面差分が連発すると起きやすかった。
 *  原因は未特定)。録画1本の失敗で撮影全体を巻き込まないための保険。 */
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

/**
 * @param {import('playwright-core').Page} page
 * @param {string} frameDir フレームPNGを書き出す一時ディレクトリ
 */
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
    // 書き込みはawaitせずキューに積む(ack優先。フレーム順序はidxで保つ)。
    const writePromise = fs.writeFile(filePath, buf);
    frames.push({ idx, filePath, tsMs: Date.now(), writePromise });
    // ackもタイムアウト付きにする(放っておくと次のframeが来なくなるだけだが、
    // 応答待ちのPromiseが残留して`client`まわりを塞ぐ可能性を避ける)。
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
    /** 録画を止め、フレーム一覧(idx, filePath, tsMs)を返す。 */
    async stop() {
      stopped = true;
      // stopScreencast自体が応答を返さず固まった事故があったため、最大5秒で諦めて進める
      // (その時点までに書き出し済みのフレームだけで動画化する。1本の録画のハングで
      // 撮影全体が止まるよりましという判断)。
      await withTimeout(client.send("Page.stopScreencast"), 5000, undefined);
      await withTimeout(Promise.all(frames.map((f) => f.writePromise)), 10000, undefined);
      await withTimeout(client.detach(), 3000, undefined);
      return frames.sort((a, b) => a.idx - b.idx);
    },
  };
}

/**
 * startScreencastで得たフレーム列(時刻つき)をffmpegで1本のmp4にする。
 * フレーム間の実測間隔をそのままconcat demuxerのdurationに使うため、
 * 操作の間延び・詰まりが時間軸として保たれる(録画fpsが一定でなくてよい)。
 */
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
  // concat demuxerの仕様: 最後のfileはdurationが無視されるので、同じファイルをもう一度書く。
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
    // ^ scale/padの引数はwidth:heightを別パラメータで渡す(compose.mjsのSCALE_PAD参照。
    //   「1920x1080」1個にまとめるとffmpegがフィルタ初期化に失敗し、0バイト出力のまま
    //   先に進まなくなる事故があった)。
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
