use std::collections::BTreeMap;
use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::Path;
use std::str::FromStr;

use copc_core::{CopcInfo, VoxelKey};
use copc_reader::CopcReader;

use crate::color_depth::{self, ColorBitDepth};
use crate::crs::{read_crs_info, CrsInfo};
use crate::node_format::{encode_node, NodeBuffer, NodePoint};

#[derive(Debug, thiserror::Error)]
pub enum CopcError {
    #[error("COPCファイルを開けなかった: {0}")]
    Open(#[source] copc_core::Error),
    #[error("ノードキー {0} はこのファイルのhierarchyに存在しない")]
    UnknownNode(NodeKey),
    #[error("ノード {key} の点を読めなかった: {source}")]
    ReadNode {
        key: NodeKey,
        #[source]
        source: copc_core::Error,
    },
}

pub type Result<T> = std::result::Result<T, CopcError>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct NodeKey {
    pub level: i32,
    pub x: i32,
    pub y: i32,
    pub z: i32,
}

impl NodeKey {
    pub const fn root() -> Self {
        Self {
            level: 0,
            x: 0,
            y: 0,
            z: 0,
        }
    }
}

impl std::fmt::Display for NodeKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}-{}-{}-{}", self.level, self.x, self.y, self.z)
    }
}

impl FromStr for NodeKey {
    type Err = String;

    fn from_str(s: &str) -> std::result::Result<Self, Self::Err> {
        let mut parts = s.split('-');
        let mut next_i32 = |name: &str| -> std::result::Result<i32, String> {
            parts
                .next()
                .ok_or_else(|| format!("ノードキー '{s}' に '{name}' がない"))?
                .parse::<i32>()
                .map_err(|e| format!("ノードキー '{s}' の '{name}' が不正: {e}"))
        };
        let level = next_i32("level")?;
        let x = next_i32("x")?;
        let y = next_i32("y")?;
        let z = next_i32("z")?;
        if parts.next().is_some() {
            return Err(format!("ノードキー '{s}' に余分なセグメントがある"));
        }
        Ok(NodeKey { level, x, y, z })
    }
}

impl From<VoxelKey> for NodeKey {
    fn from(k: VoxelKey) -> Self {
        NodeKey {
            level: k.level,
            x: k.x,
            y: k.y,
            z: k.z,
        }
    }
}

impl From<NodeKey> for VoxelKey {
    fn from(k: NodeKey) -> Self {
        VoxelKey {
            level: k.level,
            x: k.x,
            y: k.y,
            z: k.z,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct CloudInfo {
    pub point_count: u64,
    pub min: [f64; 3],
    pub max: [f64; 3],
    pub scale: [f64; 3],
    pub offset: [f64; 3],
    pub has_color: bool,
    pub crs: CrsInfo,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct HierarchyNode {
    pub key: NodeKey,
    pub point_count: u32,
    pub bounds_min: [f64; 3],
    pub bounds_max: [f64; 3],
}

#[derive(Debug, Clone, Default)]
pub struct Hierarchy {
    nodes: BTreeMap<NodeKey, HierarchyNode>,
}

impl Hierarchy {
    pub fn len(&self) -> usize {
        self.nodes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty()
    }

    pub fn nodes(&self) -> impl Iterator<Item = &HierarchyNode> {
        self.nodes.values()
    }

    pub fn get(&self, key: NodeKey) -> Option<&HierarchyNode> {
        self.nodes.get(&key)
    }
}

pub struct CopcFile<R: Read + Seek + Send = BufReader<File>> {
    reader: CopcReader<R>,
    info: CloudInfo,
    hierarchy: Hierarchy,
    color_bit_depth: Option<ColorBitDepth>,
}

impl CopcFile<BufReader<File>> {
    pub fn open(path: &Path) -> Result<Self> {
        let crs = match File::open(path) {
            Ok(f) => read_crs_info(&mut BufReader::new(f)),
            Err(e) => CrsInfo::failed(format!("CRS用にファイルを開けなかった: {e}")),
        };
        let mut reader = CopcReader::from_path(path).map_err(CopcError::Open)?;
        let info = build_cloud_info(&reader, crs);
        let hierarchy = build_hierarchy(&reader);
        let color_bit_depth = detect_color_bit_depth(&mut reader, &hierarchy, info.has_color)?;
        Ok(Self {
            reader,
            info,
            hierarchy,
            color_bit_depth,
        })
    }
}

impl<R: Read + Seek + Send> CopcFile<R> {
    pub fn from_reader(mut reader: R) -> Result<Self> {
        let crs = read_crs_info(&mut reader);
        reader
            .seek(SeekFrom::Start(0))
            .map_err(|e| CopcError::Open(copc_core::Error::io("seek to start", e)))?;
        let mut reader = CopcReader::open(reader).map_err(CopcError::Open)?;
        let info = build_cloud_info(&reader, crs);
        let hierarchy = build_hierarchy(&reader);
        let color_bit_depth = detect_color_bit_depth(&mut reader, &hierarchy, info.has_color)?;
        Ok(Self {
            reader,
            info,
            hierarchy,
            color_bit_depth,
        })
    }

    pub fn info(&self) -> &CloudInfo {
        &self.info
    }

    pub fn hierarchy(&self) -> &Hierarchy {
        &self.hierarchy
    }

    pub fn read_node(&mut self, key: NodeKey) -> Result<NodeBuffer> {
        let node = *self.hierarchy.get(key).ok_or(CopcError::UnknownNode(key))?;
        let node_points = self.read_node_points(key)?;
        Ok(encode_node(
            &node_points,
            node.bounds_min,
            self.info.has_color,
        ))
    }

    pub fn read_node_points(&mut self, key: NodeKey) -> Result<Vec<NodePoint>> {
        let node = *self.hierarchy.get(key).ok_or(CopcError::UnknownNode(key))?;
        let has_color = self.info.has_color;
        let target_key = VoxelKey::from(key);

        let points = self
            .reader
            .read_node(target_key)
            .map_err(|source| CopcError::ReadNode { key, source })?;

        let depth = self.color_bit_depth.unwrap_or(LAS_SPEC_COLOR_DEPTH);

        let mut node_points = Vec::with_capacity(node.point_count as usize);
        for point in points {
            let color = if has_color {
                point.color.map(|c| {
                    [
                        depth.to_u8(c.red),
                        depth.to_u8(c.green),
                        depth.to_u8(c.blue),
                        255,
                    ]
                })
            } else {
                None
            };
            node_points.push(NodePoint {
                x: point.x,
                y: point.y,
                z: point.z,
                color,
                intensity: point.intensity,
                classification: u8::from(point.classification),
            });
        }

        Ok(node_points)
    }
}

fn build_cloud_info<R>(reader: &CopcReader<R>, crs: CrsInfo) -> CloudInfo
where
    R: std::io::Read + std::io::Seek + Send,
{
    let header = reader.header();
    let point_format_id = header.point_data_record_format & 0x3F;
    CloudInfo {
        point_count: header.number_of_points(),
        min: [header.min_x, header.min_y, header.min_z],
        max: [header.max_x, header.max_y, header.max_z],
        scale: [
            header.x_scale_factor,
            header.y_scale_factor,
            header.z_scale_factor,
        ],
        offset: [header.x_offset, header.y_offset, header.z_offset],
        has_color: matches!(point_format_id, 7 | 8),
        crs,
    }
}

fn build_hierarchy<R>(reader: &CopcReader<R>) -> Hierarchy
where
    R: std::io::Read + std::io::Seek + Send,
{
    let info = reader.copc_info();
    let mut nodes = BTreeMap::new();
    for entry in reader.file().hierarchy_entries() {
        if !entry.has_point_data() {
            continue;
        }
        let key = NodeKey::from(entry.key);
        let (bounds_min, bounds_max) = voxel_bounds(entry.key, info);
        nodes.insert(
            key,
            HierarchyNode {
                key,
                point_count: entry.point_count as u32,
                bounds_min,
                bounds_max,
            },
        );
    }
    Hierarchy { nodes }
}

const LAS_SPEC_COLOR_DEPTH: ColorBitDepth = ColorBitDepth::Sixteen;

fn detect_color_bit_depth<R>(
    reader: &mut CopcReader<R>,
    hierarchy: &Hierarchy,
    has_color: bool,
) -> Result<Option<ColorBitDepth>>
where
    R: Read + Seek + Send,
{
    if !has_color {
        return Ok(None);
    }
    let Some(node) = hierarchy
        .get(NodeKey::root())
        .or_else(|| hierarchy.nodes().next())
    else {
        return Ok(Some(LAS_SPEC_COLOR_DEPTH));
    };
    let key = node.key;
    let target_key = VoxelKey::from(key);
    let points = reader
        .read_node(target_key)
        .map_err(|source| CopcError::ReadNode { key, source })?;
    let colors = points
        .into_iter()
        .filter_map(|p| p.color)
        .map(|c| (c.red, c.green, c.blue));
    Ok(Some(color_depth::detect(colors)))
}

pub(crate) fn voxel_bounds(key: VoxelKey, info: &CopcInfo) -> ([f64; 3], [f64; 3]) {
    let side = (info.halfsize * 2.0) / 2f64.powi(key.level);
    let root_min = [
        info.center.0 - info.halfsize,
        info.center.1 - info.halfsize,
        info.center.2 - info.halfsize,
    ];
    let min = [
        root_min[0] + f64::from(key.x) * side,
        root_min[1] + f64::from(key.y) * side,
        root_min[2] + f64::from(key.z) * side,
    ];
    let max = [min[0] + side, min[1] + side, min[2] + side];
    (min, max)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_key_display_and_parse_round_trip() {
        let key = NodeKey {
            level: 2,
            x: 1,
            y: 3,
            z: 0,
        };
        let s = key.to_string();
        assert_eq!(s, "2-1-3-0");
        assert_eq!(NodeKey::from_str(&s).unwrap(), key);
    }

    #[test]
    fn node_key_parse_rejects_wrong_segment_count() {
        assert!(NodeKey::from_str("0-0-0").is_err());
        assert!(NodeKey::from_str("0-0-0-0-0").is_err());
        assert!(NodeKey::from_str("not-a-key-here").is_err());
    }
}

#[cfg(test)]
mod copc_file_tests {
    use super::*;
    use copc_writer::{
        write_source, CopcPointFields, CopcPointSource, CopcWriteMetadata, CopcWriterParams,
    };

    struct SyntheticSource {
        points: Vec<CopcPointFields>,
    }

    impl CopcPointSource for SyntheticSource {
        fn len(&self) -> usize {
            self.points.len()
        }

        fn xyz(&self, index: usize) -> copc_core::Result<(f64, f64, f64)> {
            let p = &self.points[index];
            Ok((p.x, p.y, p.z))
        }

        fn fields_into(&self, index: usize, out: &mut CopcPointFields) -> copc_core::Result<()> {
            out.clone_from(&self.points[index]);
            Ok(())
        }
    }

    fn synthetic_copc_file() -> (tempfile::TempDir, std::path::PathBuf, usize) {
        let mut points = Vec::new();
        let point_total = 2_000;
        for i in 0..point_total {
            let t = i as f64 / point_total as f64 * std::f64::consts::TAU;
            points.push(CopcPointFields {
                x: 500_000.0 + 50.0 * t.cos(),
                y: 4_000_000.0 + 50.0 * t.sin(),
                z: 10.0 + i as f64 * 0.001,
                intensity: (i % 65_536) as u16,
                return_number: 1,
                number_of_returns: 1,
                synthetic: 0,
                key_point: 0,
                withheld: 0,
                overlap: 0,
                scan_channel: 0,
                scan_direction_flag: 0,
                edge_of_flight_line: 0,
                classification: 2,
                user_data: 0,
                scan_angle: 0.0,
                point_source_id: 1,
                gps_time: 1.0e9 + i as f64,
                red: 0,
                green: 0,
                blue: 0,
                extra_bytes: Vec::new(),
            });
        }

        let bounds = points.iter().fold(
            copc_core::Bounds::point(points[0].x, points[0].y, points[0].z),
            |mut bounds, p| {
                bounds.extend(p.x, p.y, p.z);
                bounds
            },
        );

        let dir = tempfile::tempdir().expect("tempdir作成に失敗");
        let path = dir.path().join("synthetic.copc.laz");
        let source = SyntheticSource { points };
        write_source(
            &path,
            &source,
            false,
            bounds,
            &CopcWriterParams::new(128),
            &CopcWriteMetadata::default(),
        )
        .expect("テスト用COPCの書き出しに失敗");

        (dir, path, point_total)
    }

    fn synthetic_copc_file_with_color(
        red: u16,
        green: u16,
        blue: u16,
    ) -> (tempfile::TempDir, std::path::PathBuf, usize) {
        let mut points = Vec::new();
        let point_total = 500;
        for i in 0..point_total {
            let t = i as f64 / point_total as f64 * std::f64::consts::TAU;
            points.push(CopcPointFields {
                x: 500_000.0 + 50.0 * t.cos(),
                y: 4_000_000.0 + 50.0 * t.sin(),
                z: 10.0 + i as f64 * 0.001,
                intensity: (i % 65_536) as u16,
                return_number: 1,
                number_of_returns: 1,
                synthetic: 0,
                key_point: 0,
                withheld: 0,
                overlap: 0,
                scan_channel: 0,
                scan_direction_flag: 0,
                edge_of_flight_line: 0,
                classification: 2,
                user_data: 0,
                scan_angle: 0.0,
                point_source_id: 1,
                gps_time: 1.0e9 + i as f64,
                red,
                green,
                blue,
                extra_bytes: Vec::new(),
            });
        }

        let bounds = points.iter().fold(
            copc_core::Bounds::point(points[0].x, points[0].y, points[0].z),
            |mut bounds, p| {
                bounds.extend(p.x, p.y, p.z);
                bounds
            },
        );

        let dir = tempfile::tempdir().expect("tempdir作成に失敗");
        let path = dir.path().join("synthetic_color.copc.laz");
        let source = SyntheticSource { points };
        write_source(
            &path,
            &source,
            true,
            bounds,
            &CopcWriterParams::new(128),
            &CopcWriteMetadata::default(),
        )
        .expect("テスト用COPCの書き出しに失敗");

        (dir, path, point_total)
    }

    fn point_color_at(buf: &NodeBuffer, index: usize) -> (u8, u8, u8, u8) {
        let offset = crate::node_format::HEADER_BYTES + index * crate::node_format::POINT_STRIDE;
        (
            buf.bytes[offset + 12],
            buf.bytes[offset + 13],
            buf.bytes[offset + 14],
            buf.bytes[offset + 15],
        )
    }

    #[test]
    fn read_node_does_not_turn_8bit_color_into_black() {
        let (_dir, path, _point_total) = synthetic_copc_file_with_color(10, 20, 30);
        let mut file = CopcFile::open(&path).unwrap();

        let key = file
            .hierarchy()
            .get(NodeKey::root())
            .map(|n| n.key)
            .unwrap_or(NodeKey::root());
        let buf = file.read_node(key).unwrap();
        assert!(buf.point_count > 0);

        let (r, g, b, a) = point_color_at(&buf, 0);
        assert_eq!(
            (r, g, b, a),
            (10, 20, 30, 255),
            "8bit色がそのまま通らず黒(0,0,0)になっている(真っ黒バグの再発)"
        );
    }

    #[test]
    fn read_node_still_shifts_genuine_16bit_color_down_to_8bit() {
        let (_dir, path, _point_total) = synthetic_copc_file_with_color(2048, 8704, 63744);
        let mut file = CopcFile::open(&path).unwrap();

        let key = file
            .hierarchy()
            .get(NodeKey::root())
            .map(|n| n.key)
            .unwrap_or(NodeKey::root());
        let buf = file.read_node(key).unwrap();

        let (r, g, b, _a) = point_color_at(&buf, 0);
        assert_eq!(
            (r, g, b),
            (
                (2048u16 >> 8) as u8,
                (8704u16 >> 8) as u8,
                (63744u16 >> 8) as u8
            ),
            "16bitの色は引き続き上位バイトへ落とされるべき"
        );
    }

    #[test]
    fn open_reports_total_point_count_and_bbox() {
        let (_dir, path, point_total) = synthetic_copc_file();
        let file = CopcFile::open(&path).unwrap();

        assert_eq!(file.info().point_count, point_total as u64);
        assert!(file.info().min[0] < file.info().max[0]);
        assert!(file.info().min[1] < file.info().max[1]);
        assert!(!file.hierarchy().is_empty());
    }

    #[test]
    fn open_reports_no_crs_when_file_has_none() {
        let (_dir, path, _point_total) = synthetic_copc_file();
        let file = CopcFile::open(&path).unwrap();
        assert_eq!(file.info().crs, CrsInfo::none());
    }

    #[test]
    fn open_reports_crs_of_real_merged_copc() {
        let path = Path::new("C:/rust/point-cloud-viewer/data/tokyo-shibuya-merged.copc.laz");
        if !path.exists() {
            eprintln!("skip: {path:?} が無い");
            return;
        }
        let file = CopcFile::open(path).unwrap();
        let crs = &file.info().crs;
        assert_eq!(crs.epsg, Some(6677), "{crs:?}");
        assert_eq!(crs.kind, crate::crs::CrsKind::PlaneRectangular);
        assert_eq!(crs.error, None);
    }

    #[test]
    fn read_node_point_count_matches_hierarchy() {
        let (_dir, path, _point_total) = synthetic_copc_file();
        let mut file = CopcFile::open(&path).unwrap();

        let mut total_read = 0u64;
        let node_keys: Vec<NodeKey> = file.hierarchy().nodes().map(|n| n.key).collect();
        assert!(!node_keys.is_empty(), "少なくとも1ノードは無いとおかしい");

        for key in node_keys {
            let expected = file.hierarchy().get(key).unwrap().point_count;
            let buf = file.read_node(key).unwrap();
            assert_eq!(
                buf.point_count, expected,
                "ノード{key}の点数がhierarchyの申告と不一致"
            );
            assert_eq!(
                buf.bytes.len(),
                crate::node_format::HEADER_BYTES
                    + expected as usize * crate::node_format::POINT_STRIDE
            );
            total_read += u64::from(buf.point_count);
        }

        assert_eq!(total_read, file.info().point_count);
    }

    #[test]
    fn read_node_rejects_unknown_key() {
        let (_dir, path, _point_total) = synthetic_copc_file();
        let mut file = CopcFile::open(&path).unwrap();

        let bogus = NodeKey {
            level: 99,
            x: 0,
            y: 0,
            z: 0,
        };
        let err = file.read_node(bogus).unwrap_err();
        assert!(matches!(err, CopcError::UnknownNode(k) if k == bogus));
    }

    #[test]
    fn root_node_positions_are_small_relative_to_large_world_coordinates() {
        let (_dir, path, _point_total) = synthetic_copc_file();
        let mut file = CopcFile::open(&path).unwrap();
        let root = file.hierarchy().get(NodeKey::root());
        let key = root.map(|n| n.key).unwrap_or(NodeKey::root());
        let buf = file.read_node(key).unwrap();

        let origin_x = f32::from_le_bytes(buf.bytes[16..20].try_into().unwrap());
        const MIN_WORLD_ORIGIN_M: f32 = 1000.0;
        const MAX_RELATIVE_M: f32 = 200.0;
        assert!(origin_x.abs() > MIN_WORLD_ORIGIN_M, "origin_x={origin_x}");

        let mut offset = crate::node_format::HEADER_BYTES;
        let mut checked_any = false;
        while offset + crate::node_format::POINT_STRIDE <= buf.bytes.len() {
            let rel_x = f32::from_le_bytes(buf.bytes[offset..offset + 4].try_into().unwrap());
            let rel_y = f32::from_le_bytes(buf.bytes[offset + 4..offset + 8].try_into().unwrap());
            assert!(
                rel_x.abs() < MAX_RELATIVE_M,
                "rel_x={rel_x} が想定より大きい（相対座標になっていない疑い）"
            );
            assert!(
                rel_y.abs() < MAX_RELATIVE_M,
                "rel_y={rel_y} が想定より大きい（相対座標になっていない疑い）"
            );
            checked_any = true;
            offset += crate::node_format::POINT_STRIDE;
        }
        assert!(checked_any, "少なくとも1点は検査したい");
    }
}
