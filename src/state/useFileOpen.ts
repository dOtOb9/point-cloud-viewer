// The hook between React and the open functions (src/app/open-files.ts): owns the conversion display state
// (progress, file name) and the open lock, and builds the `OpenFilesContext` the functions are called with.
import { useState, type RefObject } from "react";
import type { OpenFilesContext } from "../app/open-files";
import type { ConversionProgress } from "../datasource/conversion-dto";
import type { DataSource } from "../datasource/DataSource";
import type { PointCloudRenderer } from "../renderer/point-cloud-renderer";

/** What the context is made of: the newest React values (refs are stable, the rest may change every render). */
export type FileOpenInputs = Pick<
  OpenFilesContext,
  "setStatus" | "reportError" | "addLayerToList" | "nextLayerId" | "isMobile" | "pointShape" | "refreshOpfsStorageInfo"
> & {
  rendererRef: RefObject<PointCloudRenderer | null>;
  sourceRef: RefObject<DataSource | null>;
  toolLock: { running: boolean };
  tempDir: string | null;
};

export interface FileOpen {
  fileOpenContext: OpenFilesContext;
  conversionProgress: ConversionProgress | null;
  convertingFileName: string | null;
}

export function useFileOpen(inputs: FileOpenInputs): FileOpen {
  const [conversionProgress, setConversionProgress] = useState<ConversionProgress | null>(null);
  const [convertingFileName, setConvertingFileName] = useState<string | null>(null);
  // One object for the app's lifetime: the lock must be shared by every context built on later renders.
  const [openLock] = useState(() => ({ busy: false }));

  // Rebuilt on every render, so plain values (tempDir, isMobile, pointShape) are current when a caller picks the
  // context up in an event handler. The ref getters are read when called, because the refs are filled after the first render.
  const fileOpenContext: OpenFilesContext = {
    getSource: () => inputs.sourceRef.current,
    getRenderer: () => inputs.rendererRef.current,
    setStatus: inputs.setStatus,
    reportError: inputs.reportError,
    setConversionProgress,
    setConvertingFileName,
    addLayerToList: inputs.addLayerToList,
    nextLayerId: inputs.nextLayerId,
    tempDir: inputs.tempDir,
    isMobile: inputs.isMobile,
    pointShape: inputs.pointShape,
    isToolRunning: () => inputs.toolLock.running,
    refreshOpfsStorageInfo: inputs.refreshOpfsStorageInfo,
    openLock,
  };
  return { fileOpenContext, conversionProgress, convertingFileName };
}
