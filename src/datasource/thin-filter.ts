// G3: the requests of the thinning and outlier-filter tools. Same shape on desktop (tauri.ts) and Web (web.ts).
// All lengths are in the FILE's unit (the screen converts from the display unit; see src/app/thin-filter.ts).
// The matching Rust types are `ThinRequest` and `FilterRequest` in `crates/pcv-core/src/thin_filter_job.rs`.

/** Which point of a grid cell is kept. */
export type GridKeep = "nearestCentre" | "lowest" | "highest";

/** Thinning: one ORIGINAL point per cell (grid, in XY) or per cube (voxel, in 3D). */
export type ThinRequest =
  | { kind: "grid"; size: number; keep: GridKeep }
  | { kind: "voxel"; size: number };

/**
 * Outlier filters.
 * - ROR keeps a point with at least `minNeighbors` other points within `radius`.
 * - SOR keeps a point whose mean distance to its `k` nearest neighbours (searched within `searchRadius`) is at most
 *   mean + `nSigma` * std of all points.
 */
export type FilterRequest =
  | { kind: "ror"; radius: number; minNeighbors: number }
  | { kind: "sor"; k: number; nSigma: number; searchRadius: number };
