import type { CloudInfo, CrsInfo, HierarchyNodeInfo } from "./DataSource";

export interface CrsInfoDto {
  epsg?: number | null;
  name: string;
  kind: CrsInfo["kind"];
  error?: string | null;
  horizontal_unit_to_meter?: number | null;
  vertical_unit_to_meter?: number | null;
}

export interface CloudInfoDto {
  point_count: number;
  min: [number, number, number];
  max: [number, number, number];
  scale: [number, number, number];
  offset: [number, number, number];
  has_color: boolean;
  crs: CrsInfoDto;
}

export interface HierarchyNodeDto {
  key: string;
  point_count: number;
  bounds_min: [number, number, number];
  bounds_max: [number, number, number];
}

export function toCrsInfo(dto: CrsInfoDto): CrsInfo {
  const crs: CrsInfo = { name: dto.name, kind: dto.kind };
  if (dto.epsg !== null && dto.epsg !== undefined) crs.epsg = dto.epsg;
  if (dto.error !== null && dto.error !== undefined) crs.error = dto.error;
  if (dto.horizontal_unit_to_meter !== null && dto.horizontal_unit_to_meter !== undefined) crs.horizontalUnitToMeter = dto.horizontal_unit_to_meter;
  if (dto.vertical_unit_to_meter !== null && dto.vertical_unit_to_meter !== undefined) crs.verticalUnitToMeter = dto.vertical_unit_to_meter;
  return crs;
}

export function toCloudInfo(dto: CloudInfoDto): CloudInfo {
  return {
    pointCount: dto.point_count,
    min: dto.min,
    max: dto.max,
    scale: dto.scale,
    offset: dto.offset,
    hasColor: dto.has_color,
    crs: toCrsInfo(dto.crs),
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
