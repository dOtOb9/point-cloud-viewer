//! M4-17: several files of any format (LAS/LAZ/PLY/PCD/E57) into one COPC.
//!
//! This is used when the selection contains at least one PLY/PCD/E57 file. A selection of
//! only LAS/LAZ files keeps using `crate::merge` (it keeps classification, GPS time, return
//! numbers; this route cannot, because `RawPoint` has only x, y, z, color, intensity).
//!
//! How it works:
//!
//! 1. Header pass: every file is opened once, only far enough to read `has_color`, the
//!    declared point count and (LAS/LAZ) the CRS. Nothing is decoded.
//! 2. The CRS rule is checked here, before any point is written.
//! 3. `MergedSource` is one `PointSource` that opens the files one after another (sorted by
//!    path) and passes their points to `run_import`, which streams them into one spill.
//!    Only one file is open at a time, so memory does not depend on the point count.
//!
//! Colors: if any input has color, the output has color, and points from files without
//! color get mid gray. This is done here, per file, not in the readers.

use std::fs::File;
use std::io::BufReader;
use std::path::{Path, PathBuf};

use copc_core::CancelCheck;
use copc_writer::CopcWriterParams;
use pcv_core::crs::CrsId;

use super::las::LasSource;
use super::point::{PointSource, RawPoint};
use super::{convert, detect_format, e57, pcd, ply, ImportError, ImportSummary, SourceFormat};
use crate::stage_timings::ConversionStageTimings;
use crate::streaming::ReadProgress;

/// 16-bit mid gray for points of files that have no color, when other files do.
const GRAY: [u16; 3] = [32768, 32768, 32768];

/// Warning when LAS/LAZ is mixed with other formats (the text is fixed by the task sheet,
/// and the Web build uses the same text).
pub const LAS_ATTRIBUTES_DROPPED_WARNING: &str =
    "LAS/LAZ と他の形式を結合したため、LAS/LAZ の分類・GPS時刻・リターン番号などの属性は出力に含まれません";

/// Warning when the output has a CRS and some points come from CRS-less formats.
pub const NON_LAS_SAME_CRS_WARNING: &str =
    "PLY/PCD/E57 の点は LAS/LAZ と同じ座標系として結合しました";

/// The result of a point merge.
#[derive(Debug, Clone)]
pub struct PointMergeSummary {
    pub import: ImportSummary,
    /// Texts for the on-screen error log (ADR-0011).
    pub warnings: Vec<String>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum FileKind {
    Las,
    Other(SourceFormat),
}

/// What the header pass learned about one input file.
struct FileEntry {
    path: PathBuf,
    kind: FileKind,
    has_color: bool,
}

/// `true` for `.las` / `.laz` (case-insensitive). The routing in `src-tauri` uses this too.
pub fn is_las_or_laz(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("las") || e.eq_ignore_ascii_case("laz"))
}

/// Merges `paths` (any mix of LAS/LAZ/PLY/PCD/E57) into the COPC `output`.
/// The files are read in sorted path order, whatever order `paths` has.
pub fn convert_paths_to_copc_and_timings(
    paths: &[PathBuf],
    output: &Path,
    spill_dir: &Path,
    params: &CopcWriterParams,
    cancel: &(dyn CancelCheck + Sync),
    on_progress: impl FnMut(ReadProgress),
    timings: &mut ConversionStageTimings,
) -> Result<PointMergeSummary, ImportError> {
    let mut sorted: Vec<PathBuf> = paths.to_vec();
    sorted.sort();
    if sorted.is_empty() {
        return Err(ImportError::Merge("入力ファイルが1つも無い".to_string()));
    }

    let header = read_headers(&sorted)?;

    let mut warnings = Vec::new();
    if header.has_las && header.has_other {
        warnings.push(LAS_ATTRIBUTES_DROPPED_WARNING.to_string());
    }
    if header.wkt_crs.is_some() && header.has_other {
        warnings.push(NON_LAS_SAME_CRS_WARNING.to_string());
    }

    let source = MergedSource {
        output_has_color: header.files.iter().any(|f| f.has_color),
        declared_points: header.declared_points,
        files: header.files,
    };
    let import = convert::run_import(
        source,
        output,
        spill_dir,
        params,
        cancel,
        header.wkt_crs,
        on_progress,
        timings,
    )?;
    Ok(PointMergeSummary { import, warnings })
}

/// Result of the header pass.
struct HeaderPass {
    files: Vec<FileEntry>,
    declared_points: u64,
    has_las: bool,
    has_other: bool,
    /// WKT of the agreed CRS of the LAS/LAZ inputs. `None` when none of them has a CRS.
    wkt_crs: Option<String>,
}

/// Opens every file once (header only). Fails on the first unreadable file or CRS conflict.
fn read_headers(sorted: &[PathBuf]) -> Result<HeaderPass, ImportError> {
    let mut pass = HeaderPass {
        files: Vec::with_capacity(sorted.len()),
        declared_points: 0,
        has_las: false,
        has_other: false,
        wkt_crs: None,
    };
    // The first LAS/LAZ file that has a CRS: later ones must agree with it.
    let mut crs_owner: Option<(PathBuf, CrsId)> = None;

    for path in sorted {
        let (kind, has_color, declared) = if is_las_or_laz(path) {
            let las = LasSource::open(path)?;
            check_crs(path, &las.crs, &mut crs_owner)?;
            if pass.wkt_crs.is_none() && !las.crs.is_missing() {
                pass.wkt_crs = las.wkt_crs.clone();
            }
            pass.has_las = true;
            (FileKind::Las, las.has_color(), las.declared_point_count())
        } else {
            let format = detect_format(path).ok_or_else(|| {
                ImportError::UnknownFormat(
                    path.extension()
                        .and_then(|e| e.to_str())
                        .unwrap_or("(拡張子無し)")
                        .to_string(),
                )
            })?;
            let (has_color, declared) = peek_other(path, format)?;
            pass.has_other = true;
            (FileKind::Other(format), has_color, declared)
        };
        pass.declared_points += declared;
        pass.files.push(FileEntry {
            path: path.clone(),
            kind,
            has_color,
        });
    }
    Ok(pass)
}

/// LAS/LAZ files whose CRS is unknown count as agreeing (same as `crate::merge`).
/// Two known CRSs must be equal.
fn check_crs(
    path: &Path,
    crs: &CrsId,
    owner: &mut Option<(PathBuf, CrsId)>,
) -> Result<(), ImportError> {
    if crs.is_missing() {
        return Ok(());
    }
    match owner {
        None => *owner = Some((path.to_path_buf(), crs.clone())),
        Some((first, expected)) if expected != crs => {
            return Err(ImportError::Merge(format!(
                "{}: CRSが先頭のCRSありファイル({})と異なる({:?} != {:?})。\
                 結合するLAS/LAZは全て同じ座標系である必要がある",
                path.display(),
                first.display(),
                crs,
                expected
            )));
        }
        Some(_) => {}
    }
    Ok(())
}

/// Opens a PLY/PCD/E57 file only to read `has_color` and the declared point count.
fn peek_other(path: &Path, format: SourceFormat) -> Result<(bool, u64), ImportError> {
    let reader = BufReader::new(open_file(path)?);
    Ok(match format {
        SourceFormat::E57 => {
            let s = e57::E57Source::open(reader)?;
            (s.has_color(), s.declared_point_count())
        }
        SourceFormat::Ply => {
            let s = ply::PlySource::open(reader)?;
            (s.has_color(), s.declared_point_count())
        }
        SourceFormat::Pcd => {
            let s = pcd::PcdSource::open(reader)?;
            (s.has_color(), s.declared_point_count())
        }
    })
}

fn open_file(path: &Path) -> Result<File, ImportError> {
    File::open(path)
        .map_err(|e| ImportError::Merge(format!("{}: 開けなかった: {e}", path.display())))
}

/// One `PointSource` over all the files. It holds only the list of files (a few bytes per
/// file); each file is opened when its turn comes and dropped when it is finished.
struct MergedSource {
    files: Vec<FileEntry>,
    declared_points: u64,
    output_has_color: bool,
}

impl PointSource for MergedSource {
    fn has_color(&self) -> bool {
        self.output_has_color
    }

    fn declared_point_count(&self) -> u64 {
        self.declared_points
    }

    fn for_each_point(
        self,
        visit: &mut dyn FnMut(RawPoint) -> Result<(), ImportError>,
    ) -> Result<(), ImportError> {
        for entry in &self.files {
            let fill_gray = self.output_has_color && !entry.has_color;
            let mut visit_file = |mut point: RawPoint| -> Result<(), ImportError> {
                if fill_gray {
                    point.color = GRAY;
                }
                visit(point)
            };
            stream_file(entry, &mut visit_file)?;
        }
        Ok(())
    }
}

/// Opens one file and passes all its points to `visit`.
fn stream_file(
    entry: &FileEntry,
    visit: &mut dyn FnMut(RawPoint) -> Result<(), ImportError>,
) -> Result<(), ImportError> {
    match entry.kind {
        FileKind::Las => LasSource::open(&entry.path)?.for_each_point(visit),
        FileKind::Other(format) => {
            let reader = BufReader::new(open_file(&entry.path)?);
            match format {
                SourceFormat::E57 => e57::E57Source::open(reader)?.for_each_point(visit),
                SourceFormat::Ply => ply::PlySource::open(reader)?.for_each_point(visit),
                SourceFormat::Pcd => pcd::PcdSource::open(reader)?.for_each_point(visit),
            }
        }
    }
}
