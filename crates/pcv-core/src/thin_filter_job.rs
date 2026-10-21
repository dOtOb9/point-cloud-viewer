//! G3-5: thinning and outlier filters as a step-by-step job (for the Web build).
//!
//! The desktop build runs `pcv_convert::thin_filter::{thin_path, filter_path}`, one long call that
//! streams the kept points to the writer. A Web Worker cannot be told to stop while a long call
//! runs, so the Web build needs the same work in small pieces: the Worker calls `advance`
//! repeatedly (one tile per call) and yields to the event loop between calls, where a cancel
//! message is handled. This file is that state machine. It uses the same decision functions
//! (`thin_tile`, `ror_keep`, `sor_accumulate`, `sor_keep`) and the same `TileReader` as the desktop
//! path, so the kept points are the same; the test in `crates/pcv-convert/src/thin_filter/tests.rs`
//! compares the two.
//!
//! # Memory
//!
//! One tile (+ margin) is held at a time, and `advance` returns only the kept points of that tile.
//! The caller writes them away before the next call. Nothing grows with the point count.
//!
//! # Passes
//!
//! Thinning and ROR have one pass (write). SOR has two: pass 1 only adds up the scores
//! (`sor_accumulate`), pass 2 writes the points under the threshold (see `outlier.rs`). The
//! progress counts the core points of every pass, so SOR's total is twice the header's count.
//!
//! # Requests
//!
//! `ThinRequest` and `FilterRequest` are the JSON shapes the screen sends (lengths already in the
//! file's unit). The desktop Tauri commands take the same shapes.

use std::io::{Read, Seek};

use copc_core::LasPointRecord;
use copc_reader::CopcReader;
use serde::Deserialize;

use crate::outlier::{
    ror_keep, sor_accumulate, sor_keep, RorSettings, RunningStats, SorSettings,
};
use crate::thin::{thin_tile, GridKeep, ThinKind, ThinSettings};
use crate::tiles::{TileData, TileReader, TileRect};

/// Which point of a grid cell is kept (JSON names).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GridKeepRequest {
    NearestCentre,
    Lowest,
    Highest,
}

/// Thinning request. `size` is in the file's unit.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ThinRequest {
    Grid { size: f64, keep: GridKeepRequest },
    Voxel { size: f64 },
}

impl ThinRequest {
    pub fn settings(&self) -> ThinSettings {
        match *self {
            ThinRequest::Grid { size, keep } => ThinSettings {
                size,
                kind: ThinKind::Grid(match keep {
                    GridKeepRequest::NearestCentre => GridKeep::NearestCentre,
                    GridKeepRequest::Lowest => GridKeep::Lowest,
                    GridKeepRequest::Highest => GridKeep::Highest,
                }),
            },
            ThinRequest::Voxel { size } => ThinSettings {
                size,
                kind: ThinKind::Voxel,
            },
        }
    }
}

/// Outlier filter request. Lengths are in the file's unit.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FilterRequest {
    #[serde(rename_all = "camelCase")]
    Ror { radius: f64, min_neighbors: u32 },
    #[serde(rename_all = "camelCase")]
    Sor {
        k: usize,
        n_sigma: f64,
        search_radius: f64,
    },
}

/// What a job does. Built from a request.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum JobMode {
    Thin(ThinSettings),
    Ror(RorSettings),
    Sor(SorSettings),
}

impl From<FilterRequest> for JobMode {
    fn from(request: FilterRequest) -> Self {
        match request {
            FilterRequest::Ror {
                radius,
                min_neighbors,
            } => JobMode::Ror(RorSettings {
                radius,
                min_neighbors,
            }),
            FilterRequest::Sor {
                k,
                n_sigma,
                search_radius,
            } => JobMode::Sor(SorSettings {
                k,
                n_sigma,
                search_radius,
            }),
        }
    }
}

impl From<ThinRequest> for JobMode {
    fn from(request: ThinRequest) -> Self {
        JobMode::Thin(request.settings())
    }
}

impl JobMode {
    fn validate(&self) -> Result<(), String> {
        match self {
            JobMode::Thin(s) => s.validate(),
            JobMode::Ror(s) => s.validate(),
            JobMode::Sor(s) => s.validate(),
        }
    }

    fn margin(&self) -> f64 {
        match self {
            JobMode::Thin(s) => s.margin(),
            JobMode::Ror(s) => s.margin(),
            JobMode::Sor(s) => s.margin(),
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum JobError {
    /// User-facing text, shown on screen as is.
    #[error("設定が正しくありません: {0}")]
    Settings(String),
    #[error("{0}")]
    Read(#[from] copc_core::Error),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    /// SOR pass 1: statistics only.
    Statistics,
    /// The pass that produces the kept points.
    Write,
}

/// The result of one `advance` call.
#[derive(Debug)]
pub struct JobStep {
    /// Kept points of the tile just handled (empty in the statistics pass).
    pub kept: Vec<LasPointRecord>,
    /// Core points handled so far, over all passes.
    pub points_read: u64,
    /// The header's point count times the number of passes.
    pub total_points: u64,
    /// No more calls are needed.
    pub done: bool,
}

/// Totals for the tests and the log.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct JobCounters {
    pub tiles: u64,
    pub kept_points: u64,
    /// The most points (core + margin) one tile held.
    pub largest_tile_points: u64,
}

pub struct ThinFilterJob<R, F>
where
    R: Read + Seek + Send,
    F: FnMut() -> copc_core::Result<CopcReader<R>> + Clone,
{
    open: F,
    mode: JobMode,
    cap_points: u64,
    min_tile_size: f64,
    tiles: TileReader<R, F>,
    extent: TileRect,
    phase: Phase,
    stats: RunningStats,
    threshold: f64,
    header_points: u64,
    passes: u64,
    core_done: u64,
    counters: JobCounters,
    done: bool,
}

impl<R, F> ThinFilterJob<R, F>
where
    R: Read + Seek + Send,
    F: FnMut() -> copc_core::Result<CopcReader<R>> + Clone,
{
    /// `open` opens a fresh reader of the source each time it is called (the same closure the
    /// desktop path gives `TileReader`). `cap_points` is the target maximum of points per tile core.
    pub fn new(mode: JobMode, mut open: F, cap_points: u64) -> Result<Self, JobError> {
        mode.validate().map_err(JobError::Settings)?;
        let (header_points, max_abs) = {
            let reader = open()?;
            let h = reader.header();
            let max_abs = [h.min_x, h.min_y, h.min_z, h.max_x, h.max_y, h.max_z]
                .iter()
                .fold(0.0f64, |acc, v| acc.max(v.abs()));
            (h.number_of_points(), max_abs)
        };
        if let JobMode::Thin(s) = &mode {
            s.check_coordinates(max_abs).map_err(JobError::Settings)?;
        }
        // The tile side is at least twice the margin, so the margin is never wider than a tile.
        let min_tile_size = 2.0 * mode.margin();
        let cap_points = cap_points.max(1);
        let tiles = TileReader::new(open.clone(), cap_points, min_tile_size, mode.margin())?;
        let extent = tiles.extent();
        let (phase, passes) = match mode {
            JobMode::Sor(_) => (Phase::Statistics, 2),
            _ => (Phase::Write, 1),
        };
        Ok(Self {
            open,
            mode,
            cap_points,
            min_tile_size,
            tiles,
            extent,
            phase,
            stats: RunningStats::default(),
            threshold: f64::INFINITY,
            header_points,
            passes,
            core_done: 0,
            counters: JobCounters::default(),
            done: false,
        })
    }

    pub fn counters(&self) -> JobCounters {
        self.counters
    }

    /// Handles the next tile (or the switch from SOR pass 1 to pass 2).
    pub fn advance(&mut self) -> Result<JobStep, JobError> {
        let total_points = self.header_points * self.passes;
        if self.done {
            return Ok(self.step(Vec::new(), total_points));
        }
        let tile = match self.tiles.next() {
            Some(tile) => tile?,
            None => {
                if self.phase == Phase::Statistics {
                    // Pass 1 is over: fix the threshold and start reading again for pass 2.
                    if let JobMode::Sor(s) = &self.mode {
                        self.threshold = self.stats.threshold(s.n_sigma);
                    }
                    self.tiles = TileReader::new(
                        self.open.clone(),
                        self.cap_points,
                        self.min_tile_size,
                        self.mode.margin(),
                    )?;
                    self.phase = Phase::Write;
                } else {
                    self.done = true;
                }
                return Ok(self.step(Vec::new(), total_points));
            }
        };
        self.core_done += tile.points.iter().filter(|p| p.is_core).count() as u64;
        self.counters.largest_tile_points = self
            .counters
            .largest_tile_points
            .max(tile.points.len() as u64);
        let kept = match (&self.mode, self.phase) {
            (JobMode::Sor(s), Phase::Statistics) => {
                sor_accumulate(&tile.points, s, &mut self.stats);
                Vec::new()
            }
            _ => {
                self.counters.tiles += 1;
                let keep = self.decide(&tile);
                let kept = take_indices(tile, &keep);
                self.counters.kept_points += kept.len() as u64;
                kept
            }
        };
        Ok(self.step(kept, total_points))
    }

    fn decide(&self, tile: &TileData) -> Vec<usize> {
        match &self.mode {
            JobMode::Thin(s) => thin_tile(tile, &self.extent, s),
            JobMode::Ror(s) => ror_keep(&tile.points, s),
            JobMode::Sor(s) => sor_keep(&tile.points, s, self.threshold),
        }
    }

    fn step(&self, kept: Vec<LasPointRecord>, total_points: u64) -> JobStep {
        JobStep {
            kept,
            points_read: self.core_done,
            total_points,
            done: self.done,
        }
    }
}

/// Moves the points at `keep` (ascending indices) out of the tile.
fn take_indices(tile: TileData, keep: &[usize]) -> Vec<LasPointRecord> {
    let mut out = Vec::with_capacity(keep.len());
    let mut wanted = keep.iter().copied().peekable();
    for (index, point) in tile.points.into_iter().enumerate() {
        if wanted.peek() == Some(&index) {
            wanted.next();
            out.push(point.record);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requests_parse_from_the_json_the_screen_sends() {
        let grid: ThinRequest =
            serde_json::from_str(r#"{"kind":"grid","size":0.5,"keep":"nearestCentre"}"#)
                .expect("grid");
        assert_eq!(
            grid.settings(),
            ThinSettings {
                size: 0.5,
                kind: ThinKind::Grid(GridKeep::NearestCentre)
            }
        );
        let voxel: ThinRequest =
            serde_json::from_str(r#"{"kind":"voxel","size":2}"#).expect("voxel");
        assert_eq!(voxel.settings().kind, ThinKind::Voxel);
        let ror: FilterRequest =
            serde_json::from_str(r#"{"kind":"ror","radius":1.5,"minNeighbors":4}"#).expect("ror");
        assert!(matches!(JobMode::from(ror), JobMode::Ror(s) if s.min_neighbors == 4));
        let sor: FilterRequest =
            serde_json::from_str(r#"{"kind":"sor","k":8,"nSigma":2,"searchRadius":5}"#)
                .expect("sor");
        assert!(
            matches!(JobMode::from(sor), JobMode::Sor(s) if s.k == 8 && s.search_radius == 5.0)
        );
        assert!(serde_json::from_str::<ThinRequest>(r#"{"kind":"ror","radius":1}"#).is_err());
    }
}
