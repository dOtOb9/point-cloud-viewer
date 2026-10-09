// ffmpeg-static/ffprobe-staticの薄いラッパー。
// spawnの結果を待つPromise化と、よく使うffprobe問い合わせだけをここに置く。
import { spawn } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";

export const FFMPEG = ffmpegPath;
export const FFPROBE = ffprobeStatic.path;

/** @param {string} bin @param {string[]} args */
function run(bin, args) {
  return new Promise((resolve, reject) => {
    // stdin/stdoutは'ignore'にする(どちらも使わない。stdinを繋いだままにすると
    // 子プロセスが読み取り待ちでハングする事故が起きたため明示的に切る)。
    const child = spawn(bin, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stderr);
      } else {
        reject(new Error(`${bin} exited with code ${code}\n${stderr.slice(-4000)}`));
      }
    });
  });
}

/** ffmpegを実行する。失敗したらstderrを含むErrorを投げる。 */
export function ffmpeg(args) {
  return run(FFMPEG, ["-y", "-hide_banner", "-loglevel", "error", ...args]);
}

/** 動画/音声ファイルの長さ(秒)をffprobeで取る。 */
export function probeDurationSec(filePath) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      FFPROBE,
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", filePath],
      { windowsHide: true },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe failed for ${filePath}: ${stderr}`));
        return;
      }
      const sec = Number.parseFloat(stdout.trim());
      if (Number.isNaN(sec)) {
        reject(new Error(`ffprobe returned non-numeric duration for ${filePath}: ${stdout}`));
        return;
      }
      resolve(sec);
    });
  });
}

/** ffprobeの完全なJSON出力(stream+format)を取る。レポート用。 */
export function probeJson(filePath) {
  return new Promise((resolve, reject) => {
    const child = spawn(FFPROBE, ["-v", "error", "-show_format", "-show_streams", "-of", "json", filePath], {
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe failed for ${filePath}: ${stderr}`));
        return;
      }
      resolve(JSON.parse(stdout));
    });
  });
}
