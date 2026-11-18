import { useSyncExternalStore } from "react";
import { DEFAULT_DTM_OUTPUT, readStoredDtmOutput, storeDtmOutput, type DtmOutputSetting } from "./dtm-setting";

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

export function getDtmOutput(): DtmOutputSetting {
  return read();
}

export function useDtmOutput(): [DtmOutputSetting, (setting: DtmOutputSetting) => void] {
  const setting = useSyncExternalStore(subscribe, read, () => DEFAULT_DTM_OUTPUT);
  return [setting, setDtmOutput];
}
