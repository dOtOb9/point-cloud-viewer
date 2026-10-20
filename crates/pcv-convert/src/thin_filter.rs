//! G3-2 / G3-3 / G3-4: "thin a COPC file or remove outliers from it, and write the
//! kept points into a new COPC file" (desktop and Android).
//!
//! The same structure as `extract.rs`: the source file is never modified
//! (`TaskSheets/ADR-0018-layer-centric-operations.md`), the kept points are streamed to
//! `copc-writer` (`write_streaming_with_cancel_and_timings`), and the output points are
//! not held in memory.
//!
//! # How the points flow
//!
//! `pcv_core::tiles::TileReader` reads one XY tile (+ margin) at a time. The decision
//! function (`pcv_core::thin` / `pcv_core::outlier`) says which points of the tile to
//! keep; `KeptPoints` hands those, tile by tile, to the writer as an iterator. Memory is
//! one tile (+ margin) plus the writer's own spill, independent of the point count.
//!
//! # SOR needs two passes
//!
//! The threshold depends on the mean and std over the whole cloud. Pass 1 reads every
//! tile and only accumulates the statistics (no output). Pass 2 reads every tile again
//! and writes. See `pcv_core::outlier`. ROR and thinning need one pass.
//!
//! # Progress
//!
//! `ReadProgress::points_read` counts the CORE points of the tiles finished so far
//! (every point once per pass) and `total_points` is the header's point count times the
//! number of passes. Re-reading of coarse nodes is not in these numbers; it shows up in
//! `ThinFilterSummary::points_scanned`.
//!
//! # Zero points
//!
//! If nothing is kept, no output is created and `ThinFilterError::EmptyResult` is
//! returned (the first kept point is taken before the writer starts, as in extract).

use std::io::{Read, Seek};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use copc_core::{CancelCheck, LasPointRecord, StreamingLayout};
use copc_reader::CopcReader;
use copc_writer::{write_streaming_with_cancel_and_timings, CopcWriterParams};
use pcv_core::outlier::{
    ror_keep, sor_accumulate, sor_keep, RorSettings, RunningStats, SorSettings,
};
use pcv_core::thin::{thin_tile, ThinSettings};
use pcv_core::tiles::{TileData, TileReader, TileRect};

use crate::stage_timings::ConversionStageTimings;
use crate::streaming::ReadProgress;
use crate::write_metadata::copc_write_metadata_from_source_header;

#[derive(Debug, thiserror::Error)]
pub enum ThinFilterError {
    /// User-facing text, shown on screen as is.
    #[error("残る点がありません")]
    EmptyResult,
    #[error("設定が正しくありません: {0}")]
    Settings(String),
    #[error("{path}: 点群(COPC)として開けませんでした: {source}")]
    Open {
        path: PathBuf,
        #[source]
        source: copc_core::Error,
    },
    #[error("{path}: ヘッダーを読めませんでした: {source}")]
    OpenHeader {
        path: PathBuf,
        #[source]
        source: las::Error,
    },
    #[error("点を読めませんでした: {0}")]
    Read(#[source] copc_core::Error),
    #[error("COPCの書き出しに失敗しました: {0}")]
    Write(#[source] copc_core::Error),
}

impl ThinFilterError {
    /// Whether it stopped because of cancellation (shown as "cancelled" on screen).
    pub fn is_cancelled(&self) -> bool {
        matches!(
            self,
            ThinFilterError::Read(copc_core::Error::Cancelled)
                | ThinFilterError::Write(copc_core::Error::Cancelled)
        )
    }
}

/// How the cloud is cut into tiles (see `pcv_core::tiles::plan_tiles`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TilingParams {
    /// Target maximum of (estimated) points per tile core.
    pub cap_points: u64,
    /// Smallest tile side. The functions below raise it to at least twice the margin,
    /// so that the margin is never wider than a tile.
    pub min_tile_size: f64,
}

impl Default for TilingParams {
    fn default() -> Self {
        Self {
            cap_points: 2_000_000,
            min_tile_size: 0.0,
        }
    }
}

/// Which outlier filter to run.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum OutlierFilter {
    Ror(RorSettings),
    Sor(SorSettings),
}

/// The statistics SOR computed in pass 1.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SorSummary {
    pub mean: f64,
    pub std: f64,
    /// `mean + n * std`: points with a larger score were removed.
    pub threshold: f64,
}

/// Result of a thinning or filtering run.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ThinFilterSummary {
    /// Number of points written.
    pub kept_points: u64,
    pub tile_count: u64,
    /// Points decompressed over all tiles and passes (includes re-reads of nodes that
    /// overlap several tiles). Divide by the header's point count (times passes) for the
    /// re-read factor.
    pub points_scanned: u64,
    /// Core points handled over all passes (the header's count times the passes).
    pub core_points_read: u64,
    /// The largest number of points (core + margin) one tile held.
    pub largest_tile_points: u64,
    pub sor: Option<SorSummary>,
}

/// Counters shared between the iterator (moved into the writer) and the caller.
#[derive(Default)]
struct Counters {
    tiles: AtomicU64,
    scanned: AtomicU64,
    core_read: AtomicU64,
    largest_tile: AtomicU64,
    kept: AtomicU64,
}

impl Counters {
    fn record_tile(&self, tile: &TileData) {
        self.tiles.fetch_add(1, Ordering::Relaxed);
        self.scanned
            .fetch_add(tile.scanned_points, Ordering::Relaxed);
        let core = tile.points.iter().filter(|p| p.is_core).count() as u64;
        self.core_read.fetch_add(core, Ordering::Relaxed);
        self.largest_tile
            .fetch_max(tile.points.len() as u64, Ordering::Relaxed);
    }

    fn get(counter: &AtomicU64) -> u64 {
        counter.load(Ordering::Relaxed)
    }
}

/// Yields the kept points tile by tile. Checks `cancel` and reports progress per tile.
/// `D` is the decision function of the tile: it returns the indices (ascending) of the
/// points of the tile to keep.
struct KeptPoints<'a, R, F, D>
where
    R: Read + Seek + Send,
    F: FnMut() -> copc_core::Result<CopcReader<R>>,
    D: FnMut(&TileData, &TileRect) -> Vec<usize>,
{
    tiles: TileReader<R, F>,
    extent: TileRect,
    decide: D,
    cancel: &'a (dyn CancelCheck + Sync),
    on_progress: &'a mut dyn FnMut(ReadProgress),
    /// `points_read` already done by earlier passes, and the total over all passes.
    progress_base: u64,
    progress_total: u64,
    current: std::vec::IntoIter<LasPointRecord>,
    counters: Arc<Counters>,
    done: bool,
}

impl<R, F, D> Iterator for KeptPoints<'_, R, F, D>
where
    R: Read + Seek + Send,
    F: FnMut() -> copc_core::Result<CopcReader<R>>,
    D: FnMut(&TileData, &TileRect) -> Vec<usize>,
{
    type Item = copc_core::Result<LasPointRecord>;

    fn next(&mut self) -> Option<Self::Item> {
        loop {
            if let Some(record) = self.current.next() {
                self.counters.kept.fetch_add(1, Ordering::Relaxed);
                return Some(Ok(record));
            }
            if self.done {
                return None;
            }
            if let Err(e) = self.cancel.check() {
                self.done = true;
                return Some(Err(e));
            }
            let tile = match self.tiles.next() {
                None => {
                    self.done = true;
                    return None;
                }
                Some(Err(e)) => {
                    self.done = true;
                    return Some(Err(e));
                }
                Some(Ok(tile)) => tile,
            };
            self.counters.record_tile(&tile);
            (self.on_progress)(ReadProgress {
                points_read: self.progress_base + Counters::get(&self.counters.core_read),
                total_points: self.progress_total,
            });
            let keep = (self.decide)(&tile, &self.extent);
            self.current = take_indices(tile, &keep).into_iter();
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

/// What the header says, needed before any point is read.
struct SourceInfo {
    layout: StreamingLayout,
    metadata: copc_writer::CopcWriteMetadata,
    total_points: u64,
    max_abs_coordinate: f64,
}

fn read_source_info(source: &Path) -> Result<SourceInfo, ThinFilterError> {
    let header_reader =
        las::Reader::from_path(source).map_err(|source_err| ThinFilterError::OpenHeader {
            path: source.to_path_buf(),
            source: source_err,
        })?;
    let header = header_reader.header();
    let bounds = header.bounds();
    let max_abs_coordinate = [
        bounds.min.x,
        bounds.min.y,
        bounds.min.z,
        bounds.max.x,
        bounds.max.y,
        bounds.max.z,
    ]
    .iter()
    .fold(0.0f64, |acc, v| acc.max(v.abs()));
    Ok(SourceInfo {
        layout: StreamingLayout::from_las_header(header),
        metadata: copc_write_metadata_from_source_header(header),
        total_points: header.number_of_points(),
        max_abs_coordinate,
    })
}

type FileReader = CopcReader<std::io::BufReader<std::fs::File>>;

fn tile_reader_for<'a>(
    source: &'a Path,
    tiling: &TilingParams,
    margin: f64,
) -> Result<
    TileReader<
        std::io::BufReader<std::fs::File>,
        impl FnMut() -> copc_core::Result<FileReader> + 'a,
    >,
    ThinFilterError,
> {
    let min_tile_size = tiling.min_tile_size.max(2.0 * margin);
    let open = move || CopcReader::from_path(source);
    TileReader::new(open, tiling.cap_points.max(1), min_tile_size, margin).map_err(|e| {
        ThinFilterError::Open {
            path: source.to_path_buf(),
            source: e,
        }
    })
}

#[cfg(test)]
mod tests;

/// One writing pass: reads every tile, keeps what `decide` says and writes it.
#[allow(clippy::too_many_arguments)]
fn write_pass<D>(
    source: &Path,
    info: SourceInfo,
    margin: f64,
    tiling: &TilingParams,
    decide: D,
    output: &Path,
    spill_dir: &Path,
    params: &CopcWriterParams,
    cancel: &(dyn CancelCheck + Sync),
    on_progress: &mut dyn FnMut(ReadProgress),
    progress_base: u64,
    progress_total: u64,
    timings: &mut ConversionStageTimings,
) -> Result<Arc<Counters>, ThinFilterError>
where
    D: FnMut(&TileData, &TileRect) -> Vec<usize>,
{
    let tiles = tile_reader_for(source, tiling, margin)?;
    let extent = tiles.extent();
    let counters = Arc::new(Counters::default());
    let mut points = KeptPoints {
        tiles,
        extent,
        decide,
        cancel,
        on_progress,
        progress_base,
        progress_total,
        current: Vec::new().into_iter(),
        counters: Arc::clone(&counters),
        done: false,
    };

    // Take the first point before starting the writer; with none, fail without writing.
    let first = match points.next() {
        None => return Err(ThinFilterError::EmptyResult),
        Some(Err(e)) => return Err(ThinFilterError::Read(e)),
        Some(Ok(record)) => record,
    };
    let all_points = std::iter::once(Ok(first)).chain(points);

    let mut ingest = copc_writer::IngestStageTimings::default();
    let mut post = copc_writer::PostProcessStageTimings::default();
    write_streaming_with_cancel_and_timings(
        output,
        info.layout,
        all_points,
        params,
        &info.metadata,
        spill_dir,
        cancel,
        Some(&mut ingest),
        Some(&mut post),
    )
    .map_err(ThinFilterError::Write)?;
    *timings = ConversionStageTimings::from_parts(ingest, post);
    Ok(counters)
}

fn summary_from(
    counters: &Counters,
    extra: Option<&Counters>,
    sor: Option<SorSummary>,
) -> ThinFilterSummary {
    let add = |f: fn(&Counters) -> &AtomicU64| {
        Counters::get(f(counters)) + extra.map_or(0, |e| Counters::get(f(e)))
    };
    ThinFilterSummary {
        kept_points: Counters::get(&counters.kept),
        tile_count: add(|c| &c.tiles),
        points_scanned: add(|c| &c.scanned),
        core_points_read: add(|c| &c.core_read),
        largest_tile_points: Counters::get(&counters.largest_tile)
            .max(extra.map_or(0, |e| Counters::get(&e.largest_tile))),
        sor,
    }
}

/// Grid or voxel thinning of `source` into `output`.
///
/// - `on_progress`: called after each tile is read (see the module comment).
/// - `cancel`: checked before each tile and by the writer.
#[allow(clippy::too_many_arguments)]
pub fn thin_path<F>(
    source: &Path,
    settings: &ThinSettings,
    tiling: &TilingParams,
    output: &Path,
    spill_dir: &Path,
    params: &CopcWriterParams,
    cancel: &(dyn CancelCheck + Sync),
    mut on_progress: F,
    timings: &mut ConversionStageTimings,
) -> Result<ThinFilterSummary, ThinFilterError>
where
    F: FnMut(ReadProgress) + Send,
{
    settings.validate().map_err(ThinFilterError::Settings)?;
    let info = read_source_info(source)?;
    settings
        .check_coordinates(info.max_abs_coordinate)
        .map_err(ThinFilterError::Settings)?;
    let total = info.total_points;
    let mut decide = |tile: &TileData, extent: &TileRect| thin_tile(tile, extent, settings);
    let counters = write_pass(
        source,
        info,
        settings.margin(),
        tiling,
        &mut decide,
        output,
        spill_dir,
        params,
        cancel,
        &mut on_progress,
        0,
        total,
        timings,
    )?;
    Ok(summary_from(&counters, None, None))
}

/// ROR or SOR filtering of `source` into `output`. SOR reads the file twice.
#[allow(clippy::too_many_arguments)]
pub fn filter_path<F>(
    source: &Path,
    filter: &OutlierFilter,
    tiling: &TilingParams,
    output: &Path,
    spill_dir: &Path,
    params: &CopcWriterParams,
    cancel: &(dyn CancelCheck + Sync),
    mut on_progress: F,
    timings: &mut ConversionStageTimings,
) -> Result<ThinFilterSummary, ThinFilterError>
where
    F: FnMut(ReadProgress) + Send,
{
    match filter {
        OutlierFilter::Ror(settings) => {
            settings.validate().map_err(ThinFilterError::Settings)?;
            let info = read_source_info(source)?;
            let total = info.total_points;
            let mut decide = |tile: &TileData, _: &TileRect| ror_keep(&tile.points, settings);
            let counters = write_pass(
                source,
                info,
                settings.margin(),
                tiling,
                &mut decide,
                output,
                spill_dir,
                params,
                cancel,
                &mut on_progress,
                0,
                total,
                timings,
            )?;
            Ok(summary_from(&counters, None, None))
        }
        OutlierFilter::Sor(settings) => {
            settings.validate().map_err(ThinFilterError::Settings)?;
            let info = read_source_info(source)?;
            let total = info.total_points;
            // Pass 1: statistics only, nothing is written.
            let (stats, pass1) = sor_statistics(
                source,
                settings,
                tiling,
                cancel,
                &mut on_progress,
                total * 2,
            )?;
            let threshold = stats.threshold(settings.n_sigma);
            // Pass 2: recompute the same scores and write the points under the threshold.
            let mut decide =
                |tile: &TileData, _: &TileRect| sor_keep(&tile.points, settings, threshold);
            let pass2 = write_pass(
                source,
                info,
                settings.margin(),
                tiling,
                &mut decide,
                output,
                spill_dir,
                params,
                cancel,
                &mut on_progress,
                Counters::get(&pass1.core_read),
                total * 2,
                timings,
            )?;
            let sor = SorSummary {
                mean: stats.mean(),
                std: stats.std(),
                threshold,
            };
            Ok(summary_from(&pass2, Some(&pass1), Some(sor)))
        }
    }
}

/// SOR pass 1: the mean and std of the scores of all points.
fn sor_statistics(
    source: &Path,
    settings: &SorSettings,
    tiling: &TilingParams,
    cancel: &(dyn CancelCheck + Sync),
    on_progress: &mut dyn FnMut(ReadProgress),
    progress_total: u64,
) -> Result<(RunningStats, Counters), ThinFilterError> {
    let tiles = tile_reader_for(source, tiling, settings.margin())?;
    let counters = Counters::default();
    let mut stats = RunningStats::default();
    for tile in tiles {
        cancel.check().map_err(ThinFilterError::Read)?;
        let tile = tile.map_err(ThinFilterError::Read)?;
        counters.record_tile(&tile);
        sor_accumulate(&tile.points, settings, &mut stats);
        on_progress(ReadProgress {
            points_read: Counters::get(&counters.core_read),
            total_points: progress_total,
        });
    }
    Ok((stats, counters))
}
