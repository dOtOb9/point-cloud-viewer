use std::time::Duration;

use copc_writer::PostProcessStageTimings;
use serde::Serialize;

use crate::opfs::{OpfsReadStats, OpfsSeqReadStats};

#[derive(Serialize)]
pub struct CloudInfoDto {
    pub point_count: u64,
    pub min: [f64; 3],
    pub max: [f64; 3],
    pub scale: [f64; 3],
    pub offset: [f64; 3],
    pub has_color: bool,
    pub crs: CrsInfoDto,
}

#[derive(Serialize)]
pub struct CrsInfoDto {
    pub epsg: Option<u32>,
    pub name: String,
    pub kind: &'static str,
    pub error: Option<String>,
    pub horizontal_unit_to_meter: Option<f64>,
    pub vertical_unit_to_meter: Option<f64>,
}

impl From<&pcv_core::crs::CrsInfo> for CrsInfoDto {
    fn from(crs: &pcv_core::crs::CrsInfo) -> Self {
        Self {
            epsg: crs.epsg,
            name: crs.name.clone(),
            kind: crs.kind.as_str(),
            error: crs.error.clone(),
            horizontal_unit_to_meter: crs.horizontal_unit_to_meter,
            vertical_unit_to_meter: crs.vertical_unit_to_meter,
        }
    }
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
            crs: CrsInfoDto::from(&info.crs),
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

#[derive(Serialize)]
pub struct HeaderSummaryDto {
    pub declared_points: f64,
    pub layout_key: String,
    pub crs_label: String,
    pub file_size_bytes: f64,
}

#[derive(Serialize)]
pub struct FeedResultDto {
    pub points_read: u64,
    pub total_points: u64,
    pub done: bool,
}

#[derive(Serialize)]
pub struct FinishResultDto {
    pub point_count: u64,
    pub stage_timings: ConversionStageBreakdownDto,
    pub warnings: Vec<String>,
}

#[derive(Serialize)]
pub struct ConversionStageBreakdownDto {
    pub source_read_and_decode_secs: f64,
    pub spill_write_secs: f64,
    pub lod_index_build_secs: f64,
    pub node_compression_secs: f64,
    pub header_and_hierarchy_write_secs: f64,
    pub total_secs: f64,
    pub opfs_io_secs: Option<f64>,
    pub opfs_read_at_calls: Option<u64>,
    pub opfs_cache_hits: Option<u64>,
    pub opfs_cache_misses: Option<u64>,
    pub opfs_bytes_read_from_opfs: Option<u64>,
    pub opfs_read_secs: Option<f64>,
    pub opfs_seq_read_calls: Option<u64>,
    pub opfs_seq_read_secs: Option<f64>,
    pub point_count: u64,
    pub file_size_bytes: u64,
    pub input_file_count: u64,
}

impl ConversionStageBreakdownDto {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        source_read_and_decode: Duration,
        spill_write: Duration,
        post: PostProcessStageTimings,
        point_count: u64,
        file_size_bytes: u64,
        opfs_io: Option<Duration>,
        opfs_read_stats: Option<OpfsReadStats>,
        opfs_seq_read_stats: Option<OpfsSeqReadStats>,
        input_file_count: u64,
    ) -> Self {
        let total = source_read_and_decode
            + spill_write
            + post.lod_index_build
            + post.node_compression
            + post.header_and_hierarchy_write;
        Self {
            source_read_and_decode_secs: source_read_and_decode.as_secs_f64(),
            spill_write_secs: spill_write.as_secs_f64(),
            lod_index_build_secs: post.lod_index_build.as_secs_f64(),
            node_compression_secs: post.node_compression.as_secs_f64(),
            header_and_hierarchy_write_secs: post.header_and_hierarchy_write.as_secs_f64(),
            total_secs: total.as_secs_f64(),
            opfs_io_secs: opfs_io.map(|d| d.as_secs_f64()),
            opfs_read_at_calls: opfs_read_stats.map(|s| s.read_at_calls),
            opfs_cache_hits: opfs_read_stats.map(|s| s.cache_hits),
            opfs_cache_misses: opfs_read_stats.map(|s| s.cache_misses),
            opfs_bytes_read_from_opfs: opfs_read_stats.map(|s| s.bytes_read_from_opfs),
            opfs_read_secs: opfs_read_stats.map(|s| s.read_time.as_secs_f64()),
            opfs_seq_read_calls: opfs_seq_read_stats.map(|s| s.seq_read_calls),
            opfs_seq_read_secs: opfs_seq_read_stats.map(|s| s.seq_read_time.as_secs_f64()),
            point_count,
            file_size_bytes,
            input_file_count,
        }
    }
}
