//! G1-T15: the DTM tool. CSF classifies the ground of a whole cloud, the layer is written again with the
//! ground marked, and a Delaunay TIN of a thinned set of ground points becomes a DTM (GeoTIFF grid and/or LandXML).
//!
//! The same recipe as the section line (`crate::section_line`), over the whole cloud instead of a corridor.
//!
//! # Steps (`DtmJob::advance` does them in small pieces)
//!
//! 1. Pass 1: every point of every node (coarse levels too; COPC levels hold disjoint points) goes to
//!    `Cloth::add_point_for_ihv`. The cloth covers the XY extent of the header.
//! 2. The cloth is simulated in batches of steps.
//! 3. Pass 2: every point is classified and handed on in `take_records` (the caller writes it to a new COPC).
//!    The rule (owner's answer Q7): CSF ground -> class 2; originally 2 but not ground -> 1 (unclassified);
//!    anything else keeps its class (a building stays a building). At the same time, of the ground points only the
//!    one nearest to each DTM cell centre is kept (plan 9.3, Q16), so at most one point per cell is held.
//! 4. `finish`: a Delaunay TIN of the kept points (crate `spade`), no edge length limit (Q16). Under a building
//!    there are no ground points, so a triangle bridges it. The grid and LandXML are made from the TIN.
//!
//! # Memory does not grow with the point count
//!
//! Points are never held: the cloth is about 17 B per particle, the best-point grid 16 B per DTM cell, the TIN one
//! vertex per non-empty cell. They depend on the area, the cloth resolution and the DTM cell size, and both are
//! refused above a cap before any point is read. The record buffer of pass 2 holds the points scanned by one
//! `advance` call (see `POINTS_PER_ADVANCE`), and the caller drains it after every call. The reader holds one node.
//!
//! # Rows
//!
//! The GeoTIFF has row 0 at the north (`raster::grid`). The best-point grid is indexed from the south-west corner
//! (`iy` grows with Y); `DtmSurface` samples cell centres through `GridSpec::cell_center`, so it does not matter.
//!
//! This file uses no `std::time` (it is built for wasm32 too).

use std::io::{Read, Seek, Write};

use copc_core::{LasPointRecord, VoxelKey};
use copc_reader::CopcReader;
use spade::{DelaunayTriangulation, FloatTriangulation, HasPosition, Point2, Triangulation};

use crate::csf::{Cloth, CsfParams, XyExtent};
use crate::raster::color::ramp_color;
use crate::raster::{geotiff, GridSpec, RasterError, TiffKind, NODATA};
use crate::section_line::CsfParamsInput;

mod landxml;

pub use landxml::{utc_date_time, LandXmlOptions, LandXmlUnit};

/// Largest number of cloth particles on desktop. First estimate (17 B per particle is about 680 MB); the measured
/// basis is in `TaskSheets/G1-T15-dtm.md`.
pub const DTM_MAX_PARTICLES_DESKTOP: u64 = 40_000_000;
/// Largest number of cloth particles on the Web (wasm memory is 4 GiB at most, and the reader and the writer share it).
pub const DTM_MAX_PARTICLES_WEB: u64 = 16_000_000;
/// Largest number of DTM cells on desktop.
pub const DTM_MAX_CELLS_DESKTOP: u64 = 40_000_000;
/// Largest number of DTM cells on the Web.
pub const DTM_MAX_CELLS_WEB: u64 = 8_000_000;

/// Cloth steps per `advance` call in the simulation phase.
const STEPS_PER_ADVANCE: u32 = 10;
/// A pass reads whole nodes until at least this many points were scanned in one `advance` call.
const POINTS_PER_ADVANCE: u64 = 200_000;
/// Class codes written by pass 2 (ASPRS).
const CLASS_UNCLASSIFIED: u8 = 1;
const CLASS_GROUND: u8 = 2;

#[derive(Debug, thiserror::Error)]
pub enum DtmError {
    #[error("DTM の設定が正しくありません: {0}")]
    Invalid(String),
    #[error(transparent)]
    Grid(#[from] RasterError),
    #[error("DTM の計算: {0}")]
    Cloth(String),
    #[error("点を読めませんでした: {0}")]
    Read(#[from] copc_core::Error),
    #[error("点群に点がありません")]
    NoPoints,
    #[error("地表と判定された点がありません。急勾配のプリセットを試してください")]
    NoGround,
    #[error("DTM を作れませんでした: {0}")]
    Tin(String),
    #[error("DTM のファイルを書けませんでした: {0}")]
    Write(#[from] std::io::Error),
    #[error("キャンセルされました")]
    Cancelled,
}

/// What the caller chooses. Lengths are in the file's unit.
#[derive(Debug, Clone, Copy)]
pub struct DtmParams {
    pub csf: CsfParams,
    /// Side of a DTM cell.
    pub cell_size: f64,
    /// Largest number of cloth particles (refused above it, before any point is read).
    pub max_particles: u64,
    /// Largest number of DTM cells (refused above it).
    pub max_cells: u64,
}

/// What the frontend sends (JSON). Lengths are in the file's unit; the CSF values come from the presets of
/// `src/app/csf-params.ts`, converted there.
#[derive(Debug, Clone, Copy, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DtmRequest {
    pub csf: CsfParamsInput,
    pub cell_size: f64,
    pub output: DtmOutputOptions,
}

/// Which files to make (the setting "DTM の出力形式", owner's answer Q18).
#[derive(Debug, Clone, Copy, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DtmOutputOptions {
    pub geotiff: bool,
    pub landxml: bool,
    #[serde(default)]
    pub tiff: TiffKind,
    /// The file's horizontal unit, written into LandXML.
    #[serde(default)]
    pub unit: LandXmlUnit,
}

impl DtmRequest {
    /// The parameters for `DtmJob::new`. The caps differ between desktop and Web.
    pub fn to_params(self, max_particles: u64, max_cells: u64) -> DtmParams {
        let c = self.csf;
        DtmParams {
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
            cell_size: self.cell_size,
            max_particles,
            max_cells,
        }
    }

    /// Checks the output choice (at least one file).
    pub fn validate(&self) -> Result<(), DtmError> {
        if !self.output.geotiff && !self.output.landxml {
            return Err(DtmError::Invalid(
                "出力形式が選ばれていません。設定で GeoTIFF か LandXML を選んでください"
                    .to_string(),
            ));
        }
        Ok(())
    }
}

/// Progress after one `advance` call.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DtmProgress {
    /// 0.0 to 1.0 over the passes and the simulation (the TIN and the files are not counted).
    pub fraction: f32,
    /// Every point was read, classified and handed on; call `finish`.
    pub done: bool,
}

/// The best ground point of one DTM cell so far. `dist2` is infinite for an empty cell.
#[derive(Debug, Clone, Copy)]
struct BestCell {
    /// Position in cells from the grid's west edge (x) and south edge (y).
    fx: f32,
    fy: f32,
    /// Height minus `z_base`.
    z: f32,
    /// Squared distance to the cell centre, in cells.
    dist2: f32,
}

const EMPTY_BEST: BestCell = BestCell {
    fx: 0.0,
    fy: 0.0,
    z: 0.0,
    dist2: f32::INFINITY,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    Ihv,
    Simulate,
    Classify,
    Done,
}

/// A vertex of the TIN.
struct GroundVertex {
    x: f64,
    y: f64,
    z: f64,
}

impl HasPosition for GroundVertex {
    type Scalar = f64;
    fn position(&self) -> Point2<f64> {
        Point2::new(self.x, self.y)
    }
}

/// A DTM computation that runs in small steps. See the module documentation.
pub struct DtmJob {
    spec: GridSpec,
    epsg: Option<u32>,
    /// Subtracted from heights before the cloth sees them, so f32 stays precise for large coordinates.
    z_base: f64,
    /// Every node with point data, in hierarchy order. Both passes read the same list.
    nodes: Vec<VoxelKey>,
    next_node: usize,
    cloth: Cloth,
    phase: Phase,
    max_iterations: u32,
    iterations_done: u32,
    /// One entry per DTM cell, index `iy * width + ix` with `iy` counted from the south.
    best: Vec<BestCell>,
    /// Classified points of pass 2 not yet taken by the caller.
    out: Vec<LasPointRecord>,
    points_total: u64,
    points_read: u64,
    points_ground: u64,
    max_buffered_points: usize,
    /// A pass reads whole nodes until this many points were scanned in one `advance` call.
    points_per_advance: u64,
}

impl DtmJob {
    /// Checks the input and the caps, lays out the cloth and lists the nodes. No point is read.
    /// `epsg` is written into the GeoTIFF / LandXML (`None`: the files carry no CRS).
    pub fn new<R: Read + Seek + Send>(
        reader: &CopcReader<R>,
        epsg: Option<u32>,
        params: &DtmParams,
    ) -> Result<Self, DtmError> {
        params.csf.validate().map_err(DtmError::Cloth)?;
        let h = reader.header();
        let spec = GridSpec::from_bounds(
            h.min_x,
            h.min_y,
            h.max_x,
            h.max_y,
            params.cell_size,
            params.max_cells,
        )?;
        let cloth = Cloth::new(
            XyExtent {
                min_x: h.min_x,
                min_y: h.min_y,
                max_x: h.max_x,
                max_y: h.max_y,
            },
            params.csf,
            params.max_particles,
        )
        .map_err(DtmError::Cloth)?;
        let mut nodes = Vec::new();
        let mut points_total = 0u64;
        for entry in reader.file().hierarchy_entries() {
            if entry.has_point_data() {
                nodes.push(entry.key);
                points_total += u64::try_from(entry.point_count).unwrap_or(0);
            }
        }
        if nodes.is_empty() {
            return Err(DtmError::NoPoints);
        }
        let cells = usize::try_from(spec.cell_count())
            .map_err(|_| DtmError::Invalid("範囲が広すぎます".to_string()))?;
        Ok(Self {
            spec,
            epsg,
            z_base: h.min_z,
            nodes,
            next_node: 0,
            cloth,
            phase: Phase::Ihv,
            max_iterations: params.csf.iterations,
            iterations_done: 0,
            best: vec![EMPTY_BEST; cells],
            out: Vec::new(),
            points_total,
            points_read: 0,
            points_ground: 0,
            max_buffered_points: 0,
            points_per_advance: POINTS_PER_ADVANCE,
        })
    }

    /// The DTM grid.
    pub fn grid(&self) -> &GridSpec {
        &self.spec
    }

    /// Points of the hierarchy (what the header promises); pass 2 hands on exactly this many.
    pub fn points_total(&self) -> u64 {
        self.points_total
    }

    /// Points read in the current pass so far.
    pub fn points_read(&self) -> u64 {
        self.points_read
    }

    /// Points classified as ground so far (pass 2).
    pub fn points_ground(&self) -> u64 {
        self.points_ground
    }

    /// Bytes held by the cloth and the best-point grid. They follow the area and the two cell sizes; no point is
    /// counted here, so this must not change with the number of points (a test checks it). The node list
    /// (`node_count()` keys, 16 B each) grows with the node count only.
    pub fn memory_bytes(&self) -> usize {
        self.cloth.memory_bytes() + self.best.len() * std::mem::size_of::<BestCell>()
    }

    /// Number of nodes of the hierarchy (what pass 1 and pass 2 each read).
    pub fn node_count(&self) -> usize {
        self.nodes.len()
    }

    /// Most points held at once (the record buffer or one node), for the memory test.
    pub fn max_buffered_points(&self) -> usize {
        self.max_buffered_points
    }

    /// Takes the classified points made by the last `advance` calls (empty before pass 2).
    pub fn take_records(&mut self) -> Vec<LasPointRecord> {
        std::mem::take(&mut self.out)
    }

    /// Does one small piece of work. Call until `done`; in pass 2 drain `take_records` after every call.
    pub fn advance<R: Read + Seek + Send>(
        &mut self,
        reader: &mut CopcReader<R>,
    ) -> Result<DtmProgress, DtmError> {
        match self.phase {
            Phase::Ihv => {
                if self.read_nodes(reader, false)? {
                    self.cloth.finish_ihv().map_err(DtmError::Cloth)?;
                    self.phase = Phase::Simulate;
                    self.next_node = 0;
                    self.points_read = 0;
                }
            }
            Phase::Simulate => {
                let p = self
                    .cloth
                    .step(STEPS_PER_ADVANCE)
                    .map_err(DtmError::Cloth)?;
                self.iterations_done = p.iterations_done;
                if p.finished {
                    self.phase = Phase::Classify;
                }
            }
            Phase::Classify => {
                if self.read_nodes(reader, true)? {
                    self.phase = Phase::Done;
                }
            }
            Phase::Done => {}
        }
        Ok(self.progress())
    }

    fn progress(&self) -> DtmProgress {
        let node_fraction = self.next_node as f32 / self.nodes.len().max(1) as f32;
        let fraction = match self.phase {
            Phase::Ihv => 0.25 * node_fraction,
            Phase::Simulate => {
                0.25 + 0.30 * (self.iterations_done as f32 / self.max_iterations.max(1) as f32)
            }
            Phase::Classify => 0.55 + 0.45 * node_fraction,
            Phase::Done => 1.0,
        };
        DtmProgress {
            fraction: fraction.min(1.0),
            done: self.phase == Phase::Done,
        }
    }

    /// Reads nodes until about `POINTS_PER_ADVANCE` points were scanned. Returns true when all nodes were read.
    fn read_nodes<R: Read + Seek + Send>(
        &mut self,
        reader: &mut CopcReader<R>,
        classify: bool,
    ) -> Result<bool, DtmError> {
        let mut scanned = 0u64;
        while self.next_node < self.nodes.len() && scanned < self.points_per_advance {
            let key = self.nodes[self.next_node];
            self.next_node += 1;
            // The node's points are dropped at the end of each iteration.
            let points = reader.read_node(key)?;
            scanned += points.len() as u64;
            self.points_read += points.len() as u64;
            self.max_buffered_points = self.max_buffered_points.max(points.len());
            for p in &points {
                let z = p.z - self.z_base;
                if !classify {
                    self.cloth.add_point_for_ihv(p.x, p.y, z);
                    continue;
                }
                let mut record = LasPointRecord::from_las_point(p);
                let ground = self.cloth.is_ground(p.x, p.y, z);
                if ground {
                    record.classification = CLASS_GROUND;
                    self.points_ground += 1;
                    self.keep_if_ground(p.x, p.y, z);
                } else if record.classification == CLASS_GROUND {
                    // Owner's answer Q7: a point the source called ground but CSF did not becomes "unclassified".
                    record.classification = CLASS_UNCLASSIFIED;
                }
                self.out.push(record);
            }
            self.max_buffered_points = self.max_buffered_points.max(self.out.len());
        }
        Ok(self.next_node >= self.nodes.len())
    }

    /// Pass 2 for a ground point: remember it if it is nearer to its cell's centre than the point kept so far.
    fn keep_if_ground(&mut self, x: f64, y: f64, z: f64) {
        let fx = (x - self.spec.origin_x) / self.spec.cell_size;
        let fy = (y - self.spec.origin_y) / self.spec.cell_size;
        if !(fx.is_finite() && fy.is_finite()) || fx < 0.0 || fy < 0.0 {
            return;
        }
        let (w, h) = (self.spec.width as usize, self.spec.height as usize);
        // The max edge belongs to the last column / row, like `GridSpec::cell_index`.
        let ix = (fx.floor() as usize).min(w - 1);
        let iy = (fy.floor() as usize).min(h - 1);
        if fx > w as f64 || fy > h as f64 {
            return;
        }
        let (dx, dy) = (fx - ix as f64 - 0.5, fy - iy as f64 - 0.5);
        let dist2 = (dx * dx + dy * dy) as f32;
        let cell = &mut self.best[iy * w + ix];
        if dist2 < cell.dist2 {
            *cell = BestCell {
                fx: fx as f32,
                fy: fy as f32,
                z: z as f32,
                dist2,
            };
        }
    }

    /// Builds the TIN of the kept ground points. Call after `advance` reported `done`.
    pub fn finish(self) -> Result<DtmSurface, DtmError> {
        if self.phase != Phase::Done {
            return Err(DtmError::Invalid(
                "計算が終わる前に結果を求めました".to_string(),
            ));
        }
        let Self {
            spec,
            epsg,
            z_base,
            best,
            ..
        } = self;
        let vertices: Vec<GroundVertex> = best
            .iter()
            .filter(|c| c.dist2.is_finite())
            .map(|c| GroundVertex {
                x: spec.origin_x + f64::from(c.fx) * spec.cell_size,
                y: spec.origin_y + f64::from(c.fy) * spec.cell_size,
                z: f64::from(c.z) + z_base,
            })
            .collect();
        // The grid of best points is not needed any more; free it before the TIN is built.
        drop(best);
        if vertices.is_empty() {
            return Err(DtmError::NoGround);
        }
        let ground_cells = vertices.len();
        let tin = DelaunayTriangulation::<GroundVertex>::bulk_load(vertices)
            .map_err(|e| DtmError::Tin(e.to_string()))?;
        Ok(DtmSurface {
            spec,
            epsg,
            tin,
            ground_cells,
        })
    }
}

/// The finished DTM: a TIN and the grid it is sampled on.
pub struct DtmSurface {
    spec: GridSpec,
    epsg: Option<u32>,
    tin: DelaunayTriangulation<GroundVertex>,
    ground_cells: usize,
}

impl DtmSurface {
    pub fn grid(&self) -> &GridSpec {
        &self.spec
    }

    pub fn epsg(&self) -> Option<u32> {
        self.epsg
    }

    /// Number of cells that held a ground point (= TIN vertices).
    pub fn ground_cells(&self) -> usize {
        self.ground_cells
    }

    pub fn triangle_count(&self) -> usize {
        self.tin.num_inner_faces()
    }

    /// Height at (x, y), or `None` outside the TIN's convex hull.
    pub fn height_at(&self, x: f64, y: f64) -> Option<f64> {
        self.tin
            .barycentric()
            .interpolate(|v| v.data().z, Point2::new(x, y))
    }

    /// The height of every cell centre in image order (row 0 = north); `NODATA` outside the hull.
    /// Four bytes per cell, so it follows the cell count only.
    fn grid_values(&self) -> Vec<f32> {
        let barycentric = self.tin.barycentric();
        (0..self.spec.cell_count() as usize)
            .map(|i| {
                let (x, y) = self.spec.cell_center(i);
                barycentric
                    .interpolate(|v| v.data().z, Point2::new(x, y))
                    .map_or(NODATA, |z| z as f32)
            })
            .collect()
    }

    /// Writes the GeoTIFF. `Colored`: the heights through the elevation ramp (min to max of the grid), NoData
    /// transparent. `Values`: float32 with `GDAL_NODATA`.
    pub fn write_geotiff<W: Write>(&self, out: &mut W, kind: TiffKind) -> Result<(), DtmError> {
        let values = self.grid_values();
        match kind {
            TiffKind::Values => {
                geotiff::write_f32(out, &self.spec, self.epsg, NODATA, values.into_iter())?;
            }
            TiffKind::Colored => {
                let range = values.iter().copied().filter(|&v| v != NODATA).fold(
                    None,
                    |r: Option<(f32, f32)>, v| {
                        Some(r.map_or((v, v), |(lo, hi)| (lo.min(v), hi.max(v))))
                    },
                );
                let pixels = values.into_iter().map(move |v| match range {
                    Some((lo, hi)) if v != NODATA => {
                        let t = if hi > lo { (v - lo) / (hi - lo) } else { 0.0 };
                        let [r, g, b] = ramp_color(t);
                        [r, g, b, 255]
                    }
                    _ => [0, 0, 0, 0],
                });
                geotiff::write_rgba_u8(out, &self.spec, self.epsg, pixels)?;
            }
        }
        Ok(())
    }

    /// Writes the TIN as LandXML 1.2, streaming (the text is never built in memory as a whole).
    pub fn write_landxml<W: Write>(
        &self,
        out: &mut W,
        options: &LandXmlOptions<'_>,
    ) -> Result<(), DtmError> {
        landxml::write(
            out,
            options,
            self.epsg,
            self.tin.vertices().map(|v| {
                let d = v.data();
                (d.x, d.y, d.z)
            }),
            self.tin.inner_faces().map(|f| {
                let [a, b, c] = f.vertices();
                [a.fix().index(), b.fix().index(), c.fix().index()]
            }),
        )
    }
}

/// Runs a whole job on one reader and hands every classified point to `sink`. `on_progress` is called after every
/// step with the fraction; returning `false` cancels. Used by the tests and the measuring example; the desktop and
/// the Web drive `DtmJob` themselves because their writers take the points differently.
pub fn run_dtm<R: Read + Seek + Send>(
    reader: &mut CopcReader<R>,
    epsg: Option<u32>,
    params: &DtmParams,
    sink: &mut dyn FnMut(LasPointRecord) -> Result<(), DtmError>,
    on_progress: &mut dyn FnMut(f32) -> bool,
) -> Result<DtmSurface, DtmError> {
    let mut job = DtmJob::new(reader, epsg, params)?;
    loop {
        let p = job.advance(reader)?;
        for record in job.take_records() {
            sink(record)?;
        }
        if !on_progress(p.fraction) {
            return Err(DtmError::Cancelled);
        }
        if p.done {
            return job.finish();
        }
    }
}

#[cfg(test)]
mod tests;
