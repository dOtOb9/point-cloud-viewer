// G2-3: the state of the 2D cross-section panel, and the `SectionViewContext` the functions of src/app/section-view.ts
// are called with. Only `useState` here: the steps (open, close, zoom, pan, pointer input) are plain functions in
// src/app/section-view.ts that change this state through the setters in the context (TaskSheets/ADR-0021-thin-react.md).
// Used by: useCopcViewer.ts (which passes `openSectionView` to the tool functions) and src/ui/section/SectionPanel.tsx.
import { useState, type RefObject } from "react";
import { newSectionGesture, type SectionViewContext, type SectionViewState } from "../app/section-view";
import { NO_SECTION_POINTS, type SectionPoints } from "../datasource/section-profile";
import type { DataSource } from "../datasource/DataSource";
import type { SectionView, Size } from "../app/section-math";
import type { LayersState } from "./layers";

export type SectionViewInputs = Pick<SectionViewContext, "reportError"> & {
  sourceRef: RefObject<DataSource | null>;
  layersStateRef: RefObject<LayersState>;
};

export interface SectionViewHook {
  sectionView: SectionViewState;
  /** Pass this to the functions of src/app/section-view.ts. */
  sectionContext: SectionViewContext;
}

export function useSectionView(inputs: SectionViewInputs): SectionViewHook {
  const [openLayerId, setOpenLayerId] = useState<string | null>(null);
  const [points, setPoints] = useState<SectionPoints>(NO_SECTION_POINTS);
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState<SectionView | null>(null);
  const [panelSize, setPanelSize] = useState<Size>({ width: 0, height: 0 });
  // Plain objects that live as long as the app, like `toolLock`: a load counter (so an old load cannot overwrite a
  // newer one) and the pointer tracking of the gesture in progress (it changes at pointer speed, so not React state).
  const [token] = useState(() => ({ generation: 0 }));
  const [gesture] = useState(newSectionGesture);

  const sectionView: SectionViewState = { openLayerId, points, loading, view, panelSize };
  // Rebuilt on every render, so the plain values are the ones the user sees when an event handler picks it up.
  const sectionContext: SectionViewContext = {
    ...sectionView,
    getSource: () => inputs.sourceRef.current,
    getLayersState: () => inputs.layersStateRef.current,
    reportError: inputs.reportError,
    setOpenLayerId,
    setPoints,
    setLoading,
    setView,
    setPanelSize,
    token,
    gesture,
  };
  return { sectionView, sectionContext };
}
