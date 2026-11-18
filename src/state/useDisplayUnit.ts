import { useSyncExternalStore } from "react";
import { DEFAULT_DISPLAY_UNIT, parseDisplayUnit, type DisplayUnit } from "./units";
import { saveSettingIfStorageAllows } from "./setting-storage";

const STORAGE_KEY = "pcv-display-unit";

let current: DisplayUnit | null = null;
const listeners = new Set<() => void>();

function read(): DisplayUnit {
  if (current === null) {
    try {
      current = parseDisplayUnit(localStorage.getItem(STORAGE_KEY));
    } catch {
      current = DEFAULT_DISPLAY_UNIT;
    }
  }
  return current;
}

export function setDisplayUnit(unit: DisplayUnit): void {
  current = unit;
  saveSettingIfStorageAllows(() => localStorage.setItem(STORAGE_KEY, unit));
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getDisplayUnit(): DisplayUnit {
  return read();
}

export function useDisplayUnit(): [DisplayUnit, (unit: DisplayUnit) => void] {
  const unit = useSyncExternalStore(subscribe, read, () => DEFAULT_DISPLAY_UNIT);
  return [unit, setDisplayUnit];
}
