import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { TauriSource, reportToBackendConsole } from "../datasource/tauri";
import type { CloudInfo } from "../datasource/DataSource";
import { PointCloudRenderer, type RenderStats } from "../renderer/point-cloud-renderer";
import { DEFAULT_BACKGROUND_MODE, type BackgroundMode } from "../renderer/sky";
import { DEFAULT_GRID_ENABLED } from "../renderer/ground-grid";
import { DEFAULT_EDL_ENABLED } from "../renderer/edl";
import { GpuErrorLog, type GpuErrorEntry } from "../renderer/gpu-error-log";
import { DEFAULT_COLOR_MODE, resolveColorMode, type ColorMode } from "../renderer/colormap";

// UI(src/ui)はrendererを直接触らずstate経由にする規約（ARCHITECTURE.md 規約3）のため、
// GpuErrorEntryもここから再エクスポートする。
export type { GpuErrorEntry };

// UI(src/ui)はrendererを直接触らずstate経由にする規約（ARCHITECTURE.md 規約3）のため、
// BackgroundModeもここから再エクスポートする。
export type { BackgroundMode };

// UI(src/ui)はrendererを直接触らずstate経由にする規約（ARCHITECTURE.md 規約3）のため、
// ColorModeもここから再エクスポートする（M2-2）。
export type { ColorMode };

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
  /** M2-1: EDL(Eye-Dome Lighting)のオン/オフ。既定はrendererの既定(オン)に
   *  合わせている。RGBを持たない点群(sofi.copc.laz)でも形状を読めるようにする
   *  必須機能なので、既定でオフにはしていない（TaskSheets/M2-shading-and-ui.md
   *  M2-1参照）。強さは所有者が実機で確認して0.05に固定したため、UIから
   *  調整する手段は無い（`src/renderer/edl.ts`の`DEFAULT_EDL_STRENGTH`参照）。 */
  edlEnabled: boolean;
  /** M2-2: 着色モード。既定は`DEFAULT_COLOR_MODE`("rgb")。ファイルを開いた結果
   *  RGBが無いと分かった場合は自動で`FALLBACK_COLOR_MODE_WITHOUT_RGB`("elevation")
   *  に落ちる（`openFile`参照）。手動で"rgb"を選んでも、開いているファイルが
   *  RGBを持たなければ同様に落ちる（`setColorMode`参照。フォールバック先の
   *  理由は`src/renderer/colormap.ts`の`FALLBACK_COLOR_MODE_WITHOUT_RGB`
   *  のコメントに記録してある）。
   *
   *  **レンダラへの結線は未実装（このコミットの時点）。** `point-cloud-renderer.ts`を
   *  分割中の別エージェントの作業と衝突しないよう、着色モードの計算
   *  (`src/renderer/colormap.ts`)とこのstate・UIだけを先に用意した
   *  （TaskSheets/M2-shading-and-ui.md M2-2参照）。実際に点の色が変わるのは
   *  分割が完了し、rendererに`setColorMode`相当のAPIが追加されてから。 */
  colorMode: ColorMode;
  /** WebGPUのエラー（新設）。`device.onuncapturederror`・デバイス消失・初期化時の
   *  バリデーションエラーがここに蓄積される。蓄積・重複抑制のロジック自体は
   *  `GpuErrorLog`（renderer/gpu-error-log.ts、GPUに依存しない純粋なクラス）に
   *  切り出してあり、ここではそのスナップショットを保持するだけ。表示は
   *  `src/ui/shell/GpuErrorBanner.tsx`が担当する（規約3）。 */
  gpuErrors: GpuErrorEntry[];
  openFile: (path: string) => Promise<void>;
  setPointBudget: (budget: number) => void;
  setAutoPointBudgetEnabled: (enabled: boolean) => void;
  setBackgroundMode: (mode: BackgroundMode) => void;
  setGridEnabled: (enabled: boolean) => void;
  setEdlEnabled: (enabled: boolean) => void;
  setColorMode: (mode: ColorMode) => void;
  /** バナーの「閉じる」ボタンから呼ぶ。指定したエラーだけを消す。 */
  dismissGpuError: (id: number) => void;
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
  // GpuErrorLog自体はReactのstateではない（GPUに依存しない蓄積・重複抑制ロジックの
  // 実体、renderer/gpu-error-log.ts参照）。useRefで1個だけ持ち、reportのたびに
  // list()のスナップショットをgpuErrors stateへコピーしてReactに再描画させる。
  const gpuErrorLogRef = useRef(new GpuErrorLog());

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
  const [edlEnabled, setEdlEnabledState] = useState(DEFAULT_EDL_ENABLED);
  const [colorMode, setColorModeState] = useState<ColorMode>(DEFAULT_COLOR_MODE);
  const [gpuErrors, setGpuErrors] = useState<GpuErrorEntry[]>([]);

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
        // M2-1: EDLのオン/オフ・強さの切り替えがrendererまで届いているかを、
        // 陰影の見た目を目視する前にstdoutだけでも確認できるようにする。
        `edlEnabled=${s.edlEnabled} edlStrength=${s.edlStrength.toFixed(2)} ` +
        // M2-0b: GUIを目視できなくても、pitch=0が水平になっているか等をstdoutだけで
        // 機械的に確認できるようにカメラの向きも出す。
        `pitch=${s.cameraPitch.toFixed(3)} yaw=${s.cameraYaw.toFixed(3)} ` +
        `upAxis=${fmt3(s.cameraUpAxis)} eye=${fmt3(s.cameraEye)}`;
      reportToBackendConsole(summary).catch((e) => console.error("reportToBackendConsole failed", e));
    });

    // WebGPUのエラーを画面に出す仕組み（新設）。EDL(M2-1)の事故で「テスト・CIは
    // すべて緑なのに画面は真っ黒になった」という反省から、rendererが拾った
    // エラーを蓄積・重複抑制した上でUI(GpuErrorBanner)へ渡す。実際の蓄積ロジックは
    // GpuErrorLogに任せ、ここではlist()のスナップショットをstateにコピーするだけ。
    renderer.onGpuErrorReported((message) => {
      gpuErrorLogRef.current.report(message);
      setGpuErrors(gpuErrorLogRef.current.list());
      // GUIを目視できない環境でも、devtoolsを開かなくてもRust側stdoutから
      // WebGPUのエラーを追えるようにする（onStatsUpdateのstdout連携と同じ狙い）。
      reportToBackendConsole(`[gpu-error] ${message}`).catch((e) =>
        console.error("reportToBackendConsole failed", e),
      );
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
      // M2-2: 開いたファイルがRGBを持たない場合、現在"rgb"を選んでいれば
      // 自動的に標高へ落とす（colormap.tsの`resolveColorMode`/
      // `FALLBACK_COLOR_MODE_WITHOUT_RGB`参照）。関数形の更新にしているのは、
      // このコールバック自体が`[]`依存の`useCallback`で、閉じ込めた古い
      // `colorMode`を読まないようにするため。
      setColorModeState((prev) => resolveColorMode(prev, opened.info.hasColor));

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

  const setEdlEnabled = useCallback((enabled: boolean) => {
    setEdlEnabledState(enabled);
    rendererRef.current?.setEdlEnabled(enabled);
  }, []);

  const setColorMode = useCallback(
    (mode: ColorMode) => {
      // 現在開いているファイルがRGBを持たない場合は、"rgb"を選ぼうとしても
      // 自動的に標高へ落とす（受け入れ条件「RGBを持たない点群ではRGBが選べないか、
      // 選んだときに分かる形で別モードに落ちる」）。`LayerPanel`側でも"rgb"の
      // 選択肢自体をdisabledにしているため、通常はここに到達しないが、
      // 二重の安全策として関数側でも解決する。
      setColorModeState(resolveColorMode(mode, cloudInfo?.hasColor ?? false));
      // TODO(M2-2): point-cloud-renderer.tsの分割が完了したら、ここで
      // rendererRef.current?.setColorMode(...)相当のAPIを呼んで実際の描画色を
      // 切り替える。分割中の別エージェントの作業と衝突しないよう、このコミットの
      // 時点ではstateを更新するだけに留めている（TaskSheets/M2-shading-and-ui.md
      // M2-2参照）。
    },
    [cloudInfo],
  );

  const dismissGpuError = useCallback((id: number) => {
    gpuErrorLogRef.current.dismiss(id);
    setGpuErrors(gpuErrorLogRef.current.list());
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
    edlEnabled,
    colorMode,
    gpuErrors,
    openFile,
    setPointBudget,
    setAutoPointBudgetEnabled,
    setBackgroundMode,
    setGridEnabled,
    setEdlEnabled,
    setColorMode,
    dismissGpuError,
  };
  return [canvasRef, state];
}
