import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NARRATION_DIR } from "./paths.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TTS_PS1 = path.join(__dirname, "tts.ps1");

function hashText(text) {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

export async function synthesizeNarration(sceneId, narrationText, { force = false } = {}) {
  await fs.mkdir(NARRATION_DIR, { recursive: true });
  const wavPath = path.join(NARRATION_DIR, `${sceneId}.wav`);
  const hashPath = path.join(NARRATION_DIR, `${sceneId}.hash`);
  const expectedHash = hashText(narrationText);

  if (!force) {
    try {
      const existingHash = (await fs.readFile(hashPath, "utf8")).trim();
      await fs.access(wavPath);
      if (existingHash === expectedHash) {
        return wavPath;
      }
    } catch {
    }
  }

  if (narrationText.trim() === "") {
    throw new Error(`scene ${sceneId}: narration が空文字です。無音が要るならlib/ffmpeg.mjs側でpaddingだけにする設計にすること。`);
  }

  await new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", TTS_PS1, "-Text", narrationText, "-OutPath", wavPath],
      { windowsHide: true },
    );
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`TTS failed for ${sceneId} (exit ${code}): ${stderr}`));
    });
  });

  await fs.writeFile(hashPath, expectedHash, "utf8");
  return wavPath;
}
