//! G2-4: the ground line of a cross section, made from a local CSF ground surface.
//!
//! The section tool cuts a thin slab out of a cloud. A thin slab has no context: a cloth dropped on it
//! would fall through every gap, so the ground has to be found in a wider band around the line A->B
//! (the "corridor") of the SOURCE layer. The result is a polyline `(s, z)` along A->B.
//!
//! # Steps
//!
//! 1. Corridor frame: `s` = distance along A->B from A (horizontal), `t` = horizontal distance to the
//!    left of the line, `h` = height along `up`. The corridor is the oriented box
//!    `s in [-margin, length + margin]`, `t in [-W, W]`, all heights. The cloth lies in the (s, t) plane,
//!    so its grid is aligned with the section, not with the file's X and Y axes.
//! 2. Pass 1: every point of the corridor goes to `Cloth::add_point_for_ihv`. Then `finish_ihv`.
//! 3. The cloth is simulated in batches of steps (`CsfProgress`).
//! 4. Pass 2: every point of the corridor is classified with `Cloth::is_ground`. For each grid cell
//!    only the ground point nearest the cell centre is kept (plan 9.3, Q16), so the number of kept
//!    points is at most the number of cells.
//! 5. A Delaunay TIN of the kept points in (s, t) (crate `spade`), sampled along t = 0 at the cloth
//!    resolution. Under a building there are no ground points, so a triangle bridges it; there is no
//!    edge length limit (Q16). The polyline stops where the line leaves the TIN's convex hull.
//!
//! # Memory does not grow with the point count
//!
//! Points are never held. The cloth has 13 B per particle, the best-point grid 16 B per cell, the TIN
//! one vertex per non-empty cell. All three depend on the corridor's area and the cloth resolution,
//! and the area is refused above `max_cells`. The corridor's nodes are read one at a time.
//!
//! # Running in steps
//!
//! `SectionLineJob::advance` does a small amount of work and returns the progress, so the desktop
//! can check a cancel flag and the browser can yield to its event loop between calls. This file uses
//! no `std::time` (it is built for wasm32 too).
//!
//! # Result buffer (little endian)
//!
//! ```text
//! header, 16 bytes   u32 count | u32 flags (0) | u32 ground_points | u32 cells
//! then count * 8     f32 s | f32 z
//! ```
//!
//! Only the part of A->B inside the TIN's convex hull is returned. A convex hull cuts a straight line
//! in one stretch, so there are no breaks inside the polyline: where the ground points do not reach
//! (the ends of the line) the polyline just starts later or ends earlier. `s` is measured from A like
//! the section panel's `s`; `z` is the absolute height along `up` like the panel's `z`.

use std::io::{Read, Seek};

use spade::{DelaunayTriangulation, FloatTriangulation, HasPosition, Point2, Triangulation};

use crate::csf::{Cloth, CsfParams, XyExtent};
use crate::extract::{ExtractFilter, OrientedBox};
use crate::profile::{ProfileError, SectionAxes, SectionLine};
use crate::{CopcError, CopcFile, NodeKey};

/// Default corridor half width in metres (the caller converts it to the file's unit).
pub const DEFAULT_CORRIDOR_HALF_WIDTH_M: f64 = 20.0;
/// Default largest number of cloth particles (the corridor of a 5 km line at 0.5 m is about 1.6 million).
pub const DEFAULT_SECTION_LINE_CELL_CAP: u64 = 2_000_000;
/// Header of the result buffer in bytes.
pub const SECTION_LINE_HEADER_BYTES: usize = 16;
/// One record of the result buffer in bytes.
pub const SECTION_LINE_RECORD_BYTES: usize = 8;

/// Cloth steps per `advance` call in the simulation phase.
const STEPS_PER_ADVANCE: u32 = 10;
/// A pass reads whole nodes until at least this many points were scanned in one `advance` call.
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

/// What the caller chooses. Lengths are in the file's unit.
#[derive(Debug, Clone, Copy)]
pub struct SectionLineParams {
    /// Half width of the corridor on each side of the line.
    pub corridor_half_width: f64,
    /// CSF parameters. `cloth_resolution` is in the file's unit too.
    pub csf: CsfParams,
    /// Largest number of cloth particles (refused above it).
    pub max_cells: u64,
}

/// Progress after one `advance` call.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SectionLineProgress {
    /// 0.0 to 1.0 over the whole job (the TIN at the end is counted as the last 5%).
    pub fraction: f32,
    /// All reading and simulation is done; call `finish`.
    pub done: bool,
}

/// The corridor's coordinate frame.
#[derive(Debug, Clone, Copy)]
struct Frame {
    origin: [f64; 3],
    along: [f64; 3],
    lateral: [f64; 3],
    up: [f64; 3],
    /// Height subtracted before the cloth sees it, so f32 heights stay precise for large coordinates.
    h_base: f64,
}

impl Frame {
    /// `(s, t, h - h_base)` of a point.
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

/// The best ground point of one cell so far. `dist2` is infinite for an empty cell.
#[derive(Debug, Clone, Copy)]
struct BestCell {
    s: f32,
    t: f32,
    /// Height minus `Frame::h_base`.
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

/// A vertex of the TIN: position (s, t), value `h`.
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

/// A section-line computation that runs in small steps. See the module documentation.
pub struct SectionLineJob {
    frame: Frame,
    /// Length of A->B.
    length: f64,
    /// `s` of the first grid column.
    s_lo: f64,
    half_width: f64,
    resolution: f64,
    filter: ExtractFilter,
    /// Nodes that may touch the corridor, in hierarchy order. Both passes read the same list.
    nodes: Vec<NodeKey>,
    next_node: usize,
    cloth: Cloth,
    phase: Phase,
    max_iterations: u32,
    iterations_done: u32,
    /// Best-point grid of pass 2: `grid_nx * grid_ny` cells, row `iy` holds one `t` row.
    best: Vec<BestCell>,
    grid_nx: usize,
    grid_ny: usize,
}

impl SectionLineJob {
    /// Checks the input, lays out the cloth and lists the nodes of the corridor. No point is read.
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
        // `up` and `along` are orthogonal unit vectors, so this is a unit vector too.
        let lateral = cross(up, along);
        let ab = [
            line.b[0] - line.a[0],
            line.b[1] - line.a[1],
            line.b[2] - line.a[2],
        ];
        let length = dot(ab, along);
        let res = params.csf.cloth_resolution;
        // The cloth sees a little beyond both ends of the line, so the ends are not on its rim.
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
        // The cloth is at least as large as this grid, so the cap already holds; this guards the
        // multiplication anyway.
        let cells = grid_nx
            .checked_mul(grid_ny)
            .ok_or_else(|| SectionLineError::Cloth("範囲が広すぎます".to_string()))?;

        // Centre of the box: halfway along the line, and halfway between the lowest and highest height.
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

    /// Number of grid cells; the kept ground points never exceed it.
    pub fn cell_count(&self) -> usize {
        self.best.len()
    }

    /// Number of cells that hold a ground point so far.
    pub fn ground_point_count(&self) -> usize {
        self.best.iter().filter(|c| c.dist2.is_finite()).count()
    }

    /// Does one small piece of work. Call until `done`, then `finish`.
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

    /// Reads nodes until about `POINTS_PER_ADVANCE` points were scanned. Returns true when all nodes were read.
    fn read_nodes<R: Read + Seek + Send>(
        &mut self,
        file: &mut CopcFile<R>,
        pass: Pass,
    ) -> Result<bool, SectionLineError> {
        let mut scanned = 0u64;
        while self.next_node < self.nodes.len() && scanned < POINTS_PER_ADVANCE {
            let key = self.nodes[self.next_node];
            self.next_node += 1;
            // The node's points are dropped at the end of each iteration.
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

    /// Pass 2 for one point: remember it if it is ground and nearer to its cell's centre than the point kept so far.
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
        // Distance to the cell centre, in cells (the square is enough to compare).
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

    /// Builds the TIN of the kept ground points, samples it along the line and encodes the result buffer.
    /// Call after `advance` reported `done`.
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

        // Sample at the cloth resolution; the last sample is exactly at B. The hull of a TIN is convex, so the
        // part of the line inside it is one stretch: samples outside it are left out.
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

/// Runs a whole job. `on_progress` is called after every step with the fraction; returning `false` cancels.
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
