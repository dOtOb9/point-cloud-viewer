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

pub const DTM_MAX_PARTICLES_DESKTOP: u64 = 40_000_000;
pub const DTM_MAX_PARTICLES_WEB: u64 = 16_000_000;
pub const DTM_MAX_CELLS_DESKTOP: u64 = 40_000_000;
pub const DTM_MAX_CELLS_WEB: u64 = 8_000_000;
pub const DTM_MAX_CELLS_WEB_LANDXML: u64 = 2_000_000;

const STEPS_PER_ADVANCE: u32 = 10;
const POINTS_PER_ADVANCE: u64 = 200_000;
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
    #[error("{0}")]
    TooLarge(String),
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

#[derive(Debug, Clone, Copy)]
pub struct DtmParams {
    pub csf: CsfParams,
    pub cell_size: f64,
    pub max_particles: u64,
    pub max_cells: u64,
    pub display_unit: Option<DisplayUnit>,
}

#[derive(Debug, Clone, Copy, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayUnit {
    pub symbol: DisplaySymbol,
    pub file_units_per_display_unit: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
pub enum DisplaySymbol {
    #[serde(rename = "m")]
    Meter,
    #[serde(rename = "ft")]
    Foot,
}

impl DisplaySymbol {
    fn text(self) -> &'static str {
        match self {
            Self::Meter => "m",
            Self::Foot => "ft",
        }
    }
}

struct SizeWording {
    scale: f64,
    symbol: Option<&'static str>,
}

impl SizeWording {
    fn new(display: Option<DisplayUnit>) -> Self {
        match display {
            Some(DisplayUnit {
                symbol,
                file_units_per_display_unit: Some(k),
            }) if k.is_finite() && k > 0.0 => Self {
                scale: k,
                symbol: Some(symbol.text()),
            },
            _ => Self {
                scale: 1.0,
                symbol: None,
            },
        }
    }

    fn at_least(&self, shown: f64) -> String {
        match self.symbol {
            Some(symbol) => format!("{shown} {symbol} 以上"),
            None => format!("{shown}（点群ファイルの単位）以上"),
        }
    }

    fn setting_text(&self, file_value: f64) -> String {
        let Some(symbol) = self.symbol else {
            return file_value.to_string();
        };
        let v = file_value / self.scale;
        let shown = if v.is_finite() && v != 0.0 {
            let exp = v.abs().log10().floor() as i32 - 3;
            with_exponent((v / 10f64.powi(exp)).round(), exp)
        } else {
            v
        };
        format!("{shown} {symbol}")
    }
}

#[derive(Debug, Clone, Copy, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DtmRequest {
    pub csf: CsfParamsInput,
    pub cell_size: f64,
    pub output: DtmOutputOptions,
    #[serde(default)]
    pub display_unit: Option<DisplayUnit>,
}

#[derive(Debug, Clone, Copy, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DtmOutputOptions {
    pub geotiff: bool,
    pub landxml: bool,
    #[serde(default)]
    pub tiff: TiffKind,
    #[serde(default)]
    pub unit: LandXmlUnit,
}

impl DtmRequest {
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
            display_unit: self.display_unit,
        }
    }

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

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DtmProgress {
    pub fraction: f32,
    pub done: bool,
}

#[derive(Debug, Clone, Copy)]
struct BestCell {
    fx: f32,
    fy: f32,
    z: f32,
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

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct GroundAgreement {
    pub both: u64,
    pub csf_only: u64,
    pub source_only: u64,
    pub neither: u64,
}

impl GroundAgreement {
    fn add(&mut self, source_ground: bool, csf_ground: bool) {
        match (source_ground, csf_ground) {
            (true, true) => self.both += 1,
            (false, true) => self.csf_only += 1,
            (true, false) => self.source_only += 1,
            (false, false) => self.neither += 1,
        }
    }

    pub fn precision(&self) -> Option<f64> {
        let csf = self.both + self.csf_only;
        (csf > 0).then(|| self.both as f64 / csf as f64)
    }

    pub fn recall(&self) -> Option<f64> {
        let source = self.both + self.source_only;
        (source > 0).then(|| self.both as f64 / source as f64)
    }
}

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

pub struct DtmJob {
    spec: GridSpec,
    epsg: Option<u32>,
    z_base: f64,
    nodes: Vec<VoxelKey>,
    next_node: usize,
    cloth: Cloth,
    phase: Phase,
    max_iterations: u32,
    iterations_done: u32,
    best: Vec<BestCell>,
    out: Vec<LasPointRecord>,
    points_total: u64,
    points_read: u64,
    points_ground: u64,
    agreement: GroundAgreement,
    max_buffered_points: usize,
    points_per_advance: u64,
}

fn with_exponent(digits: f64, exp: i32) -> f64 {
    format!("{digits}e{exp}")
        .parse()
        .unwrap_or(digits * 10f64.powi(exp))
}

const KEEP_ALREADY_ROUND_VALUES: f64 = 1e-9;

fn round_up_2_digits(x: f64) -> f64 {
    let exp = x.log10().floor() as i32 - 1;
    with_exponent(
        (x / 10f64.powi(exp) - KEEP_ALREADY_ROUND_VALUES).ceil(),
        exp,
    )
}

fn smallest_fitting(start: f64, fits: impl Fn(f64) -> bool) -> Option<f64> {
    if !start.is_finite() || start <= 0.0 {
        return None;
    }
    let mut candidate = round_up_2_digits(start);
    for _ in 0..1000 {
        if fits(candidate) {
            return Some(candidate);
        }
        candidate = round_up_2_digits(candidate * 1.0001);
    }
    None
}

impl DtmJob {
    pub fn new<R: Read + Seek + Send>(
        reader: &CopcReader<R>,
        epsg: Option<u32>,
        params: &DtmParams,
    ) -> Result<Self, DtmError> {
        params.csf.validate().map_err(DtmError::Cloth)?;
        let h = reader.header();
        let (width, height) = (h.max_x - h.min_x, h.max_y - h.min_y);
        let grid_for = |cell: f64| {
            GridSpec::from_bounds(h.min_x, h.min_y, h.max_x, h.max_y, cell, params.max_cells)
        };
        let spec = match grid_for(params.cell_size) {
            Ok(spec) => spec,
            Err(RasterError::TooManyCells {
                cols,
                rows,
                max_cells,
            }) => {
                let w = SizeWording::new(params.display_unit);
                let start = (width * height / max_cells as f64).sqrt() / w.scale;
                let text = match smallest_fitting(start, |c| grid_for(c * w.scale).is_ok()) {
                    Some(min) => format!(
                        "DTM の範囲が大きすぎます（{cols:.0} 列 × {rows:.0} 行、上限は {max_cells} セル）。\
                         DTM のセルの大きさを {}にするか、\
                         先にカットで範囲を切り出してください",
                        w.at_least(min)
                    ),
                    None => format!(
                        "DTM の範囲が大きすぎます（{cols:.0} 列 × {rows:.0} 行、上限は {max_cells} セル）。\
                         DTM のセルの大きさを大きくするか、先にカットで範囲を切り出してください"
                    ),
                };
                return Err(DtmError::TooLarge(text));
            }
            Err(e) => return Err(e.into()),
        };
        let extent = XyExtent {
            min_x: h.min_x,
            min_y: h.min_y,
            max_x: h.max_x,
            max_y: h.max_y,
        };
        let cloth_for = |resolution: f64| {
            let mut csf = params.csf;
            csf.cloth_resolution = resolution;
            Cloth::new(extent, csf, params.max_particles)
        };
        let res = params.csf.cloth_resolution;
        let max = params.max_particles;
        let cloth = match cloth_for(res) {
            Ok(cloth) => cloth,
            Err(_) => {
                let w = SizeWording::new(params.display_unit);
                let start = (width * height / params.max_particles as f64).sqrt();
                let start = start.max(res) / w.scale;
                let text = match smallest_fitting(start, |r| cloth_for(r * w.scale).is_ok()) {
                    Some(min) => format!(
                        "DTM の布（CSF の解像度 {}）の粒子数が上限の {max} 個を超えます。\
                         布の解像度を {}にするか、\
                         先にカットで範囲を切り出してください",
                        w.setting_text(res),
                        w.at_least(min)
                    ),
                    None => format!(
                        "DTM の布（CSF の解像度 {res}）の粒子数が上限の {max} 個を超えます。\
                         布の解像度を粗くするか、先にカットで範囲を切り出してください"
                    ),
                };
                return Err(DtmError::TooLarge(text));
            }
        };
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
            agreement: GroundAgreement::default(),
            max_buffered_points: 0,
            points_per_advance: POINTS_PER_ADVANCE,
        })
    }

    pub fn grid(&self) -> &GridSpec {
        &self.spec
    }

    pub fn points_total(&self) -> u64 {
        self.points_total
    }

    pub fn points_read(&self) -> u64 {
        self.points_read
    }

    pub fn points_ground(&self) -> u64 {
        self.points_ground
    }

    pub fn ground_agreement(&self) -> GroundAgreement {
        self.agreement
    }

    pub fn memory_bytes(&self) -> usize {
        self.cloth.memory_bytes() + self.best.len() * std::mem::size_of::<BestCell>()
    }

    pub fn node_count(&self) -> usize {
        self.nodes.len()
    }

    pub fn max_buffered_points(&self) -> usize {
        self.max_buffered_points
    }

    pub fn take_records(&mut self) -> Vec<LasPointRecord> {
        std::mem::take(&mut self.out)
    }

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

    fn read_nodes<R: Read + Seek + Send>(
        &mut self,
        reader: &mut CopcReader<R>,
        classify: bool,
    ) -> Result<bool, DtmError> {
        let mut scanned = 0u64;
        while self.next_node < self.nodes.len() && scanned < self.points_per_advance {
            let key = self.nodes[self.next_node];
            self.next_node += 1;
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
                self.agreement
                    .add(record.classification == CLASS_GROUND, ground);
                if ground {
                    record.classification = CLASS_GROUND;
                    self.points_ground += 1;
                    self.keep_if_ground(p.x, p.y, z);
                } else if record.classification == CLASS_GROUND {
                    record.classification = CLASS_UNCLASSIFIED;
                }
                self.out.push(record);
            }
            self.max_buffered_points = self.max_buffered_points.max(self.out.len());
        }
        Ok(self.next_node >= self.nodes.len())
    }

    fn keep_if_ground(&mut self, x: f64, y: f64, z: f64) {
        let fx = (x - self.spec.origin_x) / self.spec.cell_size;
        let fy = (y - self.spec.origin_y) / self.spec.cell_size;
        if !(fx.is_finite() && fy.is_finite()) || fx < 0.0 || fy < 0.0 {
            return;
        }
        let (w, h) = (self.spec.width as usize, self.spec.height as usize);
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

    pub fn ground_cells(&self) -> usize {
        self.ground_cells
    }

    pub fn triangle_count(&self) -> usize {
        self.tin.num_inner_faces()
    }

    pub fn height_at(&self, x: f64, y: f64) -> Option<f64> {
        self.tin
            .barycentric()
            .interpolate(|v| v.data().z, Point2::new(x, y))
    }

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
