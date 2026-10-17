// The public shape of the viewer state: `CopcViewerState` (what `useCopcViewer()` returns to the UI) and the
// small types it is made of. Types only, no code.
// Used by: src/ui (through the re-exports in useCopcViewer.ts), useLayerTool.ts, useMeasureTool.ts.
// The hooks that fill each group of fields are listed in useCopcViewer.ts.
import type { ConversionProgress } from "../datasource/conversion-dto";
import type { CachedConversionEntry, OpfsUsageBreakdown } from "../datasource/opfs";
import type { ExtractFilter } from "../datasource/tools";
import type { RenderStats } from "../renderer/point-cloud-renderer";
import type { BackgroundMode } from "../renderer/sky";
import type { GpuErrorEntry, GpuErrorSource } from "../renderer/gpu-error-log";
import type { ColorMode } from "../renderer/colormap";
import type { PointShape } from "../renderer/device-profile";
import type { Measurement } from "./measure";
import type { ViewerLayer } from "./layers";


/** Progress of the running point-cloud tool (L2-F). `totalPoints` is 0 until the first progress arrives. */
export interface ToolProgressState {
  title: string;
  pointsRead: number;
  totalPoints: number;
}

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

// L1-D: レイヤー1件の型も同じ理由で再エクスポートする。
export type { ViewerLayer };

// UI(src/ui)はdatasourceを直接触らずstate経由にする規約（規約2の裏返し。
// tauri.tsをimportしてよいのはこのファイルだけ）のため、
// ConversionProgressもここから再エクスポートする（M4-3）。
export type { ConversionProgress };

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
  /**
   * L1-D: 開いているレイヤーの一覧（足した順）。「開く」は常に末尾へ足す（置き換えない）。
   * 名前・点群情報・点数・着色・表示/非表示・変換の内訳・ダウンロードはレイヤーごとに持つ。
   */
  layers: ViewerLayer[];
  /** 選択中のレイヤーの id。レイヤーが無ければ null。足したレイヤーは自動で選択になる。 */
  selectedLayerId: string | null;
  /** `layers` の中の選択中の1件（無ければ null）。レイヤー情報・着色ダイアログ・CRS 表示が引く。 */
  selectedLayer: ViewerLayer | null;
  selectLayer: (id: string) => void;
  setLayerVisible: (id: string, visible: boolean) => void;
  /** そのレイヤーの着色を変える。RGB を持たないレイヤーで "rgb" を選んだら標高に落ちる。 */
  setLayerColorMode: (id: string, mode: ColorMode) => void;
  /** L2-B: そのレイヤーの点の形（丸/四角）。 */
  setLayerPointShape: (id: string, shape: PointShape) => void;
  /** L2-B: そのレイヤーの点の大きさ（直径px、1〜32に丸める）。 */
  setLayerPointSize: (id: string, px: number) => void;
  /** L2-B: そのレイヤーへカメラを移す（アニメーション無効なら即時）。 */
  focusLayer: (id: string, orientation?: { yaw: number; pitch: number }) => void;
  /** L2-F: ids selected together (Ctrl/Shift click). Includes `selectedLayerId` (the last chosen; the action buttons act on it). */
  selectedLayerIds: string[];
  /** L2-F: Ctrl/Cmd click: add to / remove from the selection. */
  toggleLayerSelection: (id: string) => void;
  /** L2-F: Shift click: select the rows between `selectedLayerId` and this one. */
  selectLayerRange: (id: string) => void;
  /** L2-F: progress of the running point-cloud tool, or null. */
  toolProgress: ToolProgressState | null;
  cancelTool: () => void;
  /** L2-F: make a new layer from the points of `layerId` that match `filter` (ADR-0018). Failures go to the error log. */
  extractFromLayer: (
    layerId: string,
    filter: ExtractFilter,
    label: "選択" | "断面",
    viewNormal?: readonly [number, number, number],
  ) => Promise<void>;
  /** L2-F: merge the selected point-cloud layers into one new layer. */
  mergeSelectedLayers: () => Promise<void>;
  /** レイヤーを消す（renderer から外し、DataSource のファイルも閉じる）。 */
  removeLayer: (id: string) => void;
  /** L2-D: 3D coordinates of a screen point (canvas CSS pixels); null where there is no point. The renderer's `pickPoint`. */
  pickPoint: (cssX: number, cssY: number) => Promise<{ point: [number, number, number]; refined: boolean } | null>;
  /** L2-D: latest-frame viewProj and up axis (for overlaying measurement lines). */
  getViewSnapshot: () => { viewProj: number[]; up: readonly [number, number, number] } | null;
  /** L2-D: add a finished measurement as a new "measurement" layer (it becomes the selection). */
  addMeasurement: (measurement: Measurement) => void;
  pointBudget: number;
  /** タスクB(ADR-0009)の自動調整のオン/オフ。既定値はrendererの既定(true)に合わせている。 */
  autoPointBudgetEnabled: boolean;
  stats: RenderStats | null;
  backgroundMode: BackgroundMode;
  gridEnabled: boolean;
  /** M2-1: EDL(Eye-Dome Lighting)のオン/オフ。既定はrendererの既定(オン)に
   *  合わせている。RGBを持たない点群(sofi.copc.laz)でも形状を読めるようにする
   *  必須機能なので、既定でオフにはしていない（TaskSheets/M2-shading-and-ui.md
   *  M2-1参照）。強さはUIから調整する手段を置かず、`src/renderer/edl.ts`の
   *  `DEFAULT_EDL_STRENGTH`で固定している（値と経緯はそちらのコメント参照）。 */
  edlEnabled: boolean;
  /** AN: アニメーション（フェードイン・慣性・視点移動）のオン/オフ。UIのトグルは未実装（UIの作り直し後）。 */
  animationEnabled: boolean;
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
  /** WebGPUのエラー（ADR-0011）。`device.onuncapturederror`・デバイス消失・初期化時の
   *  バリデーションエラーがここに蓄積される。M3(ADR-0013)以降は`pcv://`の
   *  ノード読み出し失敗（Rust側のpanicから復旧したものを含む）も同じ配列に
   *  混ざる（`GpuErrorEntry.source`で区別する）。蓄積・重複抑制のロジック自体は
   *  `GpuErrorLog`（renderer/gpu-error-log.ts、GPUに依存しない純粋なクラス）に
   *  切り出してあり、ここではそのスナップショットを保持するだけ。表示は
   *  `src/ui/dialogs/ErrorDialog.tsx`が担当する（規約3）。 */
  gpuErrors: GpuErrorEntry[];
  /**
   * UIシェル再構築(ADR-0017)で追加: このセッション中に報告された全エラーの
   * 履歴（`dismissGpuError`で消しても消えない）。`gpuErrors`は バナーが表示する
   * 「現在出ている」エラーで、閉じると配列から消える。エラーログダイアログ
   * （`ErrorDialog.tsx`の履歴モード）はこちらを表示することで、閉じたエラーも含めて
   * 「このセッションで何が起きたか」をあとから確認できるようにする。
   * 追記・countの更新だけを行い、エントリを削除することは無い
   * （`recordErrorHistory`参照）。
   */
  errorHistory: GpuErrorEntry[];
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
  /** True in the browser build. The toolbar's open button (`buttons/OpenFileButton.tsx`) uses it to switch between the Tauri file dialog and the Web file input. */
  isBrowser: boolean;
  /** Sends a message to the existing error banner and log (ADR-0011). `source` defaults to "gpu". */
  reportError: (message: string, source?: GpuErrorSource) => void;
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
   * 選択中のレイヤーの変換の内訳を、クリップボードへコピーする。
   * コピーに成功したら`true`を返す(失敗は握りつぶしてログだけ残す)。
   * 内訳・ダウンロード（Web版）は変換で作ったレイヤーの `ViewerLayer` に付く。
   */
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
  setAnimationEnabled: (enabled: boolean) => void;
  /** AN-2: 「全体を表示」。アニメーションで初期の位置・向きに戻る。 */
  resetView: () => void;
  setRenderScale: (scale: number) => void;
  setPointShape: (shape: PointShape) => void;
  setCenterPriorityStrength: (strength: number) => void;
  setMinCenterPriorityWeight: (minWeight: number) => void;
  /** バナーの「閉じる」ボタンから呼ぶ。指定したエラーだけを消す。 */
  dismissGpuError: (id: number) => void;
}
