pub mod color;
pub mod geotiff;
pub mod grid;
pub mod output;
pub mod preview;

pub use output::{RasterOptions, TiffKind};

pub use grid::{CellAccumulator, ClassFilter, GridSpec, RasterValue, NODATA};

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
    #[error("このレイヤーは色を持たないため、色(RGB)のラスタは作れません")]
    NoColor,
    #[error("ラスタにできる点がありません")]
    NoPoints,
}
