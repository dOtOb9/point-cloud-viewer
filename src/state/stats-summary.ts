import type { RenderStats } from "../renderer/point-cloud-renderer";

const fmt3 = (v: readonly [number, number, number]) => `[${v.map((x) => x.toFixed(2)).join(",")}]`;

export function formatStatsSummary(s: RenderStats): string {
  return (
    `[M1] drawnPoints=${s.drawnPoints} drawnNodes=${s.drawnNodes} ` +
    `loadingNodes=${s.loadingNodes} queuedNodes=${s.queuedNodes} ` +
    `cachedNodes=${s.cachedNodes} fps=${s.fps.toFixed(1)} pointBudget=${s.pointBudget} ` +
    `autoPointBudget=${s.autoPointBudgetEnabled} ` +
    `backgroundMode=${s.backgroundMode} gridEnabled=${s.gridEnabled} ` +
    `edlEnabled=${s.edlEnabled} edlStrength=${s.edlStrength.toFixed(2)} ` +
    `layers=${s.visibleLayerCount}/${s.layerCount} ` +
    `renderScale=${s.renderScale} pointShape=${s.pointShape} isMobile=${s.isMobile} pointBudgetMax=${s.pointBudgetMax} ` +
    `centerPriorityStrength=${s.centerPriorityStrength.toFixed(2)} ` +
    `minCenterPriorityWeight=${s.minCenterPriorityWeight.toFixed(2)} ` +
    `pitch=${s.cameraPitch.toFixed(3)} yaw=${s.cameraYaw.toFixed(3)} ` +
    `upAxis=${fmt3(s.cameraUpAxis)} eye=${fmt3(s.cameraEye)}`
  );
}
