// 動画パイプライン共通のパス定義。
// docs/video/tools/ 配下のスクリプトはすべてここからパスを取る(直書きしない)。
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// docs/video/tools/lib/ -> docs/video/
export const VIDEO_ROOT = path.resolve(__dirname, "..", "..");
export const TOOLS_ROOT = path.resolve(__dirname, "..");
export const SCENES_JSON = path.join(VIDEO_ROOT, "scenes.json");
export const CARDS_DIR = path.join(VIDEO_ROOT, "cards");
export const FOOTAGE_DIR = path.join(VIDEO_ROOT, "footage");
export const OUT_DIR = path.join(VIDEO_ROOT, "out");
export const SCENES_OUT_DIR = path.join(OUT_DIR, "scenes");
export const NARRATION_DIR = path.join(VIDEO_ROOT, "narration");
export const FINAL_MP4 = path.join(OUT_DIR, "intro-draft.mp4");

// 点群データ(gitignore対象。worktreeには無いので絶対パスで読む。CLAUDE.md参照)。
export const DATA_DIR = "C:\\rust\\point-cloud-viewer\\data";
export const AUTZEN_COPC = path.join(DATA_DIR, "autzen-classified.copc.laz");
export const AUTZEN_PCD = path.join(DATA_DIR, "autzen.pcd");
// 数億点規模の公開データ(東京都デジタルツイン実現プロジェクト 区部点群データ、CC BY 4.0)。
// 別エージェントがタイルを結合して用意する想定のファイル。無ければつかみの場面は
// autzenのまま・誇張しない言い回しで作る(capture-app.mjs/render.mjs参照)。
export const TOKYO_SHIBUYA_COPC = path.join(DATA_DIR, "tokyo-shibuya-merged.copc.laz");
