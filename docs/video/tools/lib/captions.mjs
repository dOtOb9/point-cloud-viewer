import fs from "node:fs/promises";
import path from "node:path";

export const CAPTION_FONT = "C:\\Windows\\Fonts\\YuGothB.ttc";

export function toFilterPath(p) {
  return p.replace(/\\/g, "/").replace(/:/g, "\\:");
}

export function wrapCaption(text, maxChars = 28) {
  const lines = [];
  let current = "";
  for (const ch of text) {
    current += ch;
    if (current.length >= maxChars) {
      lines.push(current);
      current = "";
    }
  }
  if (current !== "") lines.push(current);
  return lines.join("\n");
}

export async function buildCaptionFilter(text, textFileDir, keyForFileName) {
  const wrapped = wrapCaption(text);
  const txtPath = path.join(textFileDir, `${keyForFileName}.caption.txt`);
  await fs.writeFile(txtPath, wrapped, "utf8");
  const fontArg = toFilterPath(CAPTION_FONT);
  const fileArg = toFilterPath(txtPath);
  return (
    `drawtext=fontfile='${fontArg}':textfile='${fileArg}':fontcolor=white:fontsize=40:line_spacing=10:` +
    `box=1:boxcolor=black@0.55:boxborderw=20:x=(w-text_w)/2:y=h-130-text_h`
  );
}

export async function buildSpeedBadgeFilter(textFileDir, keyForFileName) {
  const txtPath = path.join(textFileDir, `${keyForFileName}.badge.txt`);
  await fs.writeFile(txtPath, "早送り", "utf8");
  const fontArg = toFilterPath(CAPTION_FONT);
  const fileArg = toFilterPath(txtPath);
  return (
    `drawtext=fontfile='${fontArg}':textfile='${fileArg}':fontcolor=yellow:fontsize=34:` +
    `box=1:boxcolor=black@0.6:boxborderw=14:x=w-text_w-48:y=48`
  );
}
