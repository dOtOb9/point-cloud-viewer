mod convert;
pub mod e57;
mod las;
pub mod merge;
pub mod pcd;
pub mod ply;
mod point;
mod scale;

use std::io::{Read, Seek};
use std::path::Path;

use copc_core::CancelCheck;
use copc_writer::CopcWriterParams;

use crate::stage_timings::ConversionStageTimings;
use crate::streaming::ReadProgress;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceFormat {
    E57,
    Ply,
    Pcd,
}

pub fn detect_format(path: &Path) -> Option<SourceFormat> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    match ext.as_str() {
        "e57" => Some(SourceFormat::E57),
        "ply" => Some(SourceFormat::Ply),
        "pcd" => Some(SourceFormat::Pcd),
        _ => None,
    }
}

#[derive(Debug, Clone)]
pub struct ImportSummary {
    pub point_count: u64,
    pub crs_known: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum ImportError {
    #[error("対応していない拡張子: {0}")]
    UnknownFormat(String),
    #[error("E57の読み込みに失敗した: {0}")]
    E57(#[from] ::e57::Error),
    #[error("PLYの読み込みに失敗した: {0}")]
    Ply(#[from] ply::PlyError),
    #[error("PCDの読み込みに失敗した: {0}")]
    Pcd(#[from] pcd::PcdError),
    #[error("{0}")]
    Copc(#[from] copc_core::Error),
    #[error("{0}")]
    Merge(String),
}

impl From<ImportError> for copc_core::Error {
    fn from(err: ImportError) -> Self {
        match err {
            ImportError::Copc(e) => e,
            other => copc_core::Error::InvalidInput(other.to_string()),
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub fn convert_to_copc<R>(
    source: R,
    format: SourceFormat,
    output: &Path,
    spill_dir: &Path,
    params: &CopcWriterParams,
    cancel: &(dyn CancelCheck + Sync),
    crs_wkt: Option<String>,
    on_progress: impl FnMut(ReadProgress),
) -> Result<ImportSummary, ImportError>
where
    R: Read + Seek + Send + Sync + 'static,
{
    let mut discarded = ConversionStageTimings::default();
    convert_to_copc_and_timings(
        source,
        format,
        output,
        spill_dir,
        params,
        cancel,
        crs_wkt,
        on_progress,
        &mut discarded,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn convert_to_copc_and_timings<R>(
    source: R,
    format: SourceFormat,
    output: &Path,
    spill_dir: &Path,
    params: &CopcWriterParams,
    cancel: &(dyn CancelCheck + Sync),
    crs_wkt: Option<String>,
    on_progress: impl FnMut(ReadProgress),
    timings: &mut ConversionStageTimings,
) -> Result<ImportSummary, ImportError>
where
    R: Read + Seek + Send + Sync + 'static,
{
    let buffered = std::io::BufReader::new(source);
    match format {
        SourceFormat::E57 => convert::run_import(
            e57::E57Source::open(buffered)?,
            output,
            spill_dir,
            params,
            cancel,
            crs_wkt,
            on_progress,
            timings,
        ),
        SourceFormat::Ply => convert::run_import(
            ply::PlySource::open(buffered)?,
            output,
            spill_dir,
            params,
            cancel,
            crs_wkt,
            on_progress,
            timings,
        ),
        SourceFormat::Pcd => convert::run_import(
            pcd::PcdSource::open(buffered)?,
            output,
            spill_dir,
            params,
            cancel,
            crs_wkt,
            on_progress,
            timings,
        ),
    }
}

#[allow(clippy::too_many_arguments)]
pub fn convert_path_to_copc(
    input: &Path,
    output: &Path,
    spill_dir: &Path,
    params: &CopcWriterParams,
    cancel: &(dyn CancelCheck + Sync),
    crs_wkt: Option<String>,
    on_progress: impl FnMut(ReadProgress),
) -> Result<ImportSummary, ImportError> {
    let mut discarded = ConversionStageTimings::default();
    convert_path_to_copc_and_timings(
        input,
        output,
        spill_dir,
        params,
        cancel,
        crs_wkt,
        on_progress,
        &mut discarded,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn convert_path_to_copc_and_timings(
    input: &Path,
    output: &Path,
    spill_dir: &Path,
    params: &CopcWriterParams,
    cancel: &(dyn CancelCheck + Sync),
    crs_wkt: Option<String>,
    on_progress: impl FnMut(ReadProgress),
    timings: &mut ConversionStageTimings,
) -> Result<ImportSummary, ImportError> {
    let format = detect_format(input).ok_or_else(|| {
        ImportError::UnknownFormat(
            input
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("(拡張子無し)")
                .to_string(),
        )
    })?;
    let file = std::fs::File::open(input)
        .map_err(|e| ImportError::Copc(copc_core::Error::io("open source E57/PLY/PCD", e)))?;
    convert_to_copc_and_timings(
        file,
        format,
        output,
        spill_dir,
        params,
        cancel,
        crs_wkt,
        on_progress,
        timings,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn detect_format_by_extension() {
        assert_eq!(
            detect_format(&PathBuf::from("scan.e57")),
            Some(SourceFormat::E57)
        );
        assert_eq!(
            detect_format(&PathBuf::from("SCAN.E57")),
            Some(SourceFormat::E57)
        );
        assert_eq!(
            detect_format(&PathBuf::from("mesh.ply")),
            Some(SourceFormat::Ply)
        );
        assert_eq!(
            detect_format(&PathBuf::from("cloud.pcd")),
            Some(SourceFormat::Pcd)
        );
        assert_eq!(detect_format(&PathBuf::from("raw.las")), None);
        assert_eq!(detect_format(&PathBuf::from("raw.laz")), None);
        assert_eq!(detect_format(&PathBuf::from("no_extension")), None);
    }

    #[test]
    fn convert_path_to_copc_rejects_unknown_extension() {
        let err = convert_path_to_copc(
            Path::new("unknown.xyz"),
            Path::new("out.copc.laz"),
            Path::new("."),
            &CopcWriterParams::default(),
            &copc_core::NeverCancel,
            None,
            |_| {},
        )
        .unwrap_err();
        assert!(matches!(err, ImportError::UnknownFormat(ext) if ext == "xyz"));
    }
}
