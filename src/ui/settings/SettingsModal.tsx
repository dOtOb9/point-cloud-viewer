import {
  FolderOpen,
  Gauge,
  Sun,
  Target,
  HardDrive,
  Image,
  Monitor,
  Palette,
  RefreshCw,
  Ruler,
  Zap,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useLayoutEffect, useReducer } from "react";
import type { CopcViewerState } from "../../state/useCopcViewer";
import type { ThemeState } from "../../state/useTheme";
import type { UpdateCheckState } from "../../state/useUpdateCheck";
import { Dialog } from "../dialogs/Dialog";
import { DIALOG_TERTIARY_BUTTON_CLASS } from "../dialogs/dialog-styles";
import { TOOLBAR_BUTTON_CLASS } from "../toolbar/toolbar-styles";
import { settingsNavReducer, visibleSettingsPages, type SettingsPageId } from "./settings-nav";
import { AnimationDialog } from "./pages/AnimationDialog";
import { BackgroundDialog } from "./pages/BackgroundDialog";
import { EdlDialog } from "./pages/EdlDialog";
import { LoadPriorityDialog } from "./pages/LoadPriorityDialog";
import { PointBudgetDialog } from "./pages/PointBudgetDialog";
import { RenderScaleDialog } from "./pages/RenderScaleDialog";
import { StorageDialog } from "./pages/StorageDialog";
import { TempDirDialog } from "./pages/TempDirDialog";
import { ThemeDialog } from "./pages/ThemeDialog";
import { UnitDialog } from "./pages/UnitDialog";
import { UpdateDialog } from "./pages/UpdateDialog";

interface Props {
  open: boolean;
  onClose: () => void;
  theme: ThemeState;
  update: UpdateCheckState;
  viewer: CopcViewerState;
}

/** 一覧のボタン(アイコン+短い名前)。 */
const PAGE_BUTTONS: Record<SettingsPageId, { icon: LucideIcon; label: string }> = {
  theme: { icon: Palette, label: "テーマ" },
  animation: { icon: Zap, label: "アニメーション" },
  background: { icon: Image, label: "背景" },
  pointBudget: { icon: Gauge, label: "点予算" },
  renderScale: { icon: Monitor, label: "解像度" },
  update: { icon: RefreshCw, label: "更新の確認" },
  tempDir: { icon: FolderOpen, label: "一時ファイル" },
  storage: { icon: HardDrive, label: "保存領域" },
  loadPriority: { icon: Target, label: "読み込み優先" },
  edl: { icon: Sun, label: "陰影（EDL）" },
  unit: { icon: Ruler, label: "単位" },
};

/**
 * 設定。L1-E (ADR-0017 追記2): 一覧は「アイコン+名前のボタン」の集合だけで、
 * ボタンを押すと一覧を閉じて、その項目専用のダイアログ(pages/*.tsx)が開く。
 * どちらを開いているかは `settings-nav.ts` の reducer が持つ(一覧と専用は同時に開かない)。
 * 設定画面は不透明(ADR-0005。`Dialog`自体が不透明)。
 */
export function SettingsModal({ open, onClose, theme, update, viewer }: Props) {
  const [page, dispatch] = useReducer(settingsNavReducer, "list");

  // 設定を開くたびに一覧から始める。描画前に戻す(前回の専用ダイアログが一瞬見えないように)。
  useLayoutEffect(() => {
    if (open) dispatch({ type: "reset" });
  }, [open]);

  // M4-6追記: ブラウザの保存領域を開いたときにOPFSの使用量を取り直す。
  const { refreshOpfsStorageInfo } = viewer;
  useEffect(() => {
    if (open && page === "storage" && viewer.isBrowser) void refreshOpfsStorageInfo();
  }, [open, page, viewer.isBrowser, refreshOpfsStorageInfo]);

  const back = () => dispatch({ type: "back" });
  const pageProps = (id: SettingsPageId) => ({ open: open && page === id, onBack: back, onClose });
  const pages = visibleSettingsPages({ isBrowser: viewer.isBrowser, supportsCustomTempDir: viewer.supportsCustomTempDir });

  return (
    <>
      <Dialog
        open={open && page === "list"}
        title="設定"
        onClose={onClose}
        accent="primary"
        widthClass="max-w-xl"
        footer={
          <button type="button" onClick={onClose} aria-label="設定を閉じる" className={`${DIALOG_TERTIARY_BUTTON_CLASS} flex items-center gap-1`}>
            <X size={16} aria-hidden="true" />
            閉じる
          </button>
        }
      >
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
          {pages.map((id) => {
            const { icon: Icon, label } = PAGE_BUTTONS[id];
            return (
              <button
                key={id}
                type="button"
                data-testid={`settings-${id}`}
                onClick={() => dispatch({ type: "open", page: id })}
                className={`${TOOLBAR_BUTTON_CLASS} min-h-16`}
              >
                <Icon size={20} aria-hidden="true" />
                <span>{label}</span>
              </button>
            );
          })}
        </div>
      </Dialog>

      <ThemeDialog {...pageProps("theme")} theme={theme} />
      <AnimationDialog {...pageProps("animation")} viewer={viewer} />
      <BackgroundDialog {...pageProps("background")} viewer={viewer} />
      <PointBudgetDialog {...pageProps("pointBudget")} viewer={viewer} />
      <RenderScaleDialog {...pageProps("renderScale")} viewer={viewer} />
      <UpdateDialog {...pageProps("update")} update={update} />
      {pages.includes("tempDir") && <TempDirDialog {...pageProps("tempDir")} viewer={viewer} />}
      {pages.includes("storage") && <StorageDialog {...pageProps("storage")} viewer={viewer} />}
      <LoadPriorityDialog {...pageProps("loadPriority")} viewer={viewer} />
      <EdlDialog {...pageProps("edl")} viewer={viewer} />
      <UnitDialog {...pageProps("unit")} />
    </>
  );
}
