import type { CSSProperties } from "react";
import type { CopcViewerState } from "../../state/useCopcViewer";
import { useNarrowViewport } from "../../state/useNarrowViewport";
import { glassSurfaceClass } from "../common/glass";
import { LayerActions } from "./LayerActions";
import { LayerInfoSection } from "./LayerInfoSection";
import { LayerList } from "./LayerList";
import { LayerStatsDetails } from "./LayerStatsDetails";
import { useTransitionMount } from "../common/useTransitionMount";

const PANEL_EXIT_MS = 220;

interface Props {
  viewer: CopcViewerState;
  open: boolean;
  onToggleOpen: () => void;
  glassEnabled: boolean;
}

export function LayerPanel({ viewer, open, onToggleOpen, glassEnabled }: Props) {
  const narrow = useNarrowViewport();
  const tree = (
    <div className="flex flex-col gap-1">
      <h3 className="border-l-[3px] border-tertiary pl-2 text-xs font-semibold uppercase tracking-wide opacity-70">レイヤー</h3>
      <LayerList viewer={viewer} />
    </div>
  );

  const { mounted, shown } = useTransitionMount(open, PANEL_EXIT_MS);
  const slide: CSSProperties = {
    transitionProperty: "transform, opacity",
    transitionDuration: "var(--motion-panel)",
    transitionTimingFunction: shown ? "var(--motion-ease-out)" : "var(--motion-ease-in)",
  };
  const panelBody = (
    <section
      style={{ ...slide, transform: shown ? "translateX(0)" : "translateX(-110%)", opacity: shown ? 1 : 0 }}
      className={`pointer-events-auto flex w-72 max-w-[38vw] flex-col gap-4 overflow-y-auto rounded-2xl p-4 text-sm shadow-lg ${glassSurfaceClass(glassEnabled)} ${narrow ? "!w-full !max-w-none !rounded-none" : ""}`}
    >
      {tree}
      <div className="flex flex-col gap-1">
        <h3 className="border-l-[3px] border-tertiary pl-2 text-xs font-semibold uppercase tracking-wide opacity-70">レイヤー情報</h3>
        <LayerInfoSection viewer={viewer} />
      </div>
      <LayerActions viewer={viewer} />
      <LayerStatsDetails viewer={viewer} />
    </section>
  );

  if (narrow) {
    return (
      <>
        {mounted && (
          <button
            type="button"
            aria-label="レイヤーパネルを閉じる"
            onClick={onToggleOpen}
            style={{ ...slide, transitionProperty: "opacity", opacity: shown ? 1 : 0 }}
            className={`fixed inset-0 z-10 bg-black/30 ${shown ? "" : "pointer-events-none"}`}
          />
        )}
        <div className="pointer-events-none fixed bottom-11 left-0 top-[4.5rem] z-10 flex max-w-[88vw] items-stretch">
          {mounted && panelBody}
        </div>
        <button
          type="button"
          onClick={onToggleOpen}
          aria-label={open ? "レイヤーパネルを畳む" : "レイヤーパネルを開く"}
          title={open ? "レイヤーパネルを畳む" : "レイヤーパネルを開く"}
          className={`pointer-events-auto fixed bottom-16 left-3 z-10 flex h-11 w-11 items-center justify-center rounded-full text-xs shadow-lg ${glassSurfaceClass(glassEnabled)}`}
        >
          {open ? "◀" : "▶"}
        </button>
      </>
    );
  }

  return (
    <div className="pointer-events-none absolute bottom-14 left-3 top-28 z-10">
      {mounted && <div className="absolute left-0 top-0 flex max-h-full">{panelBody}</div>}

      <button
        type="button"
        onClick={onToggleOpen}
        aria-label={open ? "レイヤーパネルを畳む" : "レイヤーパネルを開く"}
        title={open ? "レイヤーパネルを畳む" : "レイヤーパネルを開く"}
        style={{ ...slide, transitionProperty: "transform", transform: shown ? "translateX(18.5rem)" : "translateX(0)" }}
        className={`pointer-events-auto absolute left-0 top-0 rounded-full px-2 py-2 text-xs shadow-lg ${glassSurfaceClass(glassEnabled)}`}
      >
        {open ? "◀" : "▶"}
      </button>
    </div>
  );
}
