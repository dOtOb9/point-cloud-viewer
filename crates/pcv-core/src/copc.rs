//! COPCファイルの読込。ADR-0003 で選定した `copc-core` / `copc-reader` を使う。
//!
//! この crate の外向きAPIは M1-point-rendering.md の設計に寄せてある:
//! `CopcFile::open` → `info()` / `hierarchy()` → `read_node(key)`。
//! 中身が copc-reader のどんな型を使っているかは外から見えない（＝クレートを
//! 差し替えてもここだけ直せばよい）。

use std::collections::BTreeMap;
use std::fs::File;
use std::io::BufReader;
use std::path::Path;
use std::str::FromStr;

use copc_core::{CopcInfo, VoxelKey};
use copc_reader::{BoundsSelection, CopcReader, LodSelection};

use crate::node_format::{encode_node, NodeBuffer, NodePoint};

/// pcv-core が返すエラー。`tauri::Error` などには変換しない
/// （pcv-coreはtauriを知らない。呼び出し側で必要なら変換する）。
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

/// octreeのノードキー。COPCの `VoxelKey`（level, x, y, z）と同じ形。
///
/// `pcv://` のURLは1セグメントしか扱えない（M0で判明した`convertFileSrc`の制約。
/// M1-point-rendering.md 参照）ため、`"{level}-{x}-{y}-{z}"` という1セグメントの
/// 文字列に変換できるようにしてある（例: `pcv://0-0-0-0`）。
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

/// `"{level}-{x}-{y}-{z}"` をパースする。COPCの正当なキーは常に非負整数なので、
/// `-` 区切りで単純に分割する（負の座標は仕様上存在しない。VoxelKey::validate参照）。
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

/// 点群全体の情報。総点数・BBOX・scale/offset・属性の有無。
#[derive(Debug, Clone, PartialEq)]
pub struct CloudInfo {
    pub point_count: u64,
    pub min: [f64; 3],
    pub max: [f64; 3],
    pub scale: [f64; 3],
    pub offset: [f64; 3],
    /// LASポイントフォーマット7/8はRGB色を持つ。6は持たない。
    pub has_color: bool,
}

/// octree中の1ノード（点データを持つチャンク）。空ノードや子ページ参照は含まない。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct HierarchyNode {
    pub key: NodeKey,
    pub point_count: u32,
    pub bounds_min: [f64; 3],
    pub bounds_max: [f64; 3],
}

/// octree全体のノード一覧。
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

/// 開いたCOPCファイル。
pub struct CopcFile {
    reader: CopcReader<BufReader<File>>,
    info: CloudInfo,
    hierarchy: Hierarchy,
}

impl CopcFile {
    pub fn open(path: &Path) -> Result<Self> {
        let reader = CopcReader::from_path(path).map_err(CopcError::Open)?;
        let info = build_cloud_info(&reader);
        let hierarchy = build_hierarchy(&reader);
        Ok(Self {
            reader,
            info,
            hierarchy,
        })
    }

    pub fn info(&self) -> &CloudInfo {
        &self.info
    }

    pub fn hierarchy(&self) -> &Hierarchy {
        &self.hierarchy
    }

    /// 指定したノードの点を読み出し、M1-2のバイナリ形式にエンコードして返す。
    /// 返る点数はヒエラルキが申告する `point_count` と一致する。
    pub fn read_node(&mut self, key: NodeKey) -> Result<NodeBuffer> {
        let node = *self.hierarchy.get(key).ok_or(CopcError::UnknownNode(key))?;

        // 同じlevelのvoxelは互いに重ならない立方体で空間を分割している「はず」だが、
        // copc-readerのBounds::intersects/contains_xyzは両端inclusiveなので、
        // 立方体の面がちょうど接している隣のノードまで「交差している」と判定され、
        // 点がその面上にちょうど乗っていると隣のノードの点まで拾ってしまう
        // （実測して確認した。単純に上端をepsilon縮める案は、逆に自分自身の
        // 境界上にある正当な点を取りこぼす。実データはCOPCのcenter/halfsizeが
        // データ範囲ぴったりに作られることが多く、境界上の点は珍しくない）。
        //
        // そこで、bboxによる絞り込みは「候補を広めに取る」ためだけに使い、
        // 各点が本当にこのキーに属するかは copc-writer の octant 分割規則
        // （`point_belongs_to_key`。center以上なら上位octant、という再帰的な
        // 中央分割）を自分で再現して判定する。この規則はwriter側の
        // `child_octant`と同一なので、hierarchyの申告点数と厳密に一致する。
        let bounds = copc_core::Bounds::new(
            (node.bounds_min[0], node.bounds_min[1], node.bounds_min[2]),
            (node.bounds_max[0], node.bounds_max[1], node.bounds_max[2]),
        );
        let has_color = self.info.has_color;
        let copc_info = *self.reader.copc_info();
        let target_key = VoxelKey::from(key);

        let point_iter = self
            .reader
            .points(
                LodSelection::Level(key.level),
                BoundsSelection::Within(bounds),
            )
            .map_err(|source| CopcError::ReadNode { key, source })?;

        let mut node_points = Vec::with_capacity(node.point_count as usize);
        for point in point_iter {
            let point = point.map_err(|source| CopcError::ReadNode { key, source })?;
            if !point_belongs_to_key(&copc_info, target_key, point.x, point.y, point.z) {
                // bbox交差で候補に挙がっただけの、隣接ノードの点。
                continue;
            }
            let color = if has_color {
                point.color.map(|c| {
                    // LASの色は16bit。8bitのRGBAに落とす（上位バイトを取るのが一般的な変換）。
                    [
                        (c.red >> 8) as u8,
                        (c.green >> 8) as u8,
                        (c.blue >> 8) as u8,
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

        Ok(encode_node(&node_points, node.bounds_min, has_color))
    }
}

fn build_cloud_info<R>(reader: &CopcReader<R>) -> CloudInfo
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
        // COPCが要求するLASフォーマットは6/7/8。7と8だけがRGB色を持つ。
        has_color: matches!(point_format_id, 7 | 8),
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
            // 空ノードや「子ページを見よ」を指すだけのエントリはノードとして扱わない。
            continue;
        }
        let key = NodeKey::from(entry.key);
        let (bounds_min, bounds_max) = voxel_bounds(entry.key, info);
        nodes.insert(
            key,
            HierarchyNode {
                key,
                // has_point_data()がtrueならpoint_count > 0が保証されている。
                point_count: entry.point_count as u32,
                bounds_min,
                bounds_max,
            },
        );
    }
    Hierarchy { nodes }
}

/// voxelキーからそのノードのワールド座標BBOXを計算する。
///
/// copc-reader内部にも同じ式（非公開）があるが、Hierarchy構築時に一度だけ
/// 計算してキャッシュしておきたいのでここに複製する。COPC仕様: ルートcubeを
/// `center ± halfsize` とし、levelが1つ深くなるごとに一辺を半分に刻む。
fn voxel_bounds(key: VoxelKey, info: &CopcInfo) -> ([f64; 3], [f64; 3]) {
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

/// 点が本当に `key` のノードに属するかを判定する。
///
/// copc-writer（`lod.rs`の`child_octant`）は、ある立方体を8分割するとき
/// 「各軸の座標が立方体の中心以上なら上位側」という再帰的な中央分割で
/// octantを決めている。ここではルートcubeから`key`が指す深さまで同じ規則を
/// たどり、各段で実際の座標がどちらのoctantに落ちるかを確認する。途中で1段でも
/// 想定と違うoctantに落ちたら、その点は別のノードに属する。
///
/// bboxの交差判定（inclusive）だけで絞り込むと、立方体の面がちょうど接している
/// 隣のノードの点まで混入することがある（read_nodeのコメント参照）。この関数は
/// writerと同じ規則をそのまま再現するので、hierarchyが申告する点数と厳密に一致する。
fn point_belongs_to_key(info: &CopcInfo, key: VoxelKey, x: f64, y: f64, z: f64) -> bool {
    let mut bounds = copc_core::Bounds::cube(info.center, info.halfsize);
    for level in 1..=key.level {
        let shift = key.level - level;
        let want_octant = ((key.x >> shift) & 1) as usize
            | (((key.y >> shift) & 1) as usize) << 1
            | (((key.z >> shift) & 1) as usize) << 2;
        let center = bounds.center();
        let actual_octant = usize::from(x >= center.0)
            | (usize::from(y >= center.1) << 1)
            | (usize::from(z >= center.2) << 2);
        if actual_octant != want_octant {
            return false;
        }
        bounds = bounds.octant(want_octant as u8);
    }
    true
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

    /// テスト専用の点群ソース。`crates/pcv-core/tests` にfixtureを置かず、
    /// その場で極小のCOPCファイルを生成する（M1-point-rendering.md の
    /// 「テストデータの扱い」で推奨されている方法）。
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

    /// 実測データを模して、大きな世界座標（UTM系相当）に点を撒く。
    /// M1-2の「ノードローカル相対座標」が効いているかを別テストで確認するため、
    /// わざとX/Yの絶対値を大きくしてある。
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
        // M1-2の受け入れ条件の根幹: 相対座標にすることで、世界座標が
        // 500000超でもf32の相対値自体は小さい範囲に収まる（ガタつき対策の確認）。
        let (_dir, path, _point_total) = synthetic_copc_file();
        let mut file = CopcFile::open(&path).unwrap();
        let root = file.hierarchy().get(NodeKey::root());
        let key = root.map(|n| n.key).unwrap_or(NodeKey::root());
        let buf = file.read_node(key).unwrap();

        let origin_x = f32::from_le_bytes(buf.bytes[16..20].try_into().unwrap());
        // 原点はワールド座標なので大きい値のはず（500000近辺）。
        assert!(origin_x.abs() > 1000.0, "origin_x={origin_x}");

        let mut offset = crate::node_format::HEADER_BYTES;
        let mut checked_any = false;
        while offset + crate::node_format::POINT_STRIDE <= buf.bytes.len() {
            let rel_x = f32::from_le_bytes(buf.bytes[offset..offset + 4].try_into().unwrap());
            let rel_y = f32::from_le_bytes(buf.bytes[offset + 4..offset + 8].try_into().unwrap());
            // 相対座標は円の半径50m程度に収まっているはず（丸め誤差程度の余裕を見る）。
            assert!(
                rel_x.abs() < 200.0,
                "rel_x={rel_x} が想定より大きい（相対座標になっていない疑い）"
            );
            assert!(
                rel_y.abs() < 200.0,
                "rel_y={rel_y} が想定より大きい（相対座標になっていない疑い）"
            );
            checked_any = true;
            offset += crate::node_format::POINT_STRIDE;
        }
        assert!(checked_any, "少なくとも1点は検査したい");
    }
}
