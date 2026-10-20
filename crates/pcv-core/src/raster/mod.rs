//! G1: rasterising a point cloud (grid + accumulators) and writing GeoTIFF files.
//!
//! - `grid`: the cell grid and the per-cell accumulators (G1-1).
//! - `geotiff`: a small hand-written GeoTIFF writer (G1-2).
//!
//! Everything here is pure (no files, no Tauri) and builds for wasm32. Reading the
//! points out of a COPC file is `crate::extract::ExtractPoints::all`.

pub mod geotiff;
pub mod grid;

pub use grid::{CellAccumulator, ClassFilter, GridSpec, RasterValue, NODATA};

/// Errors of the raster code. The texts are shown on screen as they are.
#[derive(Debug, thiserror::Error)]
pub enum RasterError {
    #[error("{0}")]
    InvalidArgument(String),
    #[error(
        "ラスタが大きすぎます（{cols}列 x {rows}行、上限は{max_cells}セル）。\
         セルの大きさを大きくするか、先に範囲を切り出してから実行してください"
    )]
    TooManyCells {
        cols: f64,
        rows: f64,
        max_cells: u64,
    },
    #[error("GeoTIFFが大きすぎます（古い形式のTIFFは4GBまで）。セルの大きさを大きくするか、範囲を切り出してください")]
    TooLargeForTiff,
    #[error("画素の数が合いません（期待 {expected}、実際 {actual}）")]
    SampleCountMismatch { expected: u64, actual: u64 },
    #[error("GeoTIFFを書き出せませんでした: {0}")]
    Io(#[from] std::io::Error),
}
