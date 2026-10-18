// The hook between React and `FileOpener` (src/app/file-opener.ts): creates it once, returns its snapshot.
import { useEffect, useState, useSyncExternalStore, type RefObject } from "react";
import { FileOpener, type FileOpenerDeps, type FileOpenerSnapshot } from "../app/file-opener";
import type { DataSource } from "../datasource/DataSource";
import type { PointCloudRenderer } from "../renderer/point-cloud-renderer";

/** What the opener reads: the newest React values (refs are stable, the rest may change every render). */
export type FileOpenInputs = Pick<
  FileOpenerDeps,
  "setStatus" | "reportError" | "addLayerToList" | "nextLayerId" | "isMobile" | "pointShape" | "refreshOpfsStorageInfo"
> & {
  rendererRef: RefObject<PointCloudRenderer | null>;
  sourceRef: RefObject<DataSource | null>;
  toolRunningRef: RefObject<boolean>;
  tempDir: string | null;
};

export function useFileOpen(inputs: FileOpenInputs): { opener: FileOpener } & FileOpenerSnapshot {
  // The opener is created once, but its getters must see the newest inputs (e.g. a temp dir chosen later).
  // So the getters read this box, refreshed after every render (not a useRef: lint react-hooks/refs rejects it here).
  const [latest] = useState(() => createLatest(inputs));
  useEffect(() => {
    latest.set(inputs);
  });
  const [opener] = useState(
    () =>
      new FileOpener({
        getSource: () => latest.get().sourceRef.current,
        getRenderer: () => latest.get().rendererRef.current,
        setStatus: (status) => latest.get().setStatus(status),
        reportError: (message, source) => latest.get().reportError(message, source),
        addLayerToList: (layer) => latest.get().addLayerToList(layer),
        nextLayerId: () => latest.get().nextLayerId(),
        getTempDir: () => latest.get().tempDir,
        isMobile: inputs.isMobile,
        pointShape: inputs.pointShape,
        isToolRunning: () => latest.get().toolRunningRef.current,
        refreshOpfsStorageInfo: () => latest.get().refreshOpfsStorageInfo(),
      }),
  );
  const snapshot = useSyncExternalStore(opener.subscribe, opener.getSnapshot);
  return { opener, ...snapshot };
}

/** A box holding the newest value. `set` runs in an effect after each render; `get` runs later, inside event handlers. */
function createLatest<T>(initial: T): { get: () => T; set: (value: T) => void } {
  let value = initial;
  return {
    get: () => value,
    set: (next) => {
      value = next;
    },
  };
}
