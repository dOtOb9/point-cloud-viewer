import type { MeasureToolState } from "../../state/useMeasureTool";
import { MEASURE_KIND_NAME } from "../../state/measure";
import { glassSurfaceClass } from "../common/glass";

/** Guide shown while measuring: what is measured, what to do next, and how to stop. */
export function MeasureHud({ measure, glassEnabled }: { measure: MeasureToolState; glassEnabled: boolean }) {
  if (measure.mode === null) return null;
  const n = measure.points.length;
  const kindName = MEASURE_KIND_NAME[measure.mode];
  let guide: string;
  if (measure.mode === "area") {
    guide = n < 3 ? `頂点をクリック（${n}点）` : `頂点をクリック（${n}点）。ダブルクリックか Enter で閉じる`;
  } else {
    guide = n === 0 ? "1点目をクリック" : "2点目をクリック";
  }
  return (
    <div
      data-testid="measure-hud"
      className={`pointer-events-auto absolute bottom-14 left-1/2 z-20 flex max-w-[calc(100%-1.5rem)] -translate-x-1/2 flex-wrap items-center justify-center gap-2 rounded-xl ${glassSurfaceClass(glassEnabled)} px-3 py-2 text-sm shadow-xl`}
    >
      <span className="font-semibold">{kindName}を計測中</span>
      <span>{measure.notice ?? guide}</span>
      {measure.mode === "area" && (
        <button
          type="button"
          onClick={measure.finish}
          disabled={n < 3}
          className="min-h-9 rounded-md bg-primary px-3 text-on-primary disabled:opacity-40"
        >
          閉じる
        </button>
      )}
      <button
        type="button"
        onClick={measure.stop}
        title="Esc でもやめられます"
        className="min-h-9 rounded-md border border-current/30 px-3 hover:bg-black/5 dark:hover:bg-white/10"
      >
        やめる
      </button>
    </div>
  );
}
