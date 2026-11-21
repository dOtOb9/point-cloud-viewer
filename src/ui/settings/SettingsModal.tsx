import {
  FolderOpen,
  Gauge,
  Sun,
  Target,
  HardDrive,
  Image,
  Mountain,
  Monitor,
  Palette,
  RefreshCw,
  Ruler,
  Zap,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useLayoutEffect, useReducer } from "react";
import { refreshStorageAndForgetBlockedCleanup } from "../../app/storage-cleanup";
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
import { DtmOutputDialog } from "./pages/DtmOutputDialog";
import { UpdateDialog } from "./pages/UpdateDialog";

interface Props {
  open: boolean;
  onClose: () => void;
  theme: ThemeState;
  update: UpdateCheckState;
  viewer: CopcViewerState;
}

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
  dtmOutput: { icon: Mountain, label: "DTM の出力" },
};

export function SettingsModal({ open, onClose, theme, update, viewer }: Props) {
  const [page, dispatch] = useReducer(settingsNavReducer, "list");

  useLayoutEffect(() => {
    if (open) dispatch({ type: "reset" });
  }, [open]);

  const { storageCleanupContext } = viewer;
  useEffect(() => {
    if (open && page === "storage" && viewer.isBrowser) void refreshStorageAndForgetBlockedCleanup(storageCleanupContext);
  }, [open, page, viewer.isBrowser, storageCleanupContext]);

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
      <DtmOutputDialog {...pageProps("dtmOutput")} />
    </>
  );
}
