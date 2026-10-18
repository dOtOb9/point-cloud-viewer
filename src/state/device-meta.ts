// M4-12: device info for the breakdown text of a conversion.
// Used by: src/app/file-opener.ts.
import type { ConversionBreakdownMeta } from "../datasource/conversion-breakdown";

/** `navigator.deviceMemory` is Chrome-only; it is left undefined when missing. */
export function currentDeviceMeta(): Pick<ConversionBreakdownMeta, "browser" | "hardwareConcurrency" | "deviceMemoryGiB"> {
  const nav = navigator as Navigator & { deviceMemory?: number };
  return {
    browser: nav.userAgent,
    hardwareConcurrency: nav.hardwareConcurrency,
    deviceMemoryGiB: nav.deviceMemory,
  };
}
