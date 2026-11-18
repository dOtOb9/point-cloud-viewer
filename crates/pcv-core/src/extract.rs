use std::collections::VecDeque;
use std::io::{Read, Seek};

use copc_core::{CopcInfo, LasPointRecord, VoxelKey};
use copc_reader::CopcReader;

use crate::copc::voxel_bounds;

#[derive(Debug, Clone, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenPolygon {
    pub view_proj: [f64; 16],
    pub polygon_ndc: Vec<[f64; 2]>,
}

#[derive(Debug, Clone, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrientedBox {
    pub center: [f64; 3],
    pub axes: [[f64; 3]; 3],
    pub half_extents: [f64; 3],
}

#[derive(Debug, Clone, PartialEq, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ExtractFilter {
    ScreenPolygon(ScreenPolygon),
    OrientedBox(OrientedBox),
}

impl ExtractFilter {
    pub fn validate(&self) -> Result<(), String> {
        match self {
            ExtractFilter::ScreenPolygon(p) => {
                if p.polygon_ndc.len() < 3 {
                    return Err("多角形の頂点が3つ未満です".to_string());
                }
                if p.view_proj.iter().any(|v| !v.is_finite()) {
                    return Err("ビュー射影行列に有限でない値があります".to_string());
                }
                if p.polygon_ndc
                    .iter()
                    .any(|v| !v[0].is_finite() || !v[1].is_finite())
                {
                    return Err("多角形の頂点に有限でない値があります".to_string());
                }
                Ok(())
            }
            ExtractFilter::OrientedBox(b) => {
                let finite = b.center.iter().all(|v| v.is_finite())
                    && b.axes.iter().flatten().all(|v| v.is_finite())
                    && b.half_extents.iter().all(|v| v.is_finite());
                if !finite {
                    return Err("箱の指定に有限でない値があります".to_string());
                }
                if b.half_extents.iter().any(|v| *v < 0.0) {
                    return Err("箱の半分の長さが負です".to_string());
                }
                Ok(())
            }
        }
    }

    pub fn contains(&self, p: [f64; 3]) -> bool {
        match self {
            ExtractFilter::ScreenPolygon(s) => match project(&s.view_proj, p) {
                Some(ndc) => point_in_polygon(ndc, &s.polygon_ndc),
                None => false,
            },
            ExtractFilter::OrientedBox(b) => {
                let d = sub(p, b.center);
                (0..3).all(|i| dot(d, b.axes[i]).abs() <= b.half_extents[i])
            }
        }
    }

    pub fn may_intersect(&self, min: [f64; 3], max: [f64; 3]) -> bool {
        match self {
            ExtractFilter::ScreenPolygon(s) => screen_may_intersect(s, min, max),
            ExtractFilter::OrientedBox(b) => box_may_intersect(b, min, max),
        }
    }
}

fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn project(m: &[f64; 16], p: [f64; 3]) -> Option<[f64; 2]> {
    let w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
    if w <= 0.0 || !w.is_finite() {
        return None;
    }
    let x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
    let y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
    Some([x / w, y / w])
}

fn point_in_polygon(p: [f64; 2], polygon: &[[f64; 2]]) -> bool {
    let mut inside = false;
    let n = polygon.len();
    if n < 3 {
        return false;
    }
    let mut j = n - 1;
    for i in 0..n {
        let (xi, yi) = (polygon[i][0], polygon[i][1]);
        let (xj, yj) = (polygon[j][0], polygon[j][1]);
        if (yi > p[1]) != (yj > p[1]) && p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi {
            inside = !inside;
        }
        j = i;
    }
    inside
}

fn corners(min: [f64; 3], max: [f64; 3]) -> [[f64; 3]; 8] {
    let mut out = [[0.0; 3]; 8];
    for (i, c) in out.iter_mut().enumerate() {
        *c = [
            if i & 1 == 0 { min[0] } else { max[0] },
            if i & 2 == 0 { min[1] } else { max[1] },
            if i & 4 == 0 { min[2] } else { max[2] },
        ];
    }
    out
}

fn screen_may_intersect(s: &ScreenPolygon, min: [f64; 3], max: [f64; 3]) -> bool {
    let mut bx = (f64::INFINITY, f64::NEG_INFINITY);
    let mut by = (f64::INFINITY, f64::NEG_INFINITY);
    for c in corners(min, max) {
        match project(&s.view_proj, c) {
            Some(n) => {
                bx = (bx.0.min(n[0]), bx.1.max(n[0]));
                by = (by.0.min(n[1]), by.1.max(n[1]));
            }
            None => return true,
        }
    }
    let mut px = (f64::INFINITY, f64::NEG_INFINITY);
    let mut py = (f64::INFINITY, f64::NEG_INFINITY);
    for v in &s.polygon_ndc {
        px = (px.0.min(v[0]), px.1.max(v[0]));
        py = (py.0.min(v[1]), py.1.max(v[1]));
    }
    bx.0 <= px.1 && px.0 <= bx.1 && by.0 <= py.1 && py.0 <= by.1
}

fn box_may_intersect(b: &OrientedBox, min: [f64; 3], max: [f64; 3]) -> bool {
    let c = [
        (min[0] + max[0]) * 0.5,
        (min[1] + max[1]) * 0.5,
        (min[2] + max[2]) * 0.5,
    ];
    let h = [
        (max[0] - min[0]) * 0.5,
        (max[1] - min[1]) * 0.5,
        (max[2] - min[2]) * 0.5,
    ];
    let d = sub(c, b.center);
    for i in 0..3 {
        let axis = b.axes[i];
        let r = h[0] * axis[0].abs() + h[1] * axis[1].abs() + h[2] * axis[2].abs();
        if dot(d, axis).abs() > b.half_extents[i] + r {
            return false;
        }
    }
    for k in 0..3 {
        let r = (0..3)
            .map(|i| b.half_extents[i] * b.axes[i][k].abs())
            .sum::<f64>();
        if d[k].abs() > h[k] + r {
            return false;
        }
    }
    true
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ExtractStats {
    pub nodes_total: usize,
    pub nodes_selected: usize,
    pub nodes_read: usize,
    pub candidate_points: u64,
    pub points_scanned: u64,
    pub points_matched: u64,
    pub max_buffered_points: usize,
}

pub type NodeCallback<'a> = Box<dyn FnMut(&ExtractStats) -> copc_core::Result<()> + Send + 'a>;

pub struct ExtractPoints<'a, R: Read + Seek + Send> {
    reader: CopcReader<R>,
    filter: Option<ExtractFilter>,
    pending: VecDeque<VoxelKey>,
    current: VecDeque<LasPointRecord>,
    stats: ExtractStats,
    on_node: Option<NodeCallback<'a>>,
    depth_limit: Option<i32>,
}

impl<'a, R: Read + Seek + Send> ExtractPoints<'a, R> {
    pub fn new(reader: CopcReader<R>, filter: ExtractFilter) -> Result<Self, copc_core::Error> {
        filter.validate().map_err(copc_core::Error::InvalidInput)?;
        let info: CopcInfo = *reader.copc_info();
        let mut stats = ExtractStats::default();
        let mut pending = VecDeque::new();
        for entry in reader.file().hierarchy_entries() {
            if !entry.has_point_data() {
                continue;
            }
            stats.nodes_total += 1;
            let (min, max) = voxel_bounds(entry.key, &info);
            if filter.may_intersect(min, max) {
                stats.nodes_selected += 1;
                stats.candidate_points += u64::try_from(entry.point_count).unwrap_or(0);
                pending.push_back(entry.key);
            }
        }
        Ok(Self {
            reader,
            filter: Some(filter),
            pending,
            current: VecDeque::new(),
            stats,
            on_node: None,
            depth_limit: None,
        })
    }

    pub fn all(reader: CopcReader<R>) -> Self {
        let mut stats = ExtractStats::default();
        let mut pending = VecDeque::new();
        for entry in reader.file().hierarchy_entries() {
            if !entry.has_point_data() {
                continue;
            }
            stats.nodes_total += 1;
            stats.nodes_selected += 1;
            stats.candidate_points += u64::try_from(entry.point_count).unwrap_or(0);
            pending.push_back(entry.key);
        }
        Self {
            reader,
            filter: None,
            pending,
            current: VecDeque::new(),
            stats,
            on_node: None,
            depth_limit: None,
        }
    }

    pub fn coarse(reader: CopcReader<R>, max_points: u64) -> Self {
        let mut per_level: std::collections::BTreeMap<i32, u64> = std::collections::BTreeMap::new();
        for entry in reader.file().hierarchy_entries() {
            if entry.has_point_data() {
                *per_level.entry(entry.key.level).or_insert(0) +=
                    u64::try_from(entry.point_count).unwrap_or(0);
            }
        }
        let mut depth = 0;
        let mut total = 0u64;
        for (&level, &count) in &per_level {
            total += count;
            if level > 0 && total > max_points {
                break;
            }
            depth = level;
        }
        let mut stats = ExtractStats::default();
        let mut pending = VecDeque::new();
        for entry in reader.file().hierarchy_entries() {
            if !entry.has_point_data() {
                continue;
            }
            stats.nodes_total += 1;
            if entry.key.level <= depth {
                stats.nodes_selected += 1;
                stats.candidate_points += u64::try_from(entry.point_count).unwrap_or(0);
                pending.push_back(entry.key);
            }
        }
        Self {
            reader,
            filter: None,
            pending,
            current: VecDeque::new(),
            stats,
            on_node: None,
            depth_limit: Some(depth),
        }
    }

    pub fn depth_limit(&self) -> Option<i32> {
        self.depth_limit
    }

    pub fn stats(&self) -> ExtractStats {
        self.stats
    }

    pub fn set_node_callback(&mut self, callback: NodeCallback<'a>) {
        self.on_node = Some(callback);
    }

    fn load_next_node(&mut self) -> Result<bool, copc_core::Error> {
        let Some(key) = self.pending.pop_front() else {
            return Ok(false);
        };
        let points = self.reader.read_node(key)?;
        self.stats.nodes_read += 1;
        self.stats.points_scanned += points.len() as u64;
        self.stats.max_buffered_points = self.stats.max_buffered_points.max(points.len());
        for point in &points {
            let matches = match &self.filter {
                Some(filter) => filter.contains([point.x, point.y, point.z]),
                None => true,
            };
            if matches {
                self.current
                    .push_back(LasPointRecord::from_las_point(point));
            }
        }
        if let Some(callback) = self.on_node.as_mut() {
            callback(&self.stats)?;
        }
        Ok(true)
    }
}

impl<R: Read + Seek + Send> Iterator for ExtractPoints<'_, R> {
    type Item = copc_core::Result<LasPointRecord>;

    fn next(&mut self) -> Option<Self::Item> {
        loop {
            if let Some(record) = self.current.pop_front() {
                self.stats.points_matched += 1;
                return Some(Ok(record));
            }
            match self.load_next_node() {
                Ok(true) => {}
                Ok(false) => return None,
                Err(e) => {
                    self.pending.clear();
                    return Some(Err(e));
                }
            }
        }
    }
}

#[cfg(test)]
mod all_points_tests;

#[cfg(test)]
mod tests {
    use super::*;

    fn identity_view_proj() -> [f64; 16] {
        let mut m = [0.0; 16];
        m[0] = 1.0;
        m[5] = 1.0;
        m[10] = 1.0;
        m[15] = 1.0;
        m
    }

    fn looking_down_minus_z() -> [f64; 16] {
        let mut m = identity_view_proj();
        m[11] = -1.0;
        m[15] = 0.0;
        m
    }

    fn square(min: f64, max: f64) -> Vec<[f64; 2]> {
        vec![[min, min], [max, min], [max, max], [min, max]]
    }

    #[test]
    fn polygon_contains_points_inside_only() {
        let f = ExtractFilter::ScreenPolygon(ScreenPolygon {
            view_proj: identity_view_proj(),
            polygon_ndc: square(-0.5, 0.5),
        });
        assert!(f.contains([0.0, 0.0, 100.0]), "depth does not matter");
        assert!(f.contains([0.4, -0.4, -100.0]));
        assert!(!f.contains([0.6, 0.0, 0.0]));
        assert!(!f.contains([0.0, -0.6, 0.0]));
    }

    #[test]
    fn polygon_excludes_points_behind_camera() {
        let f = ExtractFilter::ScreenPolygon(ScreenPolygon {
            view_proj: looking_down_minus_z(),
            polygon_ndc: square(-1.0, 1.0),
        });
        assert!(f.contains([0.0, 0.0, -2.0]));
        assert!(!f.contains([0.0, 0.0, 2.0]), "w <= 0 is excluded");
    }

    #[test]
    fn polygon_node_culling_is_conservative() {
        let f = ExtractFilter::ScreenPolygon(ScreenPolygon {
            view_proj: identity_view_proj(),
            polygon_ndc: square(-0.5, 0.5),
        });
        assert!(f.may_intersect([0.0, 0.0, 0.0], [1.0, 1.0, 1.0]));
        assert!(
            !f.may_intersect([0.6, 0.0, 0.0], [1.0, 1.0, 1.0]),
            "a distant box is not read"
        );
        let g = ExtractFilter::ScreenPolygon(ScreenPolygon {
            view_proj: looking_down_minus_z(),
            polygon_ndc: square(-0.1, 0.1),
        });
        assert!(g.may_intersect([5.0, 5.0, -1.0], [6.0, 6.0, 1.0]));
    }

    fn axis_aligned_box(center: [f64; 3], half: [f64; 3]) -> ExtractFilter {
        ExtractFilter::OrientedBox(OrientedBox {
            center,
            axes: [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]],
            half_extents: half,
        })
    }

    #[test]
    fn oriented_box_contains_and_culls() {
        let f = axis_aligned_box([10.0, 10.0, 10.0], [1.0, 2.0, 3.0]);
        assert!(f.contains([10.5, 11.9, 12.9]));
        assert!(!f.contains([11.1, 10.0, 10.0]));
        assert!(f.may_intersect([9.0, 9.0, 9.0], [10.5, 10.5, 10.5]));
        assert!(!f.may_intersect([20.0, 20.0, 20.0], [21.0, 21.0, 21.0]));
    }

    #[test]
    fn rotated_box_uses_its_own_axes() {
        let s = std::f64::consts::FRAC_1_SQRT_2;
        let f = ExtractFilter::OrientedBox(OrientedBox {
            center: [0.0, 0.0, 0.0],
            axes: [[s, s, 0.0], [-s, s, 0.0], [0.0, 0.0, 1.0]],
            half_extents: [5.0, 0.25, 1.0],
        });
        assert!(f.contains([3.0, 3.0, 0.0]), "along the slab");
        assert!(!f.contains([3.0, -3.0, 0.0]), "outside the slab width");
        assert!(!f.may_intersect([4.0, -6.0, -1.0], [6.0, -4.0, 1.0]));
    }

    #[test]
    fn validate_rejects_bad_input() {
        let few = ExtractFilter::ScreenPolygon(ScreenPolygon {
            view_proj: identity_view_proj(),
            polygon_ndc: vec![[0.0, 0.0], [1.0, 1.0]],
        });
        assert!(few.validate().is_err());
        let nan = axis_aligned_box([f64::NAN, 0.0, 0.0], [1.0, 1.0, 1.0]);
        assert!(nan.validate().is_err());
        let neg = axis_aligned_box([0.0, 0.0, 0.0], [-1.0, 1.0, 1.0]);
        assert!(neg.validate().is_err());
    }

    #[test]
    fn filter_deserializes_from_camel_case_json() {
        let json = r#"{"kind":"orientedBox","center":[1,2,3],
            "axes":[[1,0,0],[0,1,0],[0,0,1]],"halfExtents":[1,1,1]}"#;
        let f: ExtractFilter = serde_json::from_str(json).expect("json");
        assert!(matches!(f, ExtractFilter::OrientedBox(_)));
        let json = r#"{"kind":"screenPolygon","viewProj":[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],
            "polygonNdc":[[0,0],[1,0],[1,1]]}"#;
        let f: ExtractFilter = serde_json::from_str(json).expect("json");
        assert!(matches!(f, ExtractFilter::ScreenPolygon(_)));
    }
}
