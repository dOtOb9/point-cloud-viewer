import type { ConversionBreakdownMeta } from "../datasource/conversion-breakdown";

export function currentDeviceMeta(): Pick<ConversionBreakdownMeta, "browser" | "hardwareConcurrency" | "deviceMemoryGiB"> {
  const nav = navigator as Navigator & { deviceMemory?: number };
  return {
    browser: nav.userAgent,
    hardwareConcurrency: nav.hardwareConcurrency,
    deviceMemoryGiB: nav.deviceMemory,
  };
}
