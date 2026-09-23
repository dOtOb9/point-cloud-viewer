import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { TauriSource, reportToBackendConsole } from "../datasource/tauri";
import type { CloudInfo } from "../datasource/DataSource";
import { PointCloudRenderer, type RenderStats } from "../renderer/point-cloud-renderer";
import { DEFAULT_BACKGROUND_MODE, type BackgroundMode } from "../renderer/sky";
import { DEFAULT_GRID_ENABLED } from "../renderer/ground-grid";

// UI(src/ui)はrendererを直接触らずstate経由にする規約（ARCHITECTURE.md 規約3）のため、
// BackgroundModeもここから再エクスポートする。
export type { BackgroundMode };

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
  /** タスクB(ADR-0009)の自動調整のオン/オフ。既定値はrendererの既定(true)に合わせている。 */
  autoPointBudgetEnabled: boolean;
  stats: RenderStats | null;
  backgroundMode: BackgroundMode;
  gridEnabled: boolean;
  openFile: (path: string) => Promise<void>;
  setPointBudget: (budget: number) => void;
  setAutoPointBudgetEnabled: (enabled: boolean) => void;
  setBackgroundMode: (mode: BackgroundMode) => void;
  setGridEnabled: (enabled: boolean) => void;
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
  // rendererの既定(PointCloudRenderer内 private autoPointBudgetEnabled = true)と合わせる。
  const [autoPointBudgetEnabled, setAutoPointBudgetEnabledState] = useState(true);
  const [stats, setStats] = useState<RenderStats | null>(null);
  const [backgroundMode, setBackgroundModeState] = useState<BackgroundMode>(DEFAULT_BACKGROUND_MODE);
  const [gridEnabled, setGridEnabledState] = useState(DEFAULT_GRID_ENABLED);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const renderer = new PointCloudRenderer(canvas);
    const source = new TauriSource();
    rendererRef.current = renderer;
    sourceRef.current = source;
    renderer.setDataSource(source);
    renderer.onStatsUpdate((s) => {
      setStats(s);
      // タスクB(ADR-0009)の自動調整は`PointCloudRenderer`の内部でpointBudgetを
      // 直接書き換える(setPointBudget()を経由しない)ので、UI側の表示値は
      // 手動設定時と同じくstatsから同期する。これで「自動調整中は数値が自分で
      // 動く」ことがLayerPanelの点予算欄にそのまま表れる(最大STATS_INTERVAL_MSの
      // 遅延はあるが、手動設定の直後はsetPointBudget側で即時反映するので体感の
      // ずれはない)。
      setPointBudgetState(s.pointBudget);
      setAutoPointBudgetEnabledState(s.autoPointBudgetEnabled);
      // GUIを目視できない環境でも`npm run tauri dev`のRust側stdoutから
      // 描画点数・ロード中ノード数・fpsを追えるようにする（M1-4の必須要件）。
      const fmt3 = (v: readonly [number, number, number]) => `[${v.map((x) => x.toFixed(2)).join(",")}]`;
      const summary =
        `[M1] drawnPoints=${s.drawnPoints} drawnNodes=${s.drawnNodes} ` +
        `loadingNodes=${s.loadingNodes} queuedNodes=${s.queuedNodes} ` +
        `cachedNodes=${s.cachedNodes} fps=${s.fps.toFixed(1)} pointBudget=${s.pointBudget} ` +
        // タスクB(ADR-0009):「現在値を画面に出す」の一環。自動調整中かどうかを
        // stdoutだけでも確認できるようにする。
        `autoPointBudget=${s.autoPointBudgetEnabled} ` +
        // M2-0c: 空/グリッドの有無でfpsを比較できるよう、一緒に出す。
        `backgroundMode=${s.backgroundMode} gridEnabled=${s.gridEnabled} ` +
        // M2-0b: GUIを目視できなくても、pitch=0が水平になっているか等をstdoutだけで
        // 機械的に確認できるようにカメラの向きも出す。
        `pitch=${s.cameraPitch.toFixed(3)} yaw=${s.cameraYaw.toFixed(3)} ` +
        `upAxis=${fmt3(s.cameraUpAxis)} eye=${fmt3(s.cameraEye)}`;
      reportToBackendConsole(summary).catch((e) => console.error("reportToBackendConsole failed", e));
    });

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
    // ADR-0009:「手で変えたら自動調整は止まる」。renderer.setPointBudget()自体が
    // 内部でautoPointBudgetEnabledをfalseにするが、その反映は次のstats更新
    // (最大STATS_INTERVAL_MS=500ms後)まで待つと「黙って切り替わった」ように
    // 見えてしまう。ここで同期的にfalseへ倒し、LayerPanelのチェックボックスが
    // 即座に外れるようにする。
    setAutoPointBudgetEnabledState(false);
    rendererRef.current?.setPointBudget(budget);
  }, []);

  const setAutoPointBudgetEnabled = useCallback((enabled: boolean) => {
    setAutoPointBudgetEnabledState(enabled);
    rendererRef.current?.setAutoPointBudgetEnabled(enabled);
  }, []);

  const setBackgroundMode = useCallback((mode: BackgroundMode) => {
    setBackgroundModeState(mode);
    rendererRef.current?.setBackgroundMode(mode);
  }, []);

  const setGridEnabled = useCallback((enabled: boolean) => {
    setGridEnabledState(enabled);
    rendererRef.current?.setGridEnabled(enabled);
  }, []);

  const state: CopcViewerState = {
    status,
    error,
    cloudInfo,
    nodeCount,
    pointBudget,
    autoPointBudgetEnabled,
    stats,
    backgroundMode,
    gridEnabled,
    openFile,
    setPointBudget,
    setAutoPointBudgetEnabled,
    setBackgroundMode,
    setGridEnabled,
  };
  return [canvasRef, state];
}
