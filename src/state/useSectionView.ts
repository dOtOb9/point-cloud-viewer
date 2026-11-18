import { useState, type RefObject } from "react";
import { newSectionGesture, type SectionViewContext, type SectionViewState } from "../app/section-view";
import { NO_SECTION_POINTS, type SectionPoints } from "../datasource/section-profile";
import type { DataSource } from "../datasource/DataSource";
import type { ProfilePoint, SectionView, Size } from "../app/section-math";
import type { GroundLevelReading } from "../app/section-3d";
import type { LayersState } from "./layers";

export type SectionViewInputs = Pick<SectionViewContext, "reportError" | "setSectionLineHistory"> & {
  sourceRef: RefObject<DataSource | null>;
  layersStateRef: RefObject<LayersState>;
};

export interface SectionViewHook {
  sectionView: SectionViewState;
  sectionContext: SectionViewContext;
}

export function useSectionView(inputs: SectionViewInputs): SectionViewHook {
  const [openLayerId, setOpenLayerId] = useState<string | null>(null);
  const [points, setPoints] = useState<SectionPoints>(NO_SECTION_POINTS);
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState<SectionView | null>(null);
  const [panelSize, setPanelSize] = useState<Size>({ width: 0, height: 0 });
  const [cursorS, setCursorS] = useState<number | null>(null);
  const [groundLevel, setGroundLevel] = useState<GroundLevelReading | null>(null);
  const [trace, setTrace] = useState<ProfilePoint[] | null>(null);
  const [enlarged, setEnlarged] = useState(false);
  const [token] = useState(() => ({ generation: 0 }));
  const [gesture] = useState(newSectionGesture);

  const sectionView: SectionViewState = { openLayerId, points, loading, view, panelSize, cursorS, groundLevel, trace, enlarged };
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
    setCursorS,
    setGroundLevel,
    setTrace,
    setEnlarged,
    setSectionLineHistory: inputs.setSectionLineHistory,
    token,
    gesture,
  };
  return { sectionView, sectionContext };
}
