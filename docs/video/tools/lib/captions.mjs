// 字幕(caption)の焼き込み用。ffmpegのdrawtextに渡すfilter文字列を組み立てる。
// textfile方式を使う(inline textだとffmpegのfilter文字列エスケープ(: ' \ ,)が
// 日本語+記号混じりの字幕だと事故りやすいため。textfileならUTF-8のテキストファイルを
// そのまま読ませるだけで済む)。
import fs from "node:fs/promises";
import path from "node:path";

// 日本語フォント(太字)。CLAUDE.mdの指示どおりYu GothicかMeiryoを使う。
export const CAPTION_FONT = "C:\\Windows\\Fonts\\YuGothB.ttc";

/** ffmpegのfilter引数内で使うパスは/区切り+コロンのエスケープが要る。 */
export function toFilterPath(p) {
  return p.replace(/\\/g, "/").replace(/:/g, "\\:");
}

/** 長い字幕を1行あたりmaxCharsで折り返す(日本語は分かち書きが無いため文字数で割る)。
 *  28文字 × fontsize40pxだと、英数字混じりでもだいたい1920pxの画角に収まる
 *  (実際に書き出して確認した。CARDS_DIRのプレースホルダ枠と被らない余白も兼ねる)。 */
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

/** 字幕テキストをtextfileとして書き出し、drawtextのfilter文字列を返す。 */
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

/** 「早送り」バッジ用のdrawtext filter文字列(右上)。 */
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
