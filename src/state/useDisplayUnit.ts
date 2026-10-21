import { useSyncExternalStore } from "react";
import { DEFAULT_DISPLAY_UNIT, parseDisplayUnit, type DisplayUnit } from "./units";

// L2-D: the display unit setting (meters or feet), kept in a tiny module-level store so that the
// settings page, the measurement overlay and the layer info can all read it without passing
// props through the whole tree. It is saved in localStorage; every read and write is wrapped in
// try/catch because storage can be unavailable (private window, blocked site data).

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
  try {
    localStorage.setItem(STORAGE_KEY, unit);
  } catch {
    // Not saved: the choice still applies until the page is reloaded.
  }
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The current display unit, for plain functions that are not React (src/app/). */
export function getDisplayUnit(): DisplayUnit {
  return read();
}

/** The current display unit and its setter. */
export function useDisplayUnit(): [DisplayUnit, (unit: DisplayUnit) => void] {
  const unit = useSyncExternalStore(subscribe, read, () => DEFAULT_DISPLAY_UNIT);
  return [unit, setDisplayUnit];
}
