import { saveSettingIfStorageAllows } from "./setting-storage";
export const MOTION_STORAGE_KEY = "pcv-animation-enabled";

export function readStoredAnimationEnabled(storage: Pick<Storage, "getItem"> | undefined): boolean {
  try {
    return storage?.getItem(MOTION_STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

export function storeAnimationEnabled(storage: Pick<Storage, "setItem"> | undefined, enabled: boolean): void {
  saveSettingIfStorageAllows(() => storage?.setItem(MOTION_STORAGE_KEY, String(enabled)));
}

export function applyMotionAttribute(root: { dataset: DOMStringMap }, enabled: boolean): void {
  if (enabled) delete root.dataset.motion;
  else root.dataset.motion = "off";
}

export function shouldSkipExitWait(root: { dataset: DOMStringMap } | undefined, osReducedMotion: boolean): boolean {
  return osReducedMotion || root?.dataset.motion === "off";
}
