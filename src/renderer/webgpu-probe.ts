// Checks whether WebGPU is usable (navigator.gpu and requestAdapter()). Used by useWebGpuSupport.
// This file does not know React; it only uses DOM APIs.

export type WebGpuProbeResult =
  | {
      supported: true;
      vendor: string;
      architecture: string;
      device: string;
      description: string;
    }
  | {
      supported: false;
      reason: string;
    };

/** navigator.gpu の有無と requestAdapter() の成否を確認する。 */
export async function probeWebGpu(): Promise<WebGpuProbeResult> {
  if (!("gpu" in navigator) || navigator.gpu === undefined) {
    return { supported: false, reason: "navigator.gpu が存在しない" };
  }

  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      return { supported: false, reason: "requestAdapter() が null を返した" };
    }

    const info = adapter.info;
    return {
      supported: true,
      vendor: info?.vendor || "(unknown)",
      architecture: info?.architecture || "(unknown)",
      device: info?.device || "(unknown)",
      description: info?.description || "(unknown)",
    };
  } catch (e) {
    return { supported: false, reason: `requestAdapter() が例外を投げた: ${String(e)}` };
  }
}
