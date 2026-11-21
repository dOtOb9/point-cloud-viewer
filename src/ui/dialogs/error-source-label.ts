import type { GpuErrorSource } from "../../renderer/gpu-error-log";

export const ERROR_SOURCE_LABEL: Record<GpuErrorSource, string> = {
  gpu: "WebGPU エラー",
  "node-read": "ノード読み出しエラー",
  conversion: "変換エラー",
  crs: "座標系の読み取りエラー",
  tool: "点群ツール",
  "file-dialog": "ファイル選択ダイアログのエラー",
  storage: "保存領域のエラー",
};
