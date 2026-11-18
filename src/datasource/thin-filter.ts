export type GridKeep = "nearestCentre" | "lowest" | "highest";

export type ThinRequest =
  | { kind: "grid"; size: number; keep: GridKeep }
  | { kind: "voxel"; size: number };

export type FilterRequest =
  | { kind: "ror"; radius: number; minNeighbors: number }
  | { kind: "sor"; k: number; nSigma: number; searchRadius: number };
