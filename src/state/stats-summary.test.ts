import { describe, expect, it } from "vitest";
import type { RenderStats } from "../renderer/point-cloud-renderer";
import { formatStatsSummary } from "./stats-summary";

// Only the fields the summary reads are filled in; the rest of RenderStats is not needed here.
const stats = {
  drawnPoints: 1000,
  drawnNodes: 5,
  loadingNodes: 1,
  queuedNodes: 2,
  cachedNodes: 3,
  fps: 59.96,
  pointBudget: 2_000_000,
  autoPointBudgetEnabled: true,
  backgroundMode: "sky",
  gridEnabled: false,
  cameraPitch: 0.12345,
  cameraYaw: -1,
  cameraUpAxis: [0, 0, 1],
  cameraEye: [1.234, 2, 3],
  edlEnabled: true,
  edlStrength: 0.4,
  layerCount: 2,
  visibleLayerCount: 1,
  renderScale: 1,
  pointShape: "circle",
  isMobile: false,
  pointBudgetMax: 8_000_000,
  centerPriorityStrength: 0.5,
  minCenterPriorityWeight: 0.2,
} as unknown as RenderStats;

describe("formatStatsSummary", () => {
  it("starts with the [M1] tag and prints counts as they are", () => {
    const text = formatStatsSummary(stats);
    expect(text.startsWith("[M1] drawnPoints=1000 drawnNodes=5 ")).toBe(true);
    expect(text).toContain("layers=1/2");
  });
  it("rounds fps, camera angles and vectors", () => {
    const text = formatStatsSummary(stats);
    expect(text).toContain("fps=60.0");
    expect(text).toContain("pitch=0.123 yaw=-1.000");
    expect(text).toContain("eye=[1.23,2.00,3.00]");
  });
});
