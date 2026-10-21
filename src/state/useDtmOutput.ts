import { useSyncExternalStore } from "react";
import { DEFAULT_DTM_OUTPUT, readStoredDtmOutput, storeDtmOutput, type DtmOutputSetting } from "./dtm-setting";

// G1-T15: the DTM output setting, kept in a tiny module-level store (the same idea as useDisplayUnit.ts) so that the
// settings page and the DTM dialog read the same value. Saved in localStorage; the read and write helpers are in
// dtm-setting.ts and tolerate unavailable storage.

let current: DtmOutputSetting | null = null;
const listeners = new Set<() => void>();

function read(): DtmOutputSetting {
  if (current === null) {
    current = readStoredDtmOutput(typeof localStorage === "undefined" ? undefined : localStorage);
  }
  return current;
}

export function setDtmOutput(setting: DtmOutputSetting): void {
  current = setting;
  storeDtmOutput(typeof localStorage === "undefined" ? undefined : localStorage, setting);
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The current setting, for plain functions that are not React (src/app/). */
export function getDtmOutput(): DtmOutputSetting {
  return read();
}

/** The current DTM output setting and its setter. */
export function useDtmOutput(): [DtmOutputSetting, (setting: DtmOutputSetting) => void] {
  const setting = useSyncExternalStore(subscribe, read, () => DEFAULT_DTM_OUTPUT);
  return [setting, setDtmOutput];
}
