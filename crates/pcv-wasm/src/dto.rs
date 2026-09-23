//! `pcv_core`の型をJS側に渡すためのserde構造体。
//!
//! フィールド名はわざと`src-tauri`の`open_copc`が返すJSON(serdeのデフォルト
//! snake_case)と揃えてある。こうすると、TypeScript側で`TauriSource`と
//! `WebSource`が同じDTO変換関数(`src/datasource/copc-dto.ts`)を共有でき、
//! 変換ロジックの二重管理を避けられる。

use serde::Serialize;

#[derive(Serialize)]
pub struct CloudInfoDto {
    pub point_count: u64,
    pub min: [f64; 3],
    pub max: [f64; 3],
    pub scale: [f64; 3],
    pub offset: [f64; 3],
    pub has_color: bool,
}

impl From<&pcv_core::CloudInfo> for CloudInfoDto {
    fn from(info: &pcv_core::CloudInfo) -> Self {
        Self {
            point_count: info.point_count,
            min: info.min,
            max: info.max,
            scale: info.scale,
            offset: info.offset,
            has_color: info.has_color,
        }
    }
}

#[derive(Serialize)]
pub struct HierarchyNodeDto {
    pub key: String,
    pub point_count: u32,
    pub bounds_min: [f64; 3],
    pub bounds_max: [f64; 3],
}

impl From<&pcv_core::HierarchyNode> for HierarchyNodeDto {
    fn from(node: &pcv_core::HierarchyNode) -> Self {
        Self {
            key: node.key.to_string(),
            point_count: node.point_count,
            bounds_min: node.bounds_min,
            bounds_max: node.bounds_max,
        }
    }
}
