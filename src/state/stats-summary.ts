// One-line text of the renderer stats, sent to the backend console (stdout of `npm run tauri dev`, logcat on Android).
// It lets the numbers be followed without looking at the GUI (M1-4). Pure; tested in stats-summary.test.ts.
// Used by: useRendererLifecycle.ts.
import type { RenderStats } from "../renderer/point-cloud-renderer";

const fmt3 = (v: readonly [number, number, number]) => `[${v.map((x) => x.toFixed(2)).join(",")}]`;

export function formatStatsSummary(s: RenderStats): string {
  return (
    `[M1] drawnPoints=${s.drawnPoints} drawnNodes=${s.drawnNodes} ` +
    `loadingNodes=${s.loadingNodes} queuedNodes=${s.queuedNodes} ` +
    `cachedNodes=${s.cachedNodes} fps=${s.fps.toFixed(1)} pointBudget=${s.pointBudget} ` +
    // ADR-0009: whether the auto adjustment is running.
    `autoPointBudget=${s.autoPointBudgetEnabled} ` +
    // M2-0c: to compare fps with and without sky / grid.
    `backgroundMode=${s.backgroundMode} gridEnabled=${s.gridEnabled} ` +
    // M2-1: to check that the EDL switch reaches the renderer without looking at the shading.
    `edlEnabled=${s.edlEnabled} edlStrength=${s.edlStrength.toFixed(2)} ` +
    // L1-C: coloring is per layer now, so the stats show layer counts.
    `layers=${s.visibleLayerCount}/${s.layerCount} ` +
    // M3-8: current values of the mobile optimizations, to check them on a real device.
    `renderScale=${s.renderScale} pointShape=${s.pointShape} isMobile=${s.isMobile} pointBudgetMax=${s.pointBudgetMax} ` +
    // ADR-0010: center priority values reach the renderer.
    `centerPriorityStrength=${s.centerPriorityStrength.toFixed(2)} ` +
    `minCenterPriorityWeight=${s.minCenterPriorityWeight.toFixed(2)} ` +
    // M2-0b: camera orientation, so that "pitch=0 is horizontal" can be checked from text.
    `pitch=${s.cameraPitch.toFixed(3)} yaw=${s.cameraYaw.toFixed(3)} ` +
    `upAxis=${fmt3(s.cameraUpAxis)} eye=${fmt3(s.cameraEye)}`
  );
}
