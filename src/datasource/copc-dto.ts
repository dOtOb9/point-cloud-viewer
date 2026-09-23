// Rust側 (`open_copc` / `pcv-wasm`の`info()`/`hierarchy()`) が返すJSONの形と、
// DataSourceのTypeScript側camelCase型を相互変換する。TauriSourceとWebSourceの
// 両方が同じ変換ロジックを使うので、ここに1箇所だけ置く(片方でしか直さない、
// という食い違いを防ぐため)。
//
// フィールド名はRust側のserdeデフォルト(snake_case)のまま受け取る。
// `src-tauri/src/copc_state.rs`の`open_copc`と`crates/pcv-wasm/src/dto.rs`が
// 同じ形のJSONを返すことを前提にしている(片方だけ形を変えたら両方直すこと)。

import type { CloudInfo, HierarchyNodeInfo } from "./DataSource";

export interface CloudInfoDto {
  point_count: number;
  min: [number, number, number];
  max: [number, number, number];
  scale: [number, number, number];
  offset: [number, number, number];
  has_color: boolean;
}

export interface HierarchyNodeDto {
  key: string;
  point_count: number;
  bounds_min: [number, number, number];
  bounds_max: [number, number, number];
}

export function toCloudInfo(dto: CloudInfoDto): CloudInfo {
  return {
    pointCount: dto.point_count,
    min: dto.min,
    max: dto.max,
    scale: dto.scale,
    offset: dto.offset,
    hasColor: dto.has_color,
  };
}

export function toHierarchyNodeInfo(dto: HierarchyNodeDto): HierarchyNodeInfo {
  return {
    key: dto.key,
    pointCount: dto.point_count,
    boundsMin: dto.bounds_min,
    boundsMax: dto.bounds_max,
  };
}
