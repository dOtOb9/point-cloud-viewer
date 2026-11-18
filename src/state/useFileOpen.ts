import { useState, type RefObject } from "react";
import type { OpenFilesContext } from "../app/open-files";
import type { ConversionProgress } from "../datasource/conversion-dto";
import type { DataSource } from "../datasource/DataSource";
import type { PointCloudRenderer } from "../renderer/point-cloud-renderer";

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
  const [openLock] = useState(() => ({ busy: false }));

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
