use std::io::{Read, Seek};

use spade::{DelaunayTriangulation, FloatTriangulation, HasPosition, Point2, Triangulation};

use crate::csf::{Cloth, CsfParams, XyExtent};
use crate::extract::{ExtractFilter, OrientedBox};
use crate::profile::{ProfileError, SectionAxes, SectionLine};
use crate::{CopcError, CopcFile, NodeKey};

pub const DEFAULT_CORRIDOR_HALF_WIDTH_M: f64 = 20.0;
pub const DEFAULT_SECTION_LINE_CELL_CAP: u64 = 2_000_000;
pub const SECTION_LINE_HEADER_BYTES: usize = 16;
pub const SECTION_LINE_RECORD_BYTES: usize = 8;

const STEPS_PER_ADVANCE: u32 = 10;
const POINTS_PER_ADVANCE: u64 = 200_000;

#[derive(Debug, thiserror::Error)]
pub enum SectionLineError {
    #[error(transparent)]
    Section(#[from] ProfileError),
    #[error("断面線の設定が正しくありません: {0}")]
    Invalid(String),
    #[error("断面線の計算: {0}")]
    Cloth(String),
    #[error("断面線のための点を読めませんでした: {0}")]
    Read(#[from] CopcError),
    #[error("断面線の範囲に点がありません")]
    NoPoints,
    #[error("断面線の範囲に地表と判定された点がありません。急勾配のプリセットや、範囲の見直しを試してください")]
    NoGround,
    #[error("断面線に沿った地表面を作れませんでした（地表の点が線を覆っていません）")]
    NoSurfaceOnLine,
    #[error("キャンセルされました")]
    Cancelled,
}

#[derive(Debug, Clone, Copy)]
pub struct SectionLineParams {
    pub corridor_half_width: f64,
    pub csf: CsfParams,
    pub max_cells: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CsfParamsInput {
    pub cloth_resolution: f64,
    pub rigidness: u32,
    pub time_step: f32,
    pub class_threshold_upper: f32,
    pub class_threshold_lower: f32,
    pub iterations: u32,
    pub slope_smooth: bool,
    pub hdiff: f32,
    pub convergence_threshold: f32,
}

#[derive(Debug, Clone, Copy, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SectionLineRequest {
    pub corridor_half_width: f64,
    pub csf: CsfParamsInput,
}

impl SectionLineRequest {
    pub fn to_params(self, max_cells: u64) -> SectionLineParams {
        let c = self.csf;
        SectionLineParams {
            corridor_half_width: self.corridor_half_width,
            csf: CsfParams {
                cloth_resolution: c.cloth_resolution,
                rigidness: c.rigidness,
                time_step: c.time_step,
                class_threshold_upper: c.class_threshold_upper,
                class_threshold_lower: c.class_threshold_lower,
                iterations: c.iterations,
                slope_smooth: c.slope_smooth,
                hdiff: c.hdiff,
                convergence_threshold: c.convergence_threshold,
            },
            max_cells,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SectionLineProgress {
    pub fraction: f32,
    pub done: bool,
}

#[derive(Debug, Clone, Copy)]
struct Frame {
    origin: [f64; 3],
    along: [f64; 3],
    lateral: [f64; 3],
    up: [f64; 3],
    h_base: f64,
}

impl Frame {
    fn corridor_coords(&self, p: [f64; 3]) -> (f64, f64, f64) {
        let d = [
            p[0] - self.origin[0],
            p[1] - self.origin[1],
            p[2] - self.origin[2],
        ];
        (
            dot(d, self.along),
            dot(d, self.lateral),
            dot(p, self.up) - self.h_base,
        )
    }
}

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

#[derive(Debug, Clone, Copy)]
struct BestCell {
    s: f32,
    t: f32,
    h: f32,
    dist2: f32,
}

const EMPTY_BEST: BestCell = BestCell {
    s: 0.0,
    t: 0.0,
    h: 0.0,
    dist2: f32::INFINITY,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    Ihv,
    Simulate,
    Classify,
    Done,
}

struct GroundVertex {
    s: f64,
    t: f64,
    h: f64,
}

impl HasPosition for GroundVertex {
    type Scalar = f64;
    fn position(&self) -> Point2<f64> {
        Point2::new(self.s, self.t)
    }
}

#[doc(hidden)]
#[derive(Debug, Clone, Copy)]
pub struct DebugVertex {
    pub s: f64,
    pub t: f64,
    pub z: f64,
    pub cloth_z: f64,
    pub is_ground: bool,
}

pub struct SectionLineJob {
    frame: Frame,
    length: f64,
    s_lo: f64,
    half_width: f64,
    resolution: f64,
    filter: ExtractFilter,
    nodes: Vec<NodeKey>,
    next_node: usize,
    cloth: Cloth,
    phase: Phase,
    max_iterations: u32,
    iterations_done: u32,
    best: Vec<BestCell>,
    grid_nx: usize,
    grid_ny: usize,
}

impl SectionLineJob {
    pub fn new<R: Read + Seek + Send>(
        file: &CopcFile<R>,
        line: &SectionLine,
        params: &SectionLineParams,
    ) -> Result<Self, SectionLineError> {
        let w = params.corridor_half_width;
        if !(w.is_finite() && w > 0.0) {
            return Err(SectionLineError::Invalid(
                "帯の幅は 0 より大きい数にしてください".to_string(),
            ));
        }
        params.csf.validate().map_err(SectionLineError::Cloth)?;
        let axes = SectionAxes::new(line)?;
        let (along, up) = (axes.along(), axes.up());
        let lateral = cross(up, along);
        let ab = [
            line.b[0] - line.a[0],
            line.b[1] - line.a[1],
            line.b[2] - line.a[2],
        ];
        let length = dot(ab, along);
        let res = params.csf.cloth_resolution;
        let margin = w;
        let s_lo = -margin;
        let s_hi = length + margin;

        let info = file.info();
        let (_, (z_lo, z_hi)) = axes.ranges_of_box(info.min, info.max);
        let frame = Frame {
            origin: line.a,
            along,
            lateral,
            up,
            h_base: z_lo,
        };

        let cloth = Cloth::new(
            XyExtent {
                min_x: s_lo,
                min_y: -w,
                max_x: s_hi,
                max_y: w,
            },
            params.csf,
            params.max_cells,
        )
        .map_err(SectionLineError::Cloth)?;

        let grid_nx = ((s_hi - s_lo) / res).ceil().max(1.0) as usize;
        let grid_ny = ((2.0 * w) / res).ceil().max(1.0) as usize;
        let cells = grid_nx
            .checked_mul(grid_ny)
            .ok_or_else(|| SectionLineError::Cloth("範囲が広すぎます".to_string()))?;

        let h_mid = (z_lo + z_hi) / 2.0;
        let centre_along = length / 2.0;
        let up_offset = h_mid - dot(line.a, up);
        let center = [
            line.a[0] + along[0] * centre_along + up[0] * up_offset,
            line.a[1] + along[1] * centre_along + up[1] * up_offset,
            line.a[2] + along[2] * centre_along + up[2] * up_offset,
        ];
        let pad = (1.0 + length.abs() + w) * 1e-9;
        let filter = ExtractFilter::OrientedBox(OrientedBox {
            center,
            axes: [along, lateral, up],
            half_extents: [
                (s_hi - s_lo) / 2.0 + pad,
                w + pad,
                (z_hi - z_lo) / 2.0 + 1.0,
            ],
        });
        filter.validate().map_err(SectionLineError::Invalid)?;
        let nodes: Vec<NodeKey> = file
            .hierarchy()
            .nodes()
            .filter(|n| filter.may_intersect(n.bounds_min, n.bounds_max))
            .map(|n| n.key)
            .collect();
        if nodes.is_empty() {
            return Err(SectionLineError::NoPoints);
        }

        Ok(Self {
            frame,
            length,
            s_lo,
            half_width: w,
            resolution: res,
            filter,
            nodes,
            next_node: 0,
            cloth,
            phase: Phase::Ihv,
            max_iterations: params.csf.iterations,
            iterations_done: 0,
            best: vec![EMPTY_BEST; cells],
            grid_nx,
            grid_ny,
        })
    }

    pub fn cell_count(&self) -> usize {
        self.best.len()
    }

    pub fn ground_point_count(&self) -> usize {
        self.best.iter().filter(|c| c.dist2.is_finite()).count()
    }

    #[doc(hidden)]
    pub fn debug_vertices(&self) -> Vec<DebugVertex> {
        self.best
            .iter()
            .filter(|c| c.dist2.is_finite())
            .map(|c| self.debug_vertex(f64::from(c.s), f64::from(c.t), f64::from(c.h)))
            .collect()
    }

    #[doc(hidden)]
    pub fn debug_cloth_height(&self, s: f64, t: f64) -> f64 {
        f64::from(self.cloth.height_at(s, t)) + self.frame.h_base
    }

    fn debug_vertex(&self, s: f64, t: f64, h: f64) -> DebugVertex {
        DebugVertex {
            s,
            t,
            z: h + self.frame.h_base,
            cloth_z: f64::from(self.cloth.height_at(s, t)) + self.frame.h_base,
            is_ground: self.cloth.is_ground(s, t, h),
        }
    }

    #[doc(hidden)]
    pub fn debug_triangle_at(&self, s: f64, t: f64) -> Option<[DebugVertex; 3]> {
        use spade::PositionInTriangulation;
        let vertices: Vec<GroundVertex> = self
            .best
            .iter()
            .filter(|c| c.dist2.is_finite())
            .map(|c| GroundVertex {
                s: f64::from(c.s),
                t: f64::from(c.t),
                h: f64::from(c.h),
            })
            .collect();
        let tin = DelaunayTriangulation::<GroundVertex>::bulk_load(vertices).ok()?;
        match tin.locate(Point2::new(s, t)) {
            PositionInTriangulation::OnFace(face) => {
                let [a, b, c] = tin.face(face).vertices();
                let make = |v: spade::handles::VertexHandle<'_, GroundVertex, (), (), ()>| {
                    let d = v.data();
                    self.debug_vertex(d.s, d.t, d.h)
                };
                Some([make(a), make(b), make(c)])
            }
            _ => None,
        }
    }

    pub fn advance<R: Read + Seek + Send>(
        &mut self,
        file: &mut CopcFile<R>,
    ) -> Result<SectionLineProgress, SectionLineError> {
        match self.phase {
            Phase::Ihv => {
                let finished = self.read_nodes(file, Pass::Ihv)?;
                if finished {
                    self.cloth.finish_ihv().map_err(SectionLineError::Cloth)?;
                    self.phase = Phase::Simulate;
                    self.next_node = 0;
                }
            }
            Phase::Simulate => {
                let p = self
                    .cloth
                    .step(STEPS_PER_ADVANCE)
                    .map_err(SectionLineError::Cloth)?;
                self.iterations_done = p.iterations_done;
                if p.finished {
                    self.phase = Phase::Classify;
                }
            }
            Phase::Classify => {
                if self.read_nodes(file, Pass::Classify)? {
                    self.phase = Phase::Done;
                }
            }
            Phase::Done => {}
        }
        Ok(self.progress())
    }

    fn progress(&self) -> SectionLineProgress {
        let node_fraction = self.next_node as f32 / self.nodes.len().max(1) as f32;
        let fraction = match self.phase {
            Phase::Ihv => 0.30 * node_fraction,
            Phase::Simulate => {
                0.30 + 0.30 * (self.iterations_done as f32 / self.max_iterations.max(1) as f32)
            }
            Phase::Classify => 0.60 + 0.35 * node_fraction,
            Phase::Done => 0.95,
        };
        SectionLineProgress {
            fraction: fraction.min(0.95),
            done: self.phase == Phase::Done,
        }
    }

    fn read_nodes<R: Read + Seek + Send>(
        &mut self,
        file: &mut CopcFile<R>,
        pass: Pass,
    ) -> Result<bool, SectionLineError> {
        let mut scanned = 0u64;
        while self.next_node < self.nodes.len() && scanned < POINTS_PER_ADVANCE {
            let key = self.nodes[self.next_node];
            self.next_node += 1;
            for p in file.read_node_points(key)? {
                scanned += 1;
                let xyz = [p.x, p.y, p.z];
                if !self.filter.contains(xyz) {
                    continue;
                }
                let (s, t, h) = self.frame.corridor_coords(xyz);
                if !(s.is_finite() && t.is_finite() && h.is_finite()) {
                    continue;
                }
                match pass {
                    Pass::Ihv => self.cloth.add_point_for_ihv(s, t, h),
                    Pass::Classify => self.keep_if_ground(s, t, h),
                }
            }
        }
        Ok(self.next_node >= self.nodes.len())
    }

    fn keep_if_ground(&mut self, s: f64, t: f64, h: f64) {
        if !self.cloth.is_ground(s, t, h) {
            return;
        }
        let fx = (s - self.s_lo) / self.resolution;
        let fy = (t + self.half_width) / self.resolution;
        if fx < 0.0 || fy < 0.0 {
            return;
        }
        let (ix, iy) = (fx.floor() as usize, fy.floor() as usize);
        if ix >= self.grid_nx || iy >= self.grid_ny {
            return;
        }
        let (dx, dy) = (fx - ix as f64 - 0.5, fy - iy as f64 - 0.5);
        let dist2 = (dx * dx + dy * dy) as f32;
        let cell = &mut self.best[iy * self.grid_nx + ix];
        if dist2 < cell.dist2 {
            *cell = BestCell {
                s: s as f32,
                t: t as f32,
                h: h as f32,
                dist2,
            };
        }
    }

    pub fn finish(self) -> Result<Vec<u8>, SectionLineError> {
        if self.phase != Phase::Done {
            return Err(SectionLineError::Invalid(
                "計算が終わる前に結果を求めました".to_string(),
            ));
        }
        let vertices: Vec<GroundVertex> = self
            .best
            .iter()
            .filter(|c| c.dist2.is_finite())
            .map(|c| GroundVertex {
                s: f64::from(c.s),
                t: f64::from(c.t),
                h: f64::from(c.h),
            })
            .collect();
        let ground_points = vertices.len();
        if ground_points == 0 {
            return Err(SectionLineError::NoGround);
        }
        let tin = DelaunayTriangulation::<GroundVertex>::bulk_load(vertices)
            .map_err(|e| SectionLineError::Cloth(format!("TIN を作れませんでした: {e}")))?;
        let barycentric = tin.barycentric();

        let steps = (self.length / self.resolution).floor().max(0.0) as usize;
        let mut samples: Vec<(f32, f32)> = Vec::with_capacity(steps + 2);
        let mut push = |s: f64| {
            if let Some(h) = barycentric.interpolate(|v| v.data().h, Point2::new(s, 0.0)) {
                samples.push((s as f32, (h + self.frame.h_base) as f32));
            }
        };
        for k in 0..=steps {
            push(k as f64 * self.resolution);
        }
        if self.length - steps as f64 * self.resolution > 1e-9 {
            push(self.length);
        }
        if samples.is_empty() {
            return Err(SectionLineError::NoSurfaceOnLine);
        }
        Ok(encode(&samples, ground_points, self.best.len()))
    }
}

#[derive(Debug, Clone, Copy)]
enum Pass {
    Ihv,
    Classify,
}

fn encode(samples: &[(f32, f32)], ground_points: usize, cells: usize) -> Vec<u8> {
    let mut out =
        Vec::with_capacity(SECTION_LINE_HEADER_BYTES + samples.len() * SECTION_LINE_RECORD_BYTES);
    out.extend_from_slice(&(samples.len() as u32).to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&(ground_points as u32).to_le_bytes());
    out.extend_from_slice(&(cells as u32).to_le_bytes());
    for (s, z) in samples {
        out.extend_from_slice(&s.to_le_bytes());
        out.extend_from_slice(&z.to_le_bytes());
    }
    out
}

pub fn compute_section_line<R: Read + Seek + Send>(
    file: &mut CopcFile<R>,
    line: &SectionLine,
    params: &SectionLineParams,
    on_progress: &mut dyn FnMut(f32) -> bool,
) -> Result<Vec<u8>, SectionLineError> {
    let mut job = SectionLineJob::new(file, line, params)?;
    loop {
        let p = job.advance(file)?;
        if !on_progress(p.fraction) {
            return Err(SectionLineError::Cancelled);
        }
        if p.done {
            return job.finish();
        }
    }
}

#[cfg(test)]
mod tests;
