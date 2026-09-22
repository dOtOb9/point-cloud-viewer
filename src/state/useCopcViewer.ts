import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { TauriSource, reportToBackendConsole } from "../datasource/tauri";
import type { CloudInfo } from "../datasource/DataSource";
import { PointCloudRenderer } from "../renderer/point-cloud-renderer";

const DEFAULT_POINT_BUDGET = 3_000_000;

export type ViewerStatus = "idle" | "opening" | "ready" | "error";

// canvasRefは意図的にCopcViewerStateに含めない。ref(canvasRef)とstate(下記)を
// 同じオブジェクトに混ぜると、eslint-plugin-react-hooksの`react-hooks/refs`が
// 「このオブジェクトのプロパティはrefかもしれない」と見なし、stateの参照にまで
// render中アクセス禁止の誤検知を起こすため、呼び出し側には別々の値として返す。
export interface CopcViewerState {
  status: ViewerStatus;
  error: string | null;
  cloudInfo: CloudInfo | null;
  nodeCount: number;
  pointBudget: number;
  openFile: (path: string) => Promise<void>;
  setPointBudget: (budget: number) => void;
}

/**
 * M1-4: COPCビューアの状態。src/renderer と src/datasource を束ね、UI(src/ui)へは
 * このフックだけを見せる（規約3: UIはrendererを直接触らずstateを経由する）。
 * octree全体のhierarchyをrendererに渡し、画面空間誤差でのLOD選択に任せる。
 */
export function useCopcViewer(): [RefObject<HTMLCanvasElement | null>, CopcViewerState] {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<PointCloudRenderer | null>(null);
  const sourceRef = useRef<TauriSource | null>(null);

  const [status, setStatus] = useState<ViewerStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [cloudInfo, setCloudInfo] = useState<CloudInfo | null>(null);
  const [nodeCount, setNodeCount] = useState(0);
  const [pointBudget, setPointBudgetState] = useState(DEFAULT_POINT_BUDGET);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const renderer = new PointCloudRenderer(canvas);
    const source = new TauriSource();
    rendererRef.current = renderer;
    sourceRef.current = source;
    renderer.setDataSource(source);

    let cancelled = false;
    renderer
      .init()
      .then(() => {
        if (cancelled) return;
        renderer.start();
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(String(e));
      });

    const onResize = () => {
      renderer.resize(canvas.clientWidth, canvas.clientHeight);
    };
    window.addEventListener("resize", onResize);
    onResize();

    return () => {
      cancelled = true;
      window.removeEventListener("resize", onResize);
      renderer.dispose();
    };
  }, []);

  const openFile = useCallback(async (path: string) => {
    const renderer = rendererRef.current;
    const source = sourceRef.current;
    if (!renderer || !source) return;

    setStatus("opening");
    setError(null);
    try {
      const opened = await source.open(path);
      renderer.clearCache();
      renderer.setHierarchy(opened.nodes);
      setCloudInfo(opened.info);
      setNodeCount(opened.nodes.length);
      setStatus("ready");

      const summary = `[M1] opened ${path}: points=${opened.info.pointCount} nodes=${opened.nodes.length}`;
      console.log(summary);
      await reportToBackendConsole(summary);
    } catch (e) {
      setStatus("error");
      setError(String(e));
    }
  }, []);

  const setPointBudget = useCallback((budget: number) => {
    setPointBudgetState(budget);
    rendererRef.current?.setPointBudget(budget);
  }, []);

  const state: CopcViewerState = {
    status,
    error,
    cloudInfo,
    nodeCount,
    pointBudget,
    openFile,
    setPointBudget,
  };
  return [canvasRef, state];
}
