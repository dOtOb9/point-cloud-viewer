import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import {
  TauriSource,
  cancelLasConversion,
  onConversionDone,
  onConversionFailed,
  onConversionProgress,
  pickTempDirectory,
  reportToBackendConsole,
  startLasConversion,
  supportsCustomTempDir as fetchSupportsCustomTempDir,
} from "../datasource/tauri";
import { WebSource } from "../datasource/web";
import { isCopcFile } from "../datasource/copc-header";
import { isTauriEnvironment } from "../datasource/environment";
import type { CloudInfo, DataSource } from "../datasource/DataSource";
import type { ConversionProgress } from "../datasource/conversion-dto";
import { PointCloudRenderer, type RenderStats } from "../renderer/point-cloud-renderer";
import { DEFAULT_BACKGROUND_MODE, type BackgroundMode } from "../renderer/sky";
import { DEFAULT_GRID_ENABLED } from "../renderer/ground-grid";
import { GpuErrorLog, type GpuErrorEntry } from "../renderer/gpu-error-log";
import { DEFAULT_COLOR_MODE, resolveColorMode, type ColorMode } from "../renderer/colormap";
import { defaultRenderSettings, readDeviceProfileInput, type PointShape } from "../renderer/device-profile";

// UI(src/ui)はrendererを直接触らずstate経由にする規約（ARCHITECTURE.md 規約3）のため、
// PointShapeもここから再エクスポートする（M3-8）。
export type { PointShape };

// UI(src/ui)はrendererを直接触らずstate経由にする規約（ARCHITECTURE.md 規約3）のため、
// GpuErrorEntryもここから再エクスポートする。
export type { GpuErrorEntry };

// UI(src/ui)はrendererを直接触らずstate経由にする規約（ARCHITECTURE.md 規約3）のため、
// BackgroundModeもここから再エクスポートする。
export type { BackgroundMode };

// UI(src/ui)はrendererを直接触らずstate経由にする規約（ARCHITECTURE.md 規約3）のため、
// ColorModeもここから再エクスポートする（M2-2）。
export type { ColorMode };

// UI(src/ui)はdatasourceを直接触らずstate経由にする規約（規約2の裏返し。
// tauri.tsをimportしてよいのはこのファイルだけ）のため、
// ConversionProgressもここから再エクスポートする（M4-3）。
export type { ConversionProgress };

const TEMP_DIR_STORAGE_KEY = "pcv-conversion-temp-dir";

function readStoredTempDir(): string | null {
  try {
    return localStorage.getItem(TEMP_DIR_STORAGE_KEY);
  } catch {
    return null;
  }
}

// M4-3: "converting"は生LAS/LAZの変換中(進捗・キャンセルUIを出す状態)。
// 変換を挟まない通常のCOPCを開く処理は従来どおり"opening"のまま
// (一瞬で終わるため専用の状態を設けない)。
export type ViewerStatus = "idle" | "opening" | "converting" | "ready" | "error";

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
  /**
   * M3-8: モバイル最適化。`isMobile`/`deviceMemoryGiB`/`pointerCoarse`/
   * `pointBudgetMax`は端末プロファイル(`device-profile.ts`)から一度だけ決まる、
   * セッション中変わらない値（所有者が実機でどの既定値が選ばれたかを設定画面で
   * 確かめられるようにするための表示用）。`renderScale`/`pointShape`は設定画面
   * から切り替えられる値で、変更は再起動なしでrendererへ反映される。
   */
  isMobile: boolean;
  deviceMemoryGiB: number | undefined;
  pointerCoarse: boolean;
  pointBudgetMax: number;
  renderScale: number;
  pointShape: PointShape;
  /** M2-2: 着色モード。既定は`DEFAULT_COLOR_MODE`("rgb")。ファイルを開いた結果
   *  RGBが無いと分かった場合は自動で`FALLBACK_COLOR_MODE_WITHOUT_RGB`("elevation")
   *  に落ちる（`openFile`参照）。手動で"rgb"を選んでも、開いているファイルが
   *  RGBを持たなければ同様に落ちる（`setColorMode`参照。フォールバック先の
   *  理由は`src/renderer/colormap.ts`の`FALLBACK_COLOR_MODE_WITHOUT_RGB`
   *  のコメントに記録してある）。
   *
   *  レンダラへの結線は`point-cloud-renderer.ts`の分割(node-selection.ts/
   *  gpu-resources.ts/point-cloud-renderer.tsへの3分割)が完了した後に行った
   *  （TaskSheets/M2-shading-and-ui.md M2-2「段階2」参照）。 */
  colorMode: ColorMode;
  /** WebGPUのエラー（ADR-0011）。`device.onuncapturederror`・デバイス消失・初期化時の
   *  バリデーションエラーがここに蓄積される。M3(ADR-0013)以降は`pcv://`の
   *  ノード読み出し失敗（Rust側のpanicから復旧したものを含む）も同じ配列に
   *  混ざる（`GpuErrorEntry.source`で区別する）。蓄積・重複抑制のロジック自体は
   *  `GpuErrorLog`（renderer/gpu-error-log.ts、GPUに依存しない純粋なクラス）に
   *  切り出してあり、ここではそのスナップショットを保持するだけ。表示は
   *  `src/ui/shell/GpuErrorBanner.tsx`が担当する（規約3）。 */
  gpuErrors: GpuErrorEntry[];
  /** Tauri版はパス文字列、Web版はURL文字列か、ドラッグ&ドロップ/選択した`File`を渡す。 */
  openFile: (pathOrFile: string | File) => Promise<void>;
  /** LayerPanelがTauri用のパス入力とWeb用のファイル選択/URL入力を切り替えるための判定。 */
  isBrowser: boolean;
  /**
   * M4-3: 生LAS/LAZの変換中(`status === "converting"`)の進捗。読み込み段階は
   * `{phase: "reading", pointsRead, totalPoints, elapsedSecs}`で正確な割合が
   * 分かり、その後(octree構築・書き出し)は`{phase: "postProcessing",
   * elapsedSecs}`に切り替わる(割合は出せない。理由は
   * `src-tauri/src/conversion.rs`のドキュメント参照)。変換していないときは`null`。
   */
  conversionProgress: ConversionProgress | null;
  /** 変換中にキャンセルボタンから呼ぶ。 */
  cancelConversion: () => void;
  /** 一時ファイルの置き場所の設定(未設定なら`null`=プラットフォームの既定)。
   *  Tauriのみ意味を持つ(Web版は変換自体をしない)。 */
  tempDir: string | null;
  /** デスクトップだけ`true`(Androidはアプリのキャッシュへ自動で誘導されるため、
   *  手動選択のUIを出さない。`src-tauri/src/conversion.rs`の
   *  `supports_custom_temp_dir`参照)。Web版では常に`false`。 */
  supportsCustomTempDir: boolean;
  /** OSのフォルダ選択ダイアログを出し、選んだ場所を`tempDir`に設定する。 */
  pickAndSetTempDir: () => Promise<void>;
  /** `tempDir`を明示的にクリアする(既定値に戻す)。 */
  clearTempDir: () => void;
  setPointBudget: (budget: number) => void;
  setAutoPointBudgetEnabled: (enabled: boolean) => void;
  setBackgroundMode: (mode: BackgroundMode) => void;
  setGridEnabled: (enabled: boolean) => void;
  setEdlEnabled: (enabled: boolean) => void;
  setRenderScale: (scale: number) => void;
  setPointShape: (shape: PointShape) => void;
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
  // TauriのwebviewかブラウザかでTauriSource/WebSourceを選ぶ（Web版はこの1箇所だけの
  // 分岐で切り替わる。TaskSheets/ADR-0012-web-worker-sync-io.md参照）。
  const sourceRef = useRef<DataSource | null>(null);
  // GpuErrorLog自体はReactのstateではない（GPUに依存しない蓄積・重複抑制ロジックの
  // 実体、renderer/gpu-error-log.ts参照）。useRefで1個だけ持ち、reportのたびに
  // list()のスナップショットをgpuErrors stateへコピーしてReactに再描画させる。
  const gpuErrorLogRef = useRef(new GpuErrorLog());

  // M3-8: モバイル判定と各手段の既定値を、`PointCloudRenderer`のコンストラクタが
  // 呼ぶのと同じ`defaultRenderSettings(readDeviceProfileInput())`で決める。
  // 同じ入力(実行中のブラウザの状態は変わらない)に対して同じ純粋関数を呼ぶだけ
  // なので、rendererとこのフックの初期値はハンドシェイクなしで一致する
  // （point-cloud-renderer.tsのコンストラクタのコメント参照）。`useState`の
  // 初期化関数として渡し、レンダー毎に呼び直されないようにする。
  const [deviceProfileInput] = useState(() => readDeviceProfileInput());
  const [deviceProfileDefaults] = useState(() => defaultRenderSettings(deviceProfileInput));

  const [status, setStatus] = useState<ViewerStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [cloudInfo, setCloudInfo] = useState<CloudInfo | null>(null);
  const [nodeCount, setNodeCount] = useState(0);
  const [pointBudget, setPointBudgetState] = useState(deviceProfileDefaults.pointBudgetStart);
  // rendererの既定(PointCloudRenderer内 private autoPointBudgetEnabled = true)と合わせる。
  const [autoPointBudgetEnabled, setAutoPointBudgetEnabledState] = useState(true);
  const [stats, setStats] = useState<RenderStats | null>(null);
  const [backgroundMode, setBackgroundModeState] = useState<BackgroundMode>(DEFAULT_BACKGROUND_MODE);
  const [gridEnabled, setGridEnabledState] = useState(DEFAULT_GRID_ENABLED);
  const [edlEnabled, setEdlEnabledState] = useState(deviceProfileDefaults.edlEnabled);
  const [renderScale, setRenderScaleState] = useState(deviceProfileDefaults.renderScale);
  const [pointShape, setPointShapeState] = useState<PointShape>(deviceProfileDefaults.pointShape);
  const [colorMode, setColorModeState] = useState<ColorMode>(DEFAULT_COLOR_MODE);
  const [gpuErrors, setGpuErrors] = useState<GpuErrorEntry[]>([]);
  // M4-3: 変換中の進捗。変換していないときはnull。
  const [conversionProgress, setConversionProgress] = useState<ConversionProgress | null>(null);
  const [tempDir, setTempDirState] = useState<string | null>(() => readStoredTempDir());
  // Androidかどうかはフロントから直接判定できないため、起動時に一度だけ
  // Rust側へ問い合わせる(既定はtrue=デスクトップ相当。Web版はisBrowserが
  // 別途trueになるので、この値がtrueのままでもUI側でisBrowserを優先して隠す)。
  const [supportsCustomTempDirState, setSupportsCustomTempDirState] = useState(true);

  // `openFile`は`colorMode`等に依存して再生成される(下のuseCallback参照)。
  // マウント時に1度だけ張るイベント購読(下のuseEffect)から常に最新の
  // `openFile`を呼べるよう、refに常に最新の関数を入れておく
  // (「effectは一度だけ、でも中身は最新でありたい」という定番の対処)。
  const openFileRef = useRef<(pathOrFile: string | File) => Promise<void>>(() => Promise.resolve());

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const renderer = new PointCloudRenderer(canvas);
    const source: DataSource = isTauriEnvironment() ? new TauriSource() : new WebSource();
    rendererRef.current = renderer;
    sourceRef.current = source;
    renderer.setDataSource(source);

    // M4-3: 変換の進捗・完了・失敗イベントの購読。Web版では`onConversion*`が
    // 何もしない購読を返すので、環境分岐をここに書く必要は無い
    // (`src/datasource/tauri.ts`参照)。
    let unlistenProgress = () => {};
    let unlistenDone = () => {};
    let unlistenFailed = () => {};
    void onConversionProgress((progress) => setConversionProgress(progress)).then((fn) => {
      unlistenProgress = fn;
    });
    void onConversionDone((outputPath) => {
      // 変換が終わった出力(既にCOPC)をそのまま開き直す。もう一度
      // start_las_conversionを経由するが、既にCOPCと判定されて即座に開く
      // 経路に入るだけなので実害は無い(往復コストはヘッダー1回分)。
      setConversionProgress(null);
      void openFileRef.current(outputPath);
    }).then((fn) => {
      unlistenDone = fn;
    });
    void onConversionFailed((message, cancelled) => {
      setConversionProgress(null);
      setStatus(cancelled ? "idle" : "error");
      if (cancelled) {
        setError(null);
      } else {
        setError(message);
      }
      // 受け入れ条件: 変換の失敗・キャンセルは画面に出す(ADR-0011/ADR-0013の
      // エラーバナー)。キャンセルも「何が起きたか」が分かるようにバナーへ出す
      // (バナーが無いと、進捗が消えるだけで所有者には何も起きなかったように見える)。
      gpuErrorLogRef.current.report(
        cancelled ? "変換をキャンセルしました" : `変換に失敗しました: ${message}`,
        undefined,
        "conversion",
      );
      setGpuErrors(gpuErrorLogRef.current.list());
    }).then((fn) => {
      unlistenFailed = fn;
    });

    if (isTauriEnvironment()) {
      fetchSupportsCustomTempDir()
        .then(setSupportsCustomTempDirState)
        .catch((e: unknown) => console.error("supportsCustomTempDir failed", e));
    }

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
        // M2-2: 着色モードの切り替えがrendererまで届いているかを、色の見た目を
        // 目視する前にstdoutだけでも確認できるようにする。
        `colorMode=${s.colorMode} ` +
        // M3-8: モバイル最適化の各手段の現在値。所有者が実機で1つずつ切り替えて
        // 効果を確かめる際、GUIの設定画面と同じ値をstdout(logcat経由も含む)からも
        // 確認できるようにする。
        `renderScale=${s.renderScale} pointShape=${s.pointShape} isMobile=${s.isMobile} pointBudgetMax=${s.pointBudgetMax} ` +
        // M2-0b: GUIを目視できなくても、pitch=0が水平になっているか等をstdoutだけで
        // 機械的に確認できるようにカメラの向きも出す。
        `pitch=${s.cameraPitch.toFixed(3)} yaw=${s.cameraYaw.toFixed(3)} ` +
        `upAxis=${fmt3(s.cameraUpAxis)} eye=${fmt3(s.cameraEye)}`;
      reportToBackendConsole(summary).catch((e) => console.error("reportToBackendConsole failed", e));
    });

    // WebGPUのエラーを画面に出す仕組み（ADR-0011）。EDL(M2-1)の事故で「テスト・CIは
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

    // M3(ADR-0013): pcv://のノード読み出し失敗も同じGpuErrorLog/バナーに乗せる。
    // 所有者の実機で「複数ノードを扱うと落ちる」報告があり、原因がRust側の
    // panicだった場合はcatch_unwindで捕まえてHTTP 500+メッセージを返すように
    // なった（src-tauri/src/copc_state.rs）。上のGPUエラーと同じ形でsourceだけ
    // "node-read"にする（gpu-error-log.tsのreport()第3引数）。
    renderer.onNodeLoadErrorReported((message) => {
      gpuErrorLogRef.current.report(message, undefined, "node-read");
      setGpuErrors(gpuErrorLogRef.current.list());
      reportToBackendConsole(`[node-load-error] ${message}`).catch((e) =>
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
      unlistenProgress();
      unlistenDone();
      unlistenFailed();
    };
  }, []);

  const openFile = useCallback(async (pathOrFile: string | File) => {
    const renderer = rendererRef.current;
    const source = sourceRef.current;
    if (!renderer || !source) return;

    setStatus("opening");
    setError(null);
    setConversionProgress(null);
    try {
      // Web版のローカルファイル選択は`File`を受け取る。`DataSource.open()`は
      // 文字列しか取らないので、先に`WebSource.registerFile()`でキーへ変換する
      // （TauriSourceにはFileを渡す経路が無い。ファイル選択UIはWeb版でしか
      // 出さないので、ここに来る時点でsourceは必ずWebSourceのはず）。
      let path: string;
      if (typeof pathOrFile === "string") {
        path = pathOrFile;
      } else if (source instanceof WebSource) {
        // M4-3: Web版は生LAS/LAZを変換できない(ADR-0006: 変換はデスクトップ/
        // Androidのみ。Webは別段階M4-6)。拡張子ではなくヘッダーで判定し
        // (`copc-header.ts`、Rust側の`copc_detect.rs`と同じ考え方)、COPCで
        // なければデスクトップ版での変換を促す(受け入れ条件)。
        if (!(await isCopcFile(pathOrFile))) {
          setStatus("error");
          setError(
            "これは生のLAS/LAZです。Web版では変換できません。デスクトップ版でCOPC(.copc.laz)に変換してから開いてください。",
          );
          return;
        }
        path = source.registerFile(pathOrFile);
      } else {
        throw new Error("ローカルファイルの選択はWeb版でのみサポートしています");
      }

      // M4-3: Tauri版(デスクトップ・Android)は、開く前に必ず
      // start_las_conversionを経由する。既にCOPCならヘッダーを読むだけの
      // 軽い処理で即座に`alreadyCopc`が返る(受け入れ条件「既にCOPCのファイルは
      // 即座に開く」)。生LAS/LAZなら変換済みキャッシュがあるか確認し
      // (`cached`)、無ければ空き容量を確かめてから変換を開始する
      // (`converting`。この場合はここで一旦return し、実際に開く処理は
      // マウント時に張った`onConversionDone`が`openFileRef`経由で続きを行う)。
      if (source instanceof TauriSource) {
        const outcome = await startLasConversion(path, tempDir);
        switch (outcome.kind) {
          case "alreadyCopc":
            path = outcome.path;
            break;
          case "cached":
            path = outcome.outputPath;
            break;
          case "insufficientSpace": {
            const toGiB = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);
            gpuErrorLogRef.current.report(
              `空き容量が足りません(必要: 約${toGiB(outcome.requiredBytes)}GiB、空き: 約${toGiB(outcome.availableBytes)}GiB)。設定から一時ファイルの置き場所を変更できます。`,
              undefined,
              "conversion",
            );
            setGpuErrors(gpuErrorLogRef.current.list());
            setStatus("error");
            setError("空き容量が足りません");
            return;
          }
          case "converting":
            // 実際に開く処理はonConversionDoneのイベントハンドラが続きを行う。
            setStatus("converting");
            return;
        }
      }

      const opened = await source.open(path);
      renderer.clearCache();
      renderer.setHierarchy(opened.nodes);
      // M2-2実機不具合の修正: 標高の正規化レンジは、ノードのbounds(octreeセル、
      // 立方体でZ範囲が水平方向に引き伸ばされる)ではなく、LASヘッダーの
      // 実データ範囲(CloudInfo.min/max)から設定する（renderer側の
      // `setElevationRange`のコメント、`src/renderer/scene-bounds.ts`参照）。
      renderer.setElevationRange(opened.info.min, opened.info.max);
      setCloudInfo(opened.info);
      setNodeCount(opened.nodes.length);
      setStatus("ready");
      // M2-2: 開いたファイルがRGBを持たない場合、現在"rgb"を選んでいれば
      // 自動的に標高へ落とす（colormap.tsの`resolveColorMode`/
      // `FALLBACK_COLOR_MODE_WITHOUT_RGB`参照）。renderer側にも同じ解決結果を
      // 伝える（rendererは`resolveColorMode`を知らず、渡された値をそのまま
      // 使うだけの設計にしてある。point-cloud-renderer.tsのcolorModeフィールド
      // コメント参照）。この関数は`colorMode`に依存するため、下の`useCallback`の
      // 依存配列に`colorMode`を含めている。
      const resolvedColorMode = resolveColorMode(colorMode, opened.info.hasColor);
      setColorModeState(resolvedColorMode);
      renderer.setColorMode(resolvedColorMode);

      const label = typeof pathOrFile === "string" ? pathOrFile : pathOrFile.name;
      const summary = `[M1] opened ${label}: points=${opened.info.pointCount} nodes=${opened.nodes.length}`;
      console.log(summary);
      await reportToBackendConsole(summary);
    } catch (e) {
      setStatus("error");
      setError(String(e));
    }
  }, [colorMode, tempDir]);

  // `openFileRef`を毎レンダー最新化する。マウント時に一度だけ張るイベント
  // 購読(上のuseEffect、deps=[])から常に最新の`openFile`(最新のcolorMode/
  // tempDirを閉じ込めたもの)を呼べるようにするための、定番の対処。
  useEffect(() => {
    openFileRef.current = openFile;
  });

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

  const setRenderScale = useCallback((scale: number) => {
    setRenderScaleState(scale);
    rendererRef.current?.setRenderScale(scale);
  }, []);

  const setPointShape = useCallback((shape: PointShape) => {
    setPointShapeState(shape);
    rendererRef.current?.setPointShape(shape);
  }, []);

  const setColorMode = useCallback(
    (mode: ColorMode) => {
      // 現在開いているファイルがRGBを持たない場合は、"rgb"を選ぼうとしても
      // 自動的に標高へ落とす（受け入れ条件「RGBを持たない点群ではRGBが選べないか、
      // 選んだときに分かる形で別モードに落ちる」）。`LayerPanel`側でも"rgb"の
      // 選択肢自体をdisabledにしているため、通常はここに到達しないが、
      // 二重の安全策として関数側でも解決する。
      const resolved = resolveColorMode(mode, cloudInfo?.hasColor ?? false);
      setColorModeState(resolved);
      rendererRef.current?.setColorMode(resolved);
    },
    [cloudInfo],
  );

  const dismissGpuError = useCallback((id: number) => {
    gpuErrorLogRef.current.dismiss(id);
    setGpuErrors(gpuErrorLogRef.current.list());
  }, []);

  const cancelConversion = useCallback(() => {
    cancelLasConversion().catch((e: unknown) => {
      // 変換が既に終わっていた等、キャンセルが間に合わなかっただけなので
      // ログに残す程度でよい(ユーザーに新たなエラーとして見せる必要は無い)。
      console.error("cancelLasConversion failed", e);
    });
  }, []);

  const setTempDir = useCallback((dir: string | null) => {
    setTempDirState(dir);
    try {
      if (dir === null) {
        localStorage.removeItem(TEMP_DIR_STORAGE_KEY);
      } else {
        localStorage.setItem(TEMP_DIR_STORAGE_KEY, dir);
      }
    } catch {
      // 保存できなくても動作に支障はない(次回起動時に既定値へ戻るだけ)。
    }
  }, []);

  const pickAndSetTempDir = useCallback(async () => {
    const picked = await pickTempDirectory();
    if (picked) setTempDir(picked);
  }, [setTempDir]);

  const clearTempDir = useCallback(() => setTempDir(null), [setTempDir]);

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
    isMobile: deviceProfileDefaults.isMobile,
    deviceMemoryGiB: deviceProfileInput.deviceMemoryGiB,
    pointerCoarse: deviceProfileInput.pointerCoarse,
    pointBudgetMax: deviceProfileDefaults.pointBudgetMax,
    renderScale,
    pointShape,
    colorMode,
    gpuErrors,
    openFile,
    isBrowser: !isTauriEnvironment(),
    conversionProgress,
    cancelConversion,
    tempDir,
    supportsCustomTempDir: supportsCustomTempDirState,
    pickAndSetTempDir,
    clearTempDir,
    setPointBudget,
    setAutoPointBudgetEnabled,
    setBackgroundMode,
    setGridEnabled,
    setEdlEnabled,
    setRenderScale,
    setPointShape,
    setColorMode,
    dismissGpuError,
  };
  return [canvasRef, state];
}
