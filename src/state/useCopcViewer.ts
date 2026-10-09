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
  startMultiLasConversion,
  supportsCustomTempDir as fetchSupportsCustomTempDir,
} from "../datasource/tauri";
import { WebSource } from "../datasource/web";
import { isCopcFile } from "../datasource/copc-header";
import {
  cleanupStaleScratchDirs,
  clearAllCachedConversions,
  describeInsufficientSpaceWeb,
  ensurePersistentStorage,
  estimateQuota,
  getConvertedFile,
  getOpfsUsageBreakdown,
  isPersisted,
  multiDisplayNameFor,
  removeCachedConversionEntry,
  removeScratchDirByName,
  type CachedConversionEntry,
  type OpfsUsageBreakdown,
} from "../datasource/opfs";
import { detectSourceFormatByName } from "../datasource/source-format";
import { isTauriEnvironment } from "../datasource/environment";
import type { CloudInfo, DataSource } from "../datasource/DataSource";
import type { ConversionProgress } from "../datasource/conversion-dto";
import { formatConversionBreakdown, type ConversionBreakdownMeta } from "../datasource/conversion-breakdown";
import { PointCloudRenderer, type RenderStats } from "../renderer/point-cloud-renderer";
import { DEFAULT_BACKGROUND_MODE, type BackgroundMode } from "../renderer/sky";
import { DEFAULT_GRID_ENABLED } from "../renderer/ground-grid";
import { GpuErrorLog, type GpuErrorEntry } from "../renderer/gpu-error-log";
import { DEFAULT_COLOR_MODE, resolveColorMode, type ColorMode } from "../renderer/colormap";
import { defaultRenderSettings, readDeviceProfileInput, type PointShape } from "../renderer/device-profile";
import { DEFAULT_CENTER_PRIORITY_STRENGTH, DEFAULT_MIN_CENTER_PRIORITY_WEIGHT } from "../renderer/center-priority";

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

/** M4-12(`TaskSheets/M4-import-and-conversion.md`): `path`(Tauri版の
 *  `\`/`/`どちらも使える文字列パス)の最後の区切り以降をファイル名として
 *  返す(拡張子の判定・内訳テキストの表示用。実在のパスである必要は無い、
 *  `pcv_convert::output_path`と同じ割り切り)。 */
function basenameOfPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const lastSlash = normalized.lastIndexOf("/");
  return lastSlash === -1 ? normalized : normalized.slice(lastSlash + 1);
}

/** ファイル名の拡張子(小文字、無ければ"(不明)")。内訳テキストの「形式」欄に使う。 */
function extensionOfFileName(fileName: string): string {
  const dotIndex = fileName.lastIndexOf(".");
  return dotIndex === -1 ? "(不明)" : fileName.slice(dotIndex + 1).toLowerCase();
}

/**
 * 不具合修正(2026-10-08、所有者の報告「変換の内訳が出てこない」):
 * `openFile`の冒頭で「変換の内訳(`conversionBreakdownText`)・ダウンロードリンク
 * (`downloadReady`)を消すかどうか」を判断する部分だけを、純粋関数として
 * 切り出す。
 *
 * **直す前の問題**: 変換完了時のハンドラ(`onConvertDone`/`onConversionDone`)が
 * `setConversionBreakdownText(...)`(Web版は`setDownloadReady(...)`も)で
 * 内訳を設定した直後、変換結果を開くために続けて`openFileRef.current(...)`
 * (`openFile`)を呼んでいた。`openFile`は冒頭で問答無用に
 * `setConversionBreakdownText(null)`/`setDownloadReady(null)`を呼んでいたため、
 * 設定した直後に消えてしまい、Web版・デスクトップ版の両方で「変換の内訳」が
 * 画面に出ず、Web版の変換結果のダウンロードリンクも消えていた。
 *
 * **直し方**: 内訳・ダウンロードリンクを消すのは、利用者が自分で新しい
 * ファイルを開いたときだけにする。`openFile`の第2引数
 * `isConversionContinuation`(変換完了から続けて開く呼び出しかどうか。
 * 既定false)がtrueのときは消さない。利用者が自分でファイルを開く経路
 * (`LayerPanel.tsx`/`SettingsModal.tsx`)はこの引数を渡さないので、既定の
 * false(=消す)のままになる。
 *
 * 消す判断を呼び出し側(UIの各ボタン)に分散させるより、「いつ消すか」を
 * `openFile`一箇所に残したほうが所有者がこの関数を読むだけで全体の挙動を
 * 追えるため、この形を選んだ。`openFile`自体は`PointCloudRenderer`/
 * `DataSource`を触る大きな関数でテストしにくいため、判断部分だけを
 * `useTheme.ts`の`resolveTheme`と同じやり方でここだけ切り出してテストする
 * (`useCopcViewer.test.ts`参照)。
 */
export function shouldClearConversionResultOnOpen(isConversionContinuation: boolean): boolean {
  return !isConversionContinuation;
}

/** M4-12: 内訳テキストに入れる端末情報。`navigator.deviceMemory`は
 *  Chrome系だけの実験的API(型定義に無いため`as`で読む)。取れなければ
 *  `undefined`のままにする(無いことを0などの値で埋めない)。 */
function currentDeviceMeta(): Pick<ConversionBreakdownMeta, "browser" | "hardwareConcurrency" | "deviceMemoryGiB"> {
  const nav = navigator as Navigator & { deviceMemory?: number };
  return {
    browser: nav.userAgent,
    hardwareConcurrency: nav.hardwareConcurrency,
    deviceMemoryGiB: nav.deviceMemory,
  };
}

/**
 * M4-6追記: Web版のOPFS使用量(内訳)と永続化の状態をまとめた、設定画面
 * (SettingsModal「ブラウザの保存領域」節)向けの表示用の値。`quotaBytes`/
 * `usageBytes`は`estimateQuota()`、`persisted`は`isPersisted()`、
 * `breakdown`は`getOpfsUsageBreakdown()`の結果をそのまま持つ
 * (`refreshOpfsStorageInfo`がまとめて取得する)。
 */
export interface OpfsStorageInfo {
  quotaBytes: number;
  usageBytes: number;
  persisted: boolean;
  breakdown: OpfsUsageBreakdown;
}

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
  /** ADR-0010追記: LOD優先度に画面中央からの距離で掛ける重みの強さ。0で
   *  今までどおり（画面空間誤差のみ）。既定値は`center-priority.ts`の
   *  `DEFAULT_CENTER_PRIORITY_STRENGTH`（未検証の初期値）。設定画面から
   *  変更でき、再起動なしでrendererへ反映される。 */
  centerPriorityStrength: number;
  /** 2026-10-08追記: 中央優先度の重みの下限（0〜1）。既定は
   *  `DEFAULT_MIN_CENTER_PRIORITY_WEIGHT`（0.2）。0に近いほど画面端の
   *  ノードを後回しにしてよい度合いが大きくなる。設定画面のスライダーから
   *  変更でき、再起動なしでrendererへ反映される
   *  （`PointCloudRenderer.setMinCenterPriorityWeight()`参照）。 */
  minCenterPriorityWeight: number;
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
  /**
   * UIシェル再構築(ADR-0017)で追加: このセッション中に報告された全エラーの
   * 履歴（`dismissGpuError`で消しても消えない）。`gpuErrors`は バナーが表示する
   * 「現在出ている」エラーで、閉じると配列から消える。エラーログダイアログ
   * （`ErrorLogDialog.tsx`）はこちらを表示することで、閉じたエラーも含めて
   * 「このセッションで何が起きたか」をあとから確認できるようにする。
   * 追記・countの更新だけを行い、エントリを削除することは無い
   * （`recordErrorHistory`参照）。
   */
  errorHistory: GpuErrorEntry[];
  /** 開いているファイルの名前（パス/URLの最後の区切り以降、またはFileのname）。
   *  まだ何も開いていない・開くのに失敗した場合は`null`（UIシェル再構築で追加。
   *  左パネルのレイヤー情報に表示する）。 */
  openedFileName: string | null;
  /** 変換ダイアログ(ConversionDialog.tsx)に出す、変換中の元ファイル名。まだ変換していなければnull。 */
  convertingFileName: string | null;
  /** Tauri版はパス文字列、Web版はURL文字列か、ドラッグ&ドロップ/選択した`File`を渡す。 */
  openFile: (pathOrFile: string | File) => Promise<void>;
  /**
   * M4-14: ファイル選択で複数(2件以上)選ばれたときに呼ぶ。LAS/LAZを1つの
   * COPCへマージして開く(`src-tauri`の`start_multi_las_conversion`/Web版の
   * `WebSource.startMultiConversion`)。1件だけ渡された場合は`openFile`と
   * 同じ挙動になる(受け入れ条件「単一ファイルは今までと同じ挙動」)。
   * PLY/PCD/E57が混じっていた場合は、変換を試みる前に明確なエラーを出す
   * (受け入れ条件。LAS/LAZの混在はOK)。
   */
  openFiles: (pathsOrFiles: string[] | File[]) => Promise<void>;
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
  /**
   * M4-6b: Web版で変換が完了したときだけ入る、ダウンロード用のURL
   * (`URL.createObjectURL`)とファイル名。OPFSの中身はアプリの外から
   * 取り出す手段が無いため、変換結果を保存したい所有者向けにこれを出す
   * (受け入れ条件「変換したCOPCをダウンロードできるようにする」)。
   * Tauri版・変換していないときは`null`。
   */
  downloadReady: { url: string; fileName: string } | null;
  /** ダウンロードのURLを明示的に破棄する(`URL.revokeObjectURL`込み)。 */
  clearDownload: () => void;
  /**
   * M4-12(`TaskSheets/M4-import-and-conversion.md`): 直前に完了した変換の、
   * 段階ごとの所要時間を所有者がそのまま報告できる形に整形したテキスト
   * (`src/datasource/conversion-breakdown.ts`の`formatConversionBreakdown`)。
   * Web版・デスクトップ版どちらも変換完了時に入る。次にファイルを開くと
   * (`openFile`が)`null`に戻す。
   */
  conversionBreakdownText: string | null;
  /** 上記テキストをクリップボードへコピーする(`navigator.clipboard`)。
   *  コピーに成功したら`true`を返す(失敗は握りつぶしてログだけ残す。
   *  ボタンの一時的な「コピーしました」表示に使うことを想定)。 */
  copyConversionBreakdownText: () => Promise<boolean>;
  /**
   * M4-6追記: Web版のOPFS使用量(キャッシュ・一時ファイルの内訳)と永続化の
   * 状態。取得前・Tauri版では`null`(`viewer.isBrowser`で先に弾く想定。
   * `SettingsModal`参照)。`refreshOpfsStorageInfo`で更新する。
   */
  opfsStorageInfo: OpfsStorageInfo | null;
  /** `opfsStorageInfo`を取得・再計算する(設定画面を開いたとき、消した後など)。 */
  refreshOpfsStorageInfo: () => Promise<void>;
  /** まだ永続化されていなければ`persist()`を求め、結果に関わらず
   *  `opfsStorageInfo`を更新する(設定画面の「許可を求める」ボタン用)。 */
  requestOpfsPersistentStorage: () => Promise<void>;
  /** 変換済みキャッシュを1件消し、`opfsStorageInfo`を更新する。 */
  removeOpfsCachedConversion: (entry: CachedConversionEntry) => Promise<void>;
  /** 変換済みキャッシュを全て消し、`opfsStorageInfo`を更新する。 */
  clearOpfsCachedConversions: () => Promise<void>;
  /** 残っている一時ディレクトリを1件消し、`opfsStorageInfo`を更新する。 */
  removeOpfsScratchDir: (name: string) => Promise<void>;
  /** 残っている一時ディレクトリを全て消し、`opfsStorageInfo`を更新する。 */
  clearOpfsScratchDirs: () => Promise<void>;
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
  setCenterPriorityStrength: (strength: number) => void;
  setMinCenterPriorityWeight: (minWeight: number) => void;
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
  const [centerPriorityStrength, setCenterPriorityStrengthState] = useState(DEFAULT_CENTER_PRIORITY_STRENGTH);
  const [minCenterPriorityWeight, setMinCenterPriorityWeightState] = useState(DEFAULT_MIN_CENTER_PRIORITY_WEIGHT);
  const [colorMode, setColorModeState] = useState<ColorMode>(DEFAULT_COLOR_MODE);
  const [gpuErrors, setGpuErrors] = useState<GpuErrorEntry[]>([]);
  // UIシェル再構築(ADR-0017)で追加: dismissで消えないエラー履歴。
  // `setGpuErrors`の直後に呼ぶ`recordErrorHistory`だけが更新する
  // （`dismissGpuError`からは呼ばない。消えないことがこの履歴の存在理由）。
  const [errorHistory, setErrorHistory] = useState<GpuErrorEntry[]>([]);
  const recordErrorHistory = (current: GpuErrorEntry[]) => {
    setErrorHistory((prev) => {
      const byId = new Map(prev.map((entry) => [entry.id, entry] as const));
      for (const entry of current) byId.set(entry.id, entry);
      return Array.from(byId.values()).sort((a, b) => a.firstAt - b.firstAt);
    });
  };
  // UIシェル再構築(ADR-0017)で追加: 左パネルのレイヤー情報に出すファイル名。
  const [openedFileName, setOpenedFileName] = useState<string | null>(null);
  // 変換ダイアログに出す「いま変換している元ファイル名」(複数選択のときは表示名)。
  const [convertingFileName, setConvertingFileName] = useState<string | null>(null);
  // M4-3: 変換中の進捗。変換していないときはnull。
  const [conversionProgress, setConversionProgress] = useState<ConversionProgress | null>(null);
  // M4-6b: Web版の変換完了後だけ入るダウンロード用URL。
  const [downloadReady, setDownloadReadyState] = useState<{ url: string; fileName: string } | null>(null);
  const downloadReadyRef = useRef<{ url: string; fileName: string } | null>(null);
  // M4-12(`TaskSheets/M4-import-and-conversion.md`): 直前に完了した変換の、
  // 所有者がそのまま報告できる内訳テキスト。変換していない・まだ完了していない
  // ときは`null`。次に`openFile`を呼ぶとクリアする(`downloadReady`と同じ扱い)。
  const [conversionBreakdownText, setConversionBreakdownText] = useState<string | null>(null);
  // 変換を開始する直前に元ファイル名を覚えておく(`openFile`が設定し、
  // マウント時に1度だけ張る`onConversionDone`/`onConvertDone`のハンドラが
  // 変換完了時にこれを読む。両ハンドラはクロージャ生成時点のファイル名を
  // 知らないため、refで渡す。「effectは一度だけ、でも中身は最新でありたい」
  // という`openFileRef`と同じ理由)。
  const convertingSourceNameRef = useRef<string | null>(null);

  // 直前のダウンロードURLを(あれば)revokeしてから、新しい状態を設定する。
  // `null`を渡すと「ダウンロードを破棄するだけ」になる。
  const setDownloadReady = useCallback((next: { url: string; fileName: string } | null) => {
    if (downloadReadyRef.current) {
      URL.revokeObjectURL(downloadReadyRef.current.url);
    }
    downloadReadyRef.current = next;
    setDownloadReadyState(next);
  }, []);

  const clearDownload = useCallback(() => setDownloadReady(null), [setDownloadReady]);

  // M4-12: `conversionBreakdownText`はstateそのもの(上で宣言済み)。ここでは
  // クリップボードへコピーする関数だけを作る。`navigator.clipboard`が無い
  // 環境(非HTTPS等)でも画面を壊さないよう、失敗はログに残すだけにする。
  const copyConversionBreakdownText = useCallback(async (): Promise<boolean> => {
    if (conversionBreakdownText === null) return false;
    try {
      await navigator.clipboard.writeText(conversionBreakdownText);
      return true;
    } catch (e: unknown) {
      console.error("copyConversionBreakdownText failed", e);
      return false;
    }
  }, [conversionBreakdownText]);

  // M4-6追記: Web版のOPFS使用量・永続化の状態(設定画面「ブラウザの保存領域」節)。
  const [opfsStorageInfo, setOpfsStorageInfo] = useState<OpfsStorageInfo | null>(null);

  const refreshOpfsStorageInfo = useCallback(async () => {
    if (isTauriEnvironment()) return;
    try {
      const [estimate, breakdown, persisted] = await Promise.all([
        estimateQuota(),
        getOpfsUsageBreakdown(),
        isPersisted(),
      ]);
      setOpfsStorageInfo({ quotaBytes: estimate.quota, usageBytes: estimate.usage, persisted, breakdown });
    } catch (e: unknown) {
      // 取得できなくても画面が壊れないよう、ログに残す程度に留める
      // (設定画面側は`opfsStorageInfo`が更新されず「読み込み中…」のままになるだけ)。
      console.error("refreshOpfsStorageInfo failed", e);
    }
  }, []);

  const requestOpfsPersistentStorage = useCallback(async () => {
    if (!isTauriEnvironment()) {
      try {
        await ensurePersistentStorage(navigator.storage);
      } catch (e: unknown) {
        console.error("ensurePersistentStorage failed", e);
      }
    }
    await refreshOpfsStorageInfo();
  }, [refreshOpfsStorageInfo]);

  const removeOpfsCachedConversion = useCallback(
    async (entry: CachedConversionEntry) => {
      await removeCachedConversionEntry(entry);
      await refreshOpfsStorageInfo();
    },
    [refreshOpfsStorageInfo],
  );

  const clearOpfsCachedConversions = useCallback(async () => {
    await clearAllCachedConversions();
    await refreshOpfsStorageInfo();
  }, [refreshOpfsStorageInfo]);

  const removeOpfsScratchDir = useCallback(
    async (name: string) => {
      await removeScratchDirByName(name);
      await refreshOpfsStorageInfo();
    },
    [refreshOpfsStorageInfo],
  );

  const clearOpfsScratchDirs = useCallback(async () => {
    await cleanupStaleScratchDirs();
    await refreshOpfsStorageInfo();
  }, [refreshOpfsStorageInfo]);
  const [tempDir, setTempDirState] = useState<string | null>(() => readStoredTempDir());
  // Androidかどうかはフロントから直接判定できないため、起動時に一度だけ
  // Rust側へ問い合わせる(既定はtrue=デスクトップ相当。Web版はisBrowserが
  // 別途trueになるので、この値がtrueのままでもUI側でisBrowserを優先して隠す)。
  const [supportsCustomTempDirState, setSupportsCustomTempDirState] = useState(true);

  // `openFile`は`colorMode`等に依存して再生成される(下のuseCallback参照)。
  // マウント時に1度だけ張るイベント購読(下のuseEffect)から常に最新の
  // `openFile`を呼べるよう、refに常に最新の関数を入れておく
  // (「effectは一度だけ、でも中身は最新でありたい」という定番の対処)。
  const openFileRef = useRef<(pathOrFile: string | File, isConversionContinuation?: boolean) => Promise<void>>(
    () => Promise.resolve(),
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const renderer = new PointCloudRenderer(canvas);
    const source: DataSource = isTauriEnvironment() ? new TauriSource() : new WebSource();
    rendererRef.current = renderer;
    sourceRef.current = source;
    renderer.setDataSource(source);

    // M4-3/M4-6b: 変換の進捗・完了・失敗イベントの購読。Tauri版は
    // `src/datasource/tauri.ts`のイベント(Rustのbackendから`listen`)、Web版は
    // `WebSource`自身のリスナー登録(WorkerからのpostMessageを内部で仲介する。
    // `src/datasource/web.ts`参照)と、経路が全く違うためここで分岐する
    // (Web版はそもそもTauriのイベント配信の裏付けが無い)。
    let unlistenProgress = () => {};
    let unlistenDone = () => {};
    let unlistenFailed = () => {};

    const reportConversionFailure = (message: string, cancelled: boolean) => {
      setConversionProgress(null);
      setStatus(cancelled ? "idle" : "error");
      setError(cancelled ? null : message);
      // 受け入れ条件: 変換の失敗・キャンセルは画面に出す(ADR-0011/ADR-0013の
      // エラーバナー)。キャンセルも「何が起きたか」が分かるようにバナーへ出す
      // (バナーが無いと、進捗が消えるだけで所有者には何も起きなかったように見える)。
      gpuErrorLogRef.current.report(
        cancelled ? "変換をキャンセルしました" : `変換に失敗しました: ${message}`,
        undefined,
        "conversion",
      );
      setGpuErrors(gpuErrorLogRef.current.list());
      recordErrorHistory(gpuErrorLogRef.current.list());
    };

    if (source instanceof WebSource) {
      unlistenProgress = source.onConvertProgress((progress) => setConversionProgress(progress));
      unlistenDone = source.onConvertDone((outputName, suggestedFileName, _pointCount, stageTimings) => {
        setConversionProgress(null);
        // M4-12: 内訳テキストを組み立てる。元ファイル名は`openFile`が変換開始前に
        // 覚えておいた値(`convertingSourceNameRef`)を使う(`suggestedFileName`は
        // 既に".copc.laz"へ拡張子が変わっているため、元の形式が分からない)。
        const sourceName = convertingSourceNameRef.current ?? suggestedFileName;
        setConversionBreakdownText(
          formatConversionBreakdown(stageTimings, {
            platform: "web",
            format: extensionOfFileName(sourceName),
            fileName: sourceName,
            ...currentDeviceMeta(),
          }),
        );
        void (async () => {
          // OPFSに書いた出力を`File`として取り出し、通常のローカルファイル選択と
          // 同じ経路(`registerFile`→`open`)で開く。ダウンロード用のURLも
          // ここで作る(OPFSの中身はアプリの外から直接取り出せないため。
          // 受け入れ条件「変換したCOPCをダウンロードできるようにする」)。
          const file = await getConvertedFile(outputName);
          if (!file) {
            setStatus("error");
            setError("変換結果をOPFSから読み出せませんでした");
            return;
          }
          setDownloadReady({ url: URL.createObjectURL(file), fileName: suggestedFileName });
          const key = source.registerFile(file);
          // 不具合修正(2026-10-08): ここで設定した内訳(setConversionBreakdownText)・
          // ダウンロードリンク(setDownloadReady)を、続けて呼ぶopenFileが冒頭で
          // 消してしまっていた(利用者が新しいファイルを開いたときと見分けが
          // 付かなかったため)。「変換結果を続けて開く」ことを示す第2引数
          // trueを渡し、消さないようにする。
          void openFileRef.current(key, true);
        })();
      });
      unlistenFailed = source.onConvertFailed(reportConversionFailure);
    } else {
      void onConversionProgress((progress) => setConversionProgress(progress)).then((fn) => {
        unlistenProgress = fn;
      });
      void onConversionDone((outputPath, sourceFormat, stageTimings) => {
        // 変換が終わった出力(既にCOPC)をそのまま開き直す。もう一度
        // start_las_conversionを経由するが、既にCOPCと判定されて即座に開く
        // 経路に入るだけなので実害は無い(往復コストはヘッダー1回分)。
        setConversionProgress(null);
        setConversionBreakdownText(
          formatConversionBreakdown(stageTimings, {
            platform: "desktop",
            format: sourceFormat,
            fileName: convertingSourceNameRef.current ?? basenameOfPath(outputPath),
            ...currentDeviceMeta(),
          }),
        );
        // 不具合修正(2026-10-08): Web版と同じ理由(上のコメント参照)で、
        // 第2引数trueを渡して内訳を消さないようにする。
        void openFileRef.current(outputPath, true);
      }).then((fn) => {
        unlistenDone = fn;
      });
      void onConversionFailed(reportConversionFailure).then((fn) => {
        unlistenFailed = fn;
      });
    }

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
        // ADR-0010追記: 中央優先度の強さがUIからrendererまで届いているかを、
        // 画面の目視確認の前にstdoutだけでも確認できるようにする。
        `centerPriorityStrength=${s.centerPriorityStrength.toFixed(2)} ` +
        // 2026-10-08追記: 下限もスライダーで変えられるようにしたので、同様に
        // stdoutで確認できるようにする。
        `minCenterPriorityWeight=${s.minCenterPriorityWeight.toFixed(2)} ` +
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
      recordErrorHistory(gpuErrorLogRef.current.list());
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
      recordErrorHistory(gpuErrorLogRef.current.list());
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
    // setDownloadReadyは依存配列を空にしたuseCallbackで作った安定参照
    // (revoke込みのsetter)なので、ここに加えてもこのeffectの「マウント時に
    // 1度だけ」という性質は変わらない(react-hooks/exhaustive-deps対応)。
  }, [setDownloadReady]);

  const openFile = useCallback(async (pathOrFile: string | File, isConversionContinuation = false) => {
    const renderer = rendererRef.current;
    const source = sourceRef.current;
    if (!renderer || !source) return;

    setStatus("opening");
    setError(null);
    setOpenedFileName(null);
    setConversionProgress(null);
    if (shouldClearConversionResultOnOpen(isConversionContinuation)) {
      setDownloadReady(null);
      setConversionBreakdownText(null);
    }
    try {
      // Web版のローカルファイル選択は`File`を受け取る。`DataSource.open()`は
      // 文字列しか取らないので、先に`WebSource.registerFile()`でキーへ変換する
      // （TauriSourceにはFileを渡す経路が無い。ファイル選択UIはWeb版でしか
      // 出さないので、ここに来る時点でsourceは必ずWebSourceのはず）。
      let path: string;
      if (typeof pathOrFile === "string") {
        path = pathOrFile;
      } else if (source instanceof WebSource) {
        // M4-6b: 拡張子ではなくヘッダーで判定し(`copc-header.ts`、Rust側の
        // `copc_detect.rs`と同じ考え方)、既にCOPCならそのまま開く。生の
        // LAS/LAZならWeb版でも変換する(OPFS上、`WebSource.startConversion`)。
        if (await isCopcFile(pathOrFile)) {
          path = source.registerFile(pathOrFile);
        } else {
          // M4-9追記: 形式を先に判定してから変換経路を選ぶ(実機不具合の修正:
          // 以前はCOPCでないファイルを全てLAS/LAZ変換の経路に回しており、
          // PCD(非圧縮・f64座標)がLAS/LAZ向けの容量見積もりで誤って
          // 「空き容量不足」と判定されていた)。PLY/E57はこのセッションでは
          // Web版の変換経路をまだ用意していない(`TaskSheets/
          // M4-import-and-conversion.md`のM4-9/M4-6参照。pcd-rs・e57クレート
          // 自体はwasm32でビルドできることを確認済みだが、実装は見送った)ため、
          // 誤解を招く容量チェックを試みず、ここで案内を出して終える。
          const format = detectSourceFormatByName(pathOrFile.name);
          if (format === "ply" || format === "e57") {
            setStatus("error");
            setError(
              `このファイル形式(${format.toUpperCase()})はWeb版ではまだ変換できません。デスクトップ版でCOPC(.copc.laz)に変換してから開いてください。`,
            );
            return;
          }
          // M4-12: 内訳テキストに入れる元ファイル名を、変換完了時のハンドラが
          // 読めるように覚えておく(マウント時に1度だけ張る`onConvertDone`の
          // クロージャはこの呼び出しのスコープを知らないため)。
          convertingSourceNameRef.current = pathOrFile.name;
          setConvertingFileName(pathOrFile.name);
          const outcome =
            format === "pcd"
              ? await source.startPcdConversion(pathOrFile, deviceProfileDefaults.isMobile)
              : await source.startConversion(pathOrFile, deviceProfileDefaults.isMobile);
          switch (outcome.kind) {
            case "alreadyCopc":
              // startConversion自身はこの値を返さない設計(呼び出し前に
              // isCopcFileで判定済みのため)だが、型の網羅性のために残す。
              path = outcome.path;
              break;
            case "cached":
              path = outcome.outputPath;
              break;
            case "opfsUnavailable":
              setStatus("error");
              setError(
                "お使いのブラウザはOPFS(File System Access API)に対応していないため、Web版では変換できません。デスクトップ版でCOPC(.copc.laz)に変換してから開いてください。",
              );
              return;
            case "insufficientSpace":
              // `ConversionOutcome`はTauri版と共有の型だが、`WebSource`の
              // `startConversion`/`startPcdConversion`はこの形(デスクトップ版、
              // `availableBytes`がOSの実際の空きディスク)を返さず、常に下の
              // "insufficientSpaceWeb"を返す(`web.ts`の`checkInsufficientSpace`
              // 参照)。型の網羅性のためだけに置く、到達しないはずの分岐。
              setStatus("error");
              setError("空き容量が足りません");
              return;
            // M4-6追記: Web版は(デスクトップ版と中身の違う)"insufficientSpaceWeb"を返す。
            case "insufficientSpaceWeb": {
              const message = describeInsufficientSpaceWeb({
                requiredBytes: outcome.requiredBytes,
                quotaBytes: outcome.quotaBytes,
                usageBytes: outcome.usageBytes,
                persisted: outcome.persisted,
                reclaimableBytes: outcome.reclaimableBytes,
              });
              gpuErrorLogRef.current.report(message, undefined, "conversion");
              setGpuErrors(gpuErrorLogRef.current.list());
              recordErrorHistory(gpuErrorLogRef.current.list());
              setStatus("error");
              setError("空き容量が足りません");
              // 消す・永続化を許可する等の導線(設定画面)を出す前に、現在の
              // 使用量を反映しておく(受け入れ条件「消したあと見積もりが更新される」
              // の前提として、まず現在値を持たせる)。
              void refreshOpfsStorageInfo();
              return;
            }
            case "converting":
              // 実際に開く処理はonConvertDoneのイベントハンドラが続きを行う
              // (マウント時のuseEffect参照)。
              setStatus("converting");
              return;
          }
        }
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
        // M4-12: Web版と同じ理由(直前のコメント参照)。
        convertingSourceNameRef.current = basenameOfPath(path);
        setConvertingFileName(basenameOfPath(path));
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
            recordErrorHistory(gpuErrorLogRef.current.list());
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
      renderer.resetForNewFile();
      renderer.setHierarchy(opened.nodes);
      // M2-2実機不具合の修正: 標高の正規化レンジは、ノードのbounds(octreeセル、
      // 立方体でZ範囲が水平方向に引き伸ばされる)ではなく、LASヘッダーの
      // 実データ範囲(CloudInfo.min/max)から設定する（renderer側の
      // `setElevationRange`のコメント、`src/renderer/scene-bounds.ts`参照）。
      renderer.setElevationRange(opened.info.min, opened.info.max);
      setCloudInfo(opened.info);
      setNodeCount(opened.nodes.length);
      setStatus("ready");
      // UIシェル再構築(ADR-0017): 左パネルのレイヤー情報に出すファイル名。
      // Tauri版のパス・Web版のURLはbasenameOfPathで最後の区切り以降だけにし、
      // 選択したFileはそのままname（既にファイル名そのもの）を使う。
      setOpenedFileName(typeof pathOrFile === "string" ? basenameOfPath(pathOrFile) : pathOrFile.name);
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
  }, [colorMode, tempDir, setDownloadReady, deviceProfileDefaults.isMobile, refreshOpfsStorageInfo]);

  /**
   * M4-14: 複数ファイル選択時の入口。`openFile`とほぼ同じ判断
   * (キャッシュ・容量不足・変換開始)を行うが、対象が常にLAS/LAZ(複数)に
   * 絞られる分だけ単純になる(既にCOPCかどうかの判定・PCD/E57等の経路分岐は
   * 単一ファイル専用の`openFile`にしか無い)。
   */
  const openFiles = useCallback(async (pathsOrFiles: string[] | File[]) => {
    if (pathsOrFiles.length === 0) return;
    if (pathsOrFiles.length === 1) {
      await openFileRef.current(pathsOrFiles[0]);
      return;
    }

    const renderer = rendererRef.current;
    const source = sourceRef.current;
    if (!renderer || !source) return;

    setStatus("opening");
    setError(null);
    setConversionProgress(null);
    setDownloadReady(null);
    setConversionBreakdownText(null);

    const isFileArray = typeof pathsOrFiles[0] !== "string";
    const names = isFileArray
      ? (pathsOrFiles as File[]).map((f) => f.name)
      : (pathsOrFiles as string[]).map(basenameOfPath);

    // 受け入れ条件: LAS/LAZの混在はOK、PLY/PCD/E57が混じっていたら変換を
    // 試みる前に明確なエラーを出す(ファイル名を挙げる)。
    const nonLasNames = names.filter((n) => detectSourceFormatByName(n) !== "lasLaz");
    if (nonLasNames.length > 0) {
      setStatus("error");
      setError(
        `複数ファイルの選択はLAS/LAZのみ対応しています。次のファイルは対象外です: ${nonLasNames.join("、")}`,
      );
      return;
    }

    // M4-12と同じ理由(`openFile`参照): 内訳テキストの「ファイル」欄に使う
    // 表示名を、変換開始前に覚えておく。選択順に依存しない表示にするため
    // 昇順ソートしてから組み立てる(要件の表示例「09LD2626 ほか54ファイル」)。
    convertingSourceNameRef.current = multiDisplayNameFor([...names].sort());
    setConvertingFileName(convertingSourceNameRef.current);

    try {
      const outcome =
        isFileArray && source instanceof WebSource
          ? await source.startMultiConversion(pathsOrFiles as File[], deviceProfileDefaults.isMobile)
          : !isFileArray && source instanceof TauriSource
            ? await startMultiLasConversion(pathsOrFiles as string[], tempDir)
            : null;
      if (outcome === null) {
        throw new Error("複数ファイルの選択はこの環境では対応していません");
      }

      switch (outcome.kind) {
        case "cached":
          void openFileRef.current(outcome.outputPath, true);
          return;
        case "converting":
          setStatus("converting");
          return;
        case "opfsUnavailable":
          setStatus("error");
          setError(
            "お使いのブラウザはOPFS(File System Access API)に対応していないため、Web版では変換できません。デスクトップ版でまとめてCOPC(.copc.laz)に変換してから開いてください。",
          );
          return;
        case "insufficientSpace": {
          const toGiB = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);
          gpuErrorLogRef.current.report(
            `空き容量が足りません(必要: 約${toGiB(outcome.requiredBytes)}GiB、空き: 約${toGiB(outcome.availableBytes)}GiB)。設定から一時ファイルの置き場所を変更できます。`,
            undefined,
            "conversion",
          );
          setGpuErrors(gpuErrorLogRef.current.list());
          recordErrorHistory(gpuErrorLogRef.current.list());
          setStatus("error");
          setError("空き容量が足りません");
          return;
        }
        case "insufficientSpaceWeb": {
          const message = describeInsufficientSpaceWeb({
            requiredBytes: outcome.requiredBytes,
            quotaBytes: outcome.quotaBytes,
            usageBytes: outcome.usageBytes,
            persisted: outcome.persisted,
            reclaimableBytes: outcome.reclaimableBytes,
          });
          gpuErrorLogRef.current.report(message, undefined, "conversion");
          setGpuErrors(gpuErrorLogRef.current.list());
          recordErrorHistory(gpuErrorLogRef.current.list());
          setStatus("error");
          setError("空き容量が足りません");
          void refreshOpfsStorageInfo();
          return;
        }
        case "alreadyCopc":
          // 複数ファイルのマージ経路では、呼び出し側(Rust/wasm)がこの値を
          // 返すことは無い(常に新しいCOPCを作る)。型の網羅性のためだけに
          // 置く、到達しないはずの分岐(`openFile`の同種のコメント参照)。
          void openFileRef.current(outcome.path, true);
          return;
      }
    } catch (e) {
      setStatus("error");
      setError(String(e));
    }
  }, [tempDir, deviceProfileDefaults.isMobile, setDownloadReady, refreshOpfsStorageInfo]);

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

  const setCenterPriorityStrength = useCallback((strength: number) => {
    setCenterPriorityStrengthState(strength);
    rendererRef.current?.setCenterPriorityStrength(strength);
  }, []);

  const setMinCenterPriorityWeight = useCallback((minWeight: number) => {
    setMinCenterPriorityWeightState(minWeight);
    rendererRef.current?.setMinCenterPriorityWeight(minWeight);
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
    const source = sourceRef.current;
    if (source instanceof WebSource) {
      // M4-6b: fire-and-forgetのメッセージ(`web-protocol.ts`のConvertCancelRequest)。
      // 読み込みバッチの合間で反映される(`crates/pcv-wasm/src/convert.rs`の
      // ドキュメント参照。後処理段階には割り込めない)。
      source.cancelConversion();
      return;
    }
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
    centerPriorityStrength,
    minCenterPriorityWeight,
    colorMode,
    gpuErrors,
    errorHistory,
    openedFileName,
    convertingFileName,
    openFile,
    openFiles,
    isBrowser: !isTauriEnvironment(),
    conversionProgress,
    cancelConversion,
    downloadReady,
    clearDownload,
    conversionBreakdownText,
    copyConversionBreakdownText,
    opfsStorageInfo,
    refreshOpfsStorageInfo,
    requestOpfsPersistentStorage,
    removeOpfsCachedConversion,
    clearOpfsCachedConversions,
    removeOpfsScratchDir,
    clearOpfsScratchDirs,
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
    setCenterPriorityStrength,
    setMinCenterPriorityWeight,
    setColorMode,
    dismissGpuError,
  };
  return [canvasRef, state];
}
