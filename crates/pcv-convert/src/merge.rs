use std::collections::VecDeque;
use std::io;
use std::path::{Path, PathBuf};

use copc_core::{CancelCheck, LasPointRecord, StreamingLayout};
use copc_writer::{write_streaming_with_cancel_and_timings, CopcWriteMetadata, CopcWriterParams};
use pcv_core::crs::{crs_id_from_las_header, CrsId};

use crate::stage_timings::ConversionStageTimings;
use crate::streaming::{ReadProgress, PROGRESS_REPORT_STRIDE};
use crate::write_metadata::copc_write_metadata_from_source_header;

#[derive(Debug, thiserror::Error)]
pub enum MergeError {
    #[error("入力ファイルが1つも見つからない: {0}")]
    NoInputFiles(String),
    #[error("ディレクトリを読み取れなかった: {0}")]
    ReadDir(#[source] io::Error),
    #[error("globパターンが不正: {0}")]
    GlobPattern(#[source] glob::PatternError),
    #[error("globの列挙中にエラー: {0}")]
    GlobIter(#[source] glob::GlobError),
    #[error("{path}: LASヘッダーを開けなかった: {source}")]
    OpenHeader {
        path: PathBuf,
        #[source]
        source: las::Error,
    },
    #[error(
        "{path}: 点のレイアウトが先頭ファイル({first})と異なる({got:?} != {expected:?})。\
         このツールは全入力が同じpoint format/属性構成であることを前提にしている"
    )]
    LayoutMismatch {
        path: PathBuf,
        first: PathBuf,
        got: Box<StreamingLayout>,
        expected: Box<StreamingLayout>,
    },
    #[error(
        "{path}: CRSが先頭ファイル({first})と異なる({got:?} != {expected:?})。\
         このツールは全入力が同じ座標系であることを前提にしている"
    )]
    CrsMismatch {
        path: PathBuf,
        first: PathBuf,
        got: Box<CrsId>,
        expected: Box<CrsId>,
    },
    #[error("COPC書き出しに失敗した: {0}")]
    Write(#[source] copc_core::Error),
}

pub enum InputSpec<'a> {
    Directory(&'a Path),
    Glob(&'a str),
}

pub fn input_spec(input: &str) -> InputSpec<'_> {
    let path = Path::new(input);
    if path.is_dir() {
        InputSpec::Directory(path)
    } else {
        InputSpec::Glob(input)
    }
}

pub fn collect_input_paths(input: &str) -> Result<Vec<PathBuf>, MergeError> {
    let mut paths: Vec<PathBuf> = match input_spec(input) {
        InputSpec::Directory(dir) => {
            let mut found = Vec::new();
            for entry in std::fs::read_dir(dir).map_err(MergeError::ReadDir)? {
                let entry = entry.map_err(MergeError::ReadDir)?;
                let path = entry.path();
                let is_las_or_laz =
                    path.extension()
                        .and_then(|ext| ext.to_str())
                        .is_some_and(|ext| {
                            ext.eq_ignore_ascii_case("las") || ext.eq_ignore_ascii_case("laz")
                        });
                if is_las_or_laz {
                    found.push(path);
                }
            }
            found
        }
        InputSpec::Glob(pattern) => {
            let mut found = Vec::new();
            for entry in glob::glob(pattern).map_err(MergeError::GlobPattern)? {
                found.push(entry.map_err(MergeError::GlobIter)?);
            }
            found
        }
    };
    paths.sort();
    if paths.is_empty() {
        return Err(MergeError::NoInputFiles(input.to_string()));
    }
    Ok(paths)
}

pub struct HeaderSummary {
    pub layout: StreamingLayout,
    pub declared_points_total: u64,
    pub metadata: CopcWriteMetadata,
    pub crs: CrsId,
    pub assumed_crs_paths: Vec<PathBuf>,
    pub missing_crs_paths: Vec<PathBuf>,
}

impl HeaderSummary {
    pub fn crs_warnings(&self) -> Vec<String> {
        let result = if self.crs.is_missing() {
            "どのファイルにもCRSが無いので、結果にもCRSはありません"
        } else {
            "結果のCRSはCRSのあるファイルのものにしました"
        };
        self.missing_crs_paths
            .iter()
            .map(|path| {
                let name = path
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| path.display().to_string());
                format!(
                    "{name}: CRS(座標系)の情報がありません。他のファイルと同じ座標系とみなして結合しました({result})"
                )
            })
            .collect()
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum MissingCrs {
    Reject,
    AssumeFirst,
    Allow,
}

pub fn summarize_headers(paths: &[PathBuf]) -> Result<HeaderSummary, MergeError> {
    summarize_headers_with_options(paths, false)
}

pub fn summarize_headers_lenient(paths: &[PathBuf]) -> Result<HeaderSummary, MergeError> {
    summarize_headers_inner(paths, MissingCrs::Allow)
}

pub fn summarize_headers_with_options(
    paths: &[PathBuf],
    assume_missing_crs_is_first: bool,
) -> Result<HeaderSummary, MergeError> {
    let mode = if assume_missing_crs_is_first {
        MissingCrs::AssumeFirst
    } else {
        MissingCrs::Reject
    };
    summarize_headers_inner(paths, mode)
}

fn summarize_headers_inner(
    paths: &[PathBuf],
    mode: MissingCrs,
) -> Result<HeaderSummary, MergeError> {
    let mut assumed_crs_paths: Vec<PathBuf> = Vec::new();
    let mut missing_crs_paths: Vec<PathBuf> = Vec::new();
    let mut layout: Option<StreamingLayout> = None;
    let mut crs: Option<CrsId> = None;
    let mut crs_source: Option<PathBuf> = None;
    let mut declared_points_total: u64 = 0u64;
    let mut metadata: Option<CopcWriteMetadata> = None;

    for path in paths {
        let reader = las::Reader::from_path(path).map_err(|source| MergeError::OpenHeader {
            path: path.clone(),
            source,
        })?;
        let header = reader.header();
        let this_layout = StreamingLayout::from_las_header(header);
        let this_crs = crs_id_from_las_header(header);
        if mode == MissingCrs::Allow && this_crs.is_missing() {
            missing_crs_paths.push(path.clone());
        }
        match (&layout, crs.clone(), metadata.as_mut()) {
            (Some(expected_layout), Some(expected_crs), Some(metadata)) => {
                if expected_layout != &this_layout {
                    return Err(MergeError::LayoutMismatch {
                        path: path.clone(),
                        first: paths[0].clone(),
                        got: Box::new(this_layout),
                        expected: Box::new(expected_layout.clone()),
                    });
                }
                if mode == MissingCrs::AssumeFirst
                    && this_crs.is_missing()
                    && !expected_crs.is_missing()
                {
                    assumed_crs_paths.push(path.clone());
                } else if mode == MissingCrs::Allow && this_crs.is_missing() {
                } else if mode == MissingCrs::Allow && expected_crs.is_missing() {
                    crs = Some(this_crs);
                    crs_source = Some(path.clone());
                    metadata.wkt_crs = copc_write_metadata_from_source_header(header).wkt_crs;
                } else if expected_crs != this_crs {
                    return Err(MergeError::CrsMismatch {
                        path: path.clone(),
                        first: crs_source.clone().unwrap_or_else(|| paths[0].clone()),
                        got: Box::new(this_crs),
                        expected: Box::new(expected_crs),
                    });
                }
            }
            _ => {
                layout = Some(this_layout);
                crs = Some(this_crs);
                crs_source = Some(path.clone());
                metadata = Some(copc_write_metadata_from_source_header(header));
            }
        }
        declared_points_total += header.number_of_points();
    }

    let (Some(layout), Some(crs), Some(metadata)) = (layout, crs, metadata) else {
        return Err(MergeError::NoInputFiles("(入力が空)".to_string()));
    };
    Ok(HeaderSummary {
        layout,
        declared_points_total,
        metadata,
        crs,
        assumed_crs_paths,
        missing_crs_paths,
    })
}

const READ_BATCH_SIZE: u64 = 1024 * 1024;

struct CurrentFile {
    reader: las::Reader,
    point_data: las::PointData,
    batch: VecDeque<las::Result<las::Point>>,
    exhausted: bool,
}

fn no_op_progress(_: ReadProgress) {}

pub struct MultiFileLasPoints<F: FnMut(ReadProgress) = fn(ReadProgress)> {
    pending: VecDeque<PathBuf>,
    current: Option<CurrentFile>,
    files_total: usize,
    files_opened: usize,
    points_read: u64,
    declared_points_total: u64,
    on_progress: F,
}

impl MultiFileLasPoints<fn(ReadProgress)> {
    pub fn new(paths: Vec<PathBuf>, declared_points_total: u64) -> Self {
        Self::with_progress(paths, declared_points_total, no_op_progress)
    }
}

impl<F: FnMut(ReadProgress)> MultiFileLasPoints<F> {
    pub fn with_progress(paths: Vec<PathBuf>, declared_points_total: u64, on_progress: F) -> Self {
        Self {
            files_total: paths.len(),
            pending: paths.into(),
            current: None,
            files_opened: 0,
            points_read: 0,
            declared_points_total,
            on_progress,
        }
    }

    fn open_next(&mut self) -> Option<copc_core::Result<()>> {
        let path = self.pending.pop_front()?;
        match las::Reader::from_path(&path) {
            Ok(reader) => {
                self.files_opened += 1;
                println!(
                    "  読み込み中 ({}/{}): {}",
                    self.files_opened,
                    self.files_total,
                    path.display()
                );
                let point_data = las::PointDataBuilder::new()
                    .for_header(reader.header())
                    .build();
                self.current = Some(CurrentFile {
                    reader,
                    point_data,
                    batch: VecDeque::new(),
                    exhausted: false,
                });
                Some(Ok(()))
            }
            Err(e) => Some(Err(copc_core::Error::Las(format!(
                "{}: {e}",
                path.display()
            )))),
        }
    }

    pub fn points_read(&self) -> u64 {
        self.points_read
    }

    pub fn declared_points_total(&self) -> u64 {
        self.declared_points_total
    }
}

impl<F: FnMut(ReadProgress)> Iterator for MultiFileLasPoints<F> {
    type Item = copc_core::Result<LasPointRecord>;

    fn next(&mut self) -> Option<Self::Item> {
        loop {
            if self.current.is_none() {
                match self.open_next() {
                    None => return None,
                    Some(Err(e)) => return Some(Err(e)),
                    Some(Ok(())) => {}
                }
            }
            let current = self.current.as_mut().expect("直前にSome(Ok(()))を確認した");
            if let Some(result) = current.batch.pop_front() {
                self.points_read += 1;
                if self.points_read.is_multiple_of(PROGRESS_REPORT_STRIDE)
                    || self.points_read == self.declared_points_total
                {
                    (self.on_progress)(ReadProgress {
                        points_read: self.points_read,
                        total_points: self.declared_points_total,
                    });
                }
                return Some(
                    result
                        .map(|point| LasPointRecord::from_las_point(&point))
                        .map_err(|e| copc_core::Error::Las(e.to_string())),
                );
            }
            if current.exhausted {
                self.current = None;
                continue;
            }
            match current
                .reader
                .fill_points(READ_BATCH_SIZE, &mut current.point_data)
            {
                Ok(0) => current.exhausted = true,
                Ok(_) => current.batch = current.point_data.points().collect(),
                Err(e) => {
                    current.exhausted = true;
                    return Some(Err(copc_core::Error::Las(e.to_string())));
                }
            }
        }
    }
}

pub fn merge_paths_and_timings<F>(
    paths: Vec<PathBuf>,
    output: &Path,
    spill_dir: &Path,
    params: &CopcWriterParams,
    cancel: &(dyn CancelCheck + Sync),
    on_progress: F,
    timings: &mut ConversionStageTimings,
) -> Result<HeaderSummary, MergeError>
where
    F: FnMut(ReadProgress),
{
    let summary = summarize_headers_lenient(&paths)?;
    let points =
        MultiFileLasPoints::with_progress(paths, summary.declared_points_total, on_progress);

    let mut ingest = copc_writer::IngestStageTimings::default();
    let mut post = copc_writer::PostProcessStageTimings::default();
    write_streaming_with_cancel_and_timings(
        output,
        summary.layout.clone(),
        points,
        params,
        &summary.metadata,
        spill_dir,
        cancel,
        Some(&mut ingest),
        Some(&mut post),
    )
    .map_err(MergeError::Write)?;
    *timings = ConversionStageTimings::from_parts(ingest, post);
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;

    use copc_core::NeverCancel;
    use copc_writer::{write_streaming_with_cancel_and_timings, CopcWriterParams};
    use pcv_core::CopcFile;

    fn write_single_point_las(path: &Path, x: f64, y: f64, z: f64, color: [u16; 3]) {
        let mut builder = las::Builder::from((1, 2));
        builder.point_format = las::point::Format::new(3).expect("PDRF3は存在する");
        builder.transforms = las::Vector {
            x: las::Transform {
                scale: 0.001,
                offset: 0.0,
            },
            y: las::Transform {
                scale: 0.001,
                offset: 0.0,
            },
            z: las::Transform {
                scale: 0.001,
                offset: 0.0,
            },
        };
        let header = builder.into_header().expect("valid header");
        let file = std::fs::File::create(path).expect("create las");
        let mut writer =
            las::Writer::new(std::io::BufWriter::new(file), header).expect("las writer");
        let point = las::Point {
            x,
            y,
            z,
            gps_time: Some(0.0),
            color: Some(las::Color {
                red: color[0],
                green: color[1],
                blue: color[2],
            }),
            ..Default::default()
        };
        writer.write_point(point).expect("write point");
        writer.close().expect("close las writer");
    }

    fn write_multi_point_las(path: &Path, points: &[(f64, f64, f64)]) {
        let mut builder = las::Builder::from((1, 2));
        builder.point_format = las::point::Format::new(3).expect("PDRF3は存在する");
        builder.transforms = las::Vector {
            x: las::Transform {
                scale: 0.001,
                offset: 0.0,
            },
            y: las::Transform {
                scale: 0.001,
                offset: 0.0,
            },
            z: las::Transform {
                scale: 0.001,
                offset: 0.0,
            },
        };
        let header = builder.into_header().expect("valid header");
        let file = std::fs::File::create(path).expect("create las");
        let mut writer =
            las::Writer::new(std::io::BufWriter::new(file), header).expect("las writer");
        for &(x, y, z) in points {
            let point = las::Point {
                x,
                y,
                z,
                gps_time: Some(0.0),
                color: Some(las::Color {
                    red: 1000,
                    green: 2000,
                    blue: 3000,
                }),
                ..Default::default()
            };
            writer.write_point(point).expect("write point");
        }
        writer.close().expect("close las writer");
    }

    #[test]
    fn collect_input_paths_sorts_and_filters_by_extension() {
        let dir = tempfile::tempdir().expect("tempdir");
        for name in ["b.las", "a.las", "c.laz", "ignore.txt"] {
            std::fs::File::create(dir.path().join(name)).expect("create");
        }
        let paths = collect_input_paths(dir.path().to_str().expect("utf8 path")).expect("collect");
        let names: Vec<_> = paths
            .iter()
            .map(|p| p.file_name().unwrap().to_str().unwrap().to_string())
            .collect();
        assert_eq!(names, vec!["a.las", "b.las", "c.laz"]);
    }

    #[test]
    fn collect_input_paths_errors_when_nothing_matches() {
        let dir = tempfile::tempdir().expect("tempdir");
        let err = collect_input_paths(dir.path().to_str().expect("utf8 path"));
        assert!(matches!(err, Err(MergeError::NoInputFiles(_))));
    }

    #[test]
    fn merging_three_small_files_yields_correct_count_bounds_and_points() {
        let dir = tempfile::tempdir().expect("tempdir");

        write_single_point_las(&dir.path().join("tile-0.las"), 0.0, 0.0, 0.0, [100, 0, 0]);
        write_single_point_las(&dir.path().join("tile-1.las"), 400.0, 0.0, 1.0, [0, 200, 0]);
        write_single_point_las(&dir.path().join("tile-2.las"), 0.0, 300.0, 2.0, [0, 0, 300]);

        let paths = collect_input_paths(dir.path().to_str().expect("utf8 path")).expect("collect");
        assert_eq!(paths.len(), 3);

        let summary = summarize_headers(&paths).expect("summarize");
        assert_eq!(summary.declared_points_total, 3);

        let output = dir.path().join("merged.copc.laz");
        let spill_dir = tempfile::tempdir().expect("spill tempdir");
        let points = MultiFileLasPoints::new(paths, summary.declared_points_total);
        let params = CopcWriterParams::new(100_000);
        write_streaming_with_cancel_and_timings(
            &output,
            summary.layout,
            points,
            &params,
            &summary.metadata,
            spill_dir.path(),
            &NeverCancel,
            None,
            None,
        )
        .expect("write merged copc");

        let mut file = CopcFile::open(&output).expect("open merged copc");
        assert_eq!(file.info().point_count, 3);

        let min = file.info().min;
        let max = file.info().max;
        assert_eq!(min, [0.0, 0.0, 0.0]);
        assert_eq!(max, [400.0, 300.0, 2.0]);

        let hierarchy_sum: u64 = file
            .hierarchy()
            .nodes()
            .map(|n| u64::from(n.point_count))
            .sum();
        assert_eq!(hierarchy_sum, 3);

        let mut keys: Vec<_> = file
            .hierarchy()
            .nodes()
            .map(|n| (n.key, n.point_count))
            .collect();
        keys.sort_by_key(|(key, _)| (key.level, key.x, key.y, key.z));
        let mut read_points_total = 0u32;
        for (key, declared_count) in &keys {
            let buffer = file.read_node(*key).expect("read_node");
            assert_eq!(buffer.point_count, *declared_count);
            read_points_total += buffer.point_count;
        }
        assert_eq!(read_points_total, 3);
    }

    #[test]
    fn merging_rejects_mismatched_layouts() {
        let dir = tempfile::tempdir().expect("tempdir");
        write_single_point_las(&dir.path().join("a.las"), 0.0, 0.0, 0.0, [1, 1, 1]);

        let mut builder = las::Builder::from((1, 2));
        builder.point_format = las::point::Format::new(0).expect("PDRF0は存在する");
        let header = builder.into_header().expect("valid header");
        let file = std::fs::File::create(dir.path().join("b.las")).expect("create las");
        let mut writer = las::Writer::new(std::io::BufWriter::new(file), header).expect("writer");
        writer
            .write_point(las::Point::default())
            .expect("write point");
        writer.close().expect("close");

        let paths = collect_input_paths(dir.path().to_str().expect("utf8 path")).expect("collect");
        let err = summarize_headers(&paths);
        assert!(matches!(err, Err(MergeError::LayoutMismatch { .. })));
    }

    #[test]
    fn multi_file_points_iterator_yields_points_from_every_input_in_order() {
        let dir = tempfile::tempdir().expect("tempdir");
        write_multi_point_las(
            &dir.path().join("a.las"),
            &[(0.0, 0.0, 0.0), (1.0, 1.0, 1.0)],
        );
        write_multi_point_las(&dir.path().join("b.las"), &[(2.0, 2.0, 2.0)]);

        let paths = collect_input_paths(dir.path().to_str().expect("utf8 path")).expect("collect");
        let mut iter = MultiFileLasPoints::new(paths, 3);
        let mut xs = Vec::new();
        for item in &mut iter {
            xs.push(item.expect("point").x);
        }
        assert_eq!(xs, vec![0.0, 1.0, 2.0]);
        assert_eq!(iter.points_read(), 3);
    }

    fn geo_key_directory_with_one_projected_crs_key(epsg: u16) -> Vec<u8> {
        let key_directory_version = 1u16;
        let key_revision = 1u16;
        let minor_revision = 1u16;
        let number_of_keys = 1u16;
        let projected_crs_geo_key = 3072u16;
        let value_stored_inline = 0u16;
        let value_count = 1u16;
        [
            key_directory_version,
            key_revision,
            minor_revision,
            number_of_keys,
            projected_crs_geo_key,
            value_stored_inline,
            value_count,
            epsg,
        ]
        .iter()
        .flat_map(|value| value.to_le_bytes())
        .collect()
    }

    fn write_single_point_las_with_geotiff_crs(path: &Path, epsg: u16) {
        let mut builder = las::Builder::from((1, 2));
        builder.point_format = las::point::Format::new(3).expect("PDRF3は存在する");
        let data = geo_key_directory_with_one_projected_crs_key(epsg);
        builder.vlrs.push(las::Vlr {
            user_id: "LASF_Projection".to_string(),
            record_id: 34735,
            description: String::new(),
            data,
        });
        let header = builder.into_header().expect("valid header");
        let file = std::fs::File::create(path).expect("create las");
        let mut writer =
            las::Writer::new(std::io::BufWriter::new(file), header).expect("las writer");
        writer
            .write_point(las::Point {
                gps_time: Some(0.0),
                color: Some(las::Color {
                    red: 1,
                    green: 1,
                    blue: 1,
                }),
                ..Default::default()
            })
            .expect("write point");
        writer.close().expect("close las writer");
    }

    #[test]
    fn crs_outside_supported_range_is_not_reported_as_missing() {
        let dir = tempfile::tempdir().unwrap();
        let paths: Vec<PathBuf> = ["a.las", "b.las"]
            .iter()
            .map(|n| dir.path().join(n))
            .collect();
        for p in &paths {
            write_single_point_las_with_geotiff_crs(p, 2992);
        }
        let summary = summarize_headers_lenient(&paths).expect("same CRS merges");
        assert_eq!(summary.crs, CrsId::Epsg(2992));
        assert!(
            summary.crs_warnings().is_empty(),
            "{:?}",
            summary.crs_warnings()
        );

        write_single_point_las_with_geotiff_crs(&paths[1], 6677);
        assert!(matches!(
            summarize_headers_lenient(&paths),
            Err(MergeError::CrsMismatch { .. })
        ));
    }

    #[test]
    fn merging_rejects_mismatched_crs() {
        let dir = tempfile::tempdir().expect("tempdir");
        write_single_point_las_with_geotiff_crs(&dir.path().join("a.las"), 6677);
        write_single_point_las_with_geotiff_crs(&dir.path().join("b.las"), 32654);

        let paths = collect_input_paths(dir.path().to_str().expect("utf8 path")).expect("collect");
        match summarize_headers(&paths) {
            Err(MergeError::CrsMismatch { path, .. }) => {
                assert_eq!(path.file_name().unwrap(), "b.las");
            }
            Err(e) => panic!("CrsMismatchを期待したが別のエラー: {e}"),
            Ok(_) => panic!("CrsMismatchを期待したがOkだった"),
        }
    }

    #[test]
    fn merging_allows_inputs_without_any_crs_information() {
        let dir = tempfile::tempdir().expect("tempdir");
        write_single_point_las(&dir.path().join("a.las"), 0.0, 0.0, 0.0, [1, 1, 1]);
        write_single_point_las(&dir.path().join("b.las"), 1.0, 1.0, 1.0, [2, 2, 2]);

        let paths = collect_input_paths(dir.path().to_str().expect("utf8 path")).expect("collect");
        let summary = summarize_headers(&paths).expect("CRSが無い入力どうしは一致するはず");
        assert!(summary.crs.is_missing());
    }

    #[test]
    fn assume_missing_crs_flag_only_accepts_unknown_files() {
        let dir = tempfile::tempdir().expect("tempdir");
        write_single_point_las_with_geotiff_crs(&dir.path().join("a.las"), 6677);
        write_single_point_las(&dir.path().join("b.las"), 1.0, 1.0, 1.0, [2, 2, 2]);
        let paths = collect_input_paths(dir.path().to_str().expect("utf8 path")).expect("collect");

        assert!(matches!(
            summarize_headers(&paths),
            Err(MergeError::CrsMismatch { .. })
        ));
        let summary = summarize_headers_with_options(&paths, true).expect("フラグ有りなら通る");
        assert!(!summary.crs.is_missing());
        let names: Vec<_> = summary
            .assumed_crs_paths
            .iter()
            .map(|p| p.file_name().unwrap().to_owned())
            .collect();
        assert_eq!(names, vec![std::ffi::OsString::from("b.las")]);
    }

    #[test]
    fn assume_missing_crs_flag_still_rejects_known_mismatch() {
        let dir = tempfile::tempdir().expect("tempdir");
        write_single_point_las_with_geotiff_crs(&dir.path().join("a.las"), 6677);
        write_single_point_las_with_geotiff_crs(&dir.path().join("b.las"), 32654);
        let paths = collect_input_paths(dir.path().to_str().expect("utf8 path")).expect("collect");
        assert!(matches!(
            summarize_headers_with_options(&paths, true),
            Err(MergeError::CrsMismatch { .. })
        ));
    }

    #[test]
    fn lenient_mode_passes_files_without_crs_and_reports_them() {
        let dir = tempfile::tempdir().expect("tempdir");
        write_single_point_las(&dir.path().join("a.las"), 0.0, 0.0, 0.0, [1, 1, 1]);
        write_single_point_las_with_geotiff_crs(&dir.path().join("b.las"), 6677);
        write_single_point_las(&dir.path().join("c.las"), 1.0, 1.0, 1.0, [2, 2, 2]);
        let paths = collect_input_paths(dir.path().to_str().expect("utf8 path")).expect("collect");

        assert!(matches!(
            summarize_headers(&paths),
            Err(MergeError::CrsMismatch { .. })
        ));

        let summary = summarize_headers_lenient(&paths).expect("寛容モードは通る");
        assert!(
            !summary.crs.is_missing(),
            "結果のCRSはCRSのあるファイルのもの"
        );
        assert!(
            summary.metadata.wkt_crs.is_some(),
            "出力のWKTも、CRSのあるファイルから取る"
        );
        let warnings = summary.crs_warnings();
        assert_eq!(warnings.len(), 2);
        assert!(warnings[0].starts_with("a.las: CRS"), "{warnings:?}");
        assert!(warnings[1].starts_with("c.las: CRS"), "{warnings:?}");
    }

    #[test]
    fn lenient_mode_still_rejects_known_mismatch() {
        let dir = tempfile::tempdir().expect("tempdir");
        write_single_point_las_with_geotiff_crs(&dir.path().join("a.las"), 6677);
        write_single_point_las(&dir.path().join("b.las"), 1.0, 1.0, 1.0, [2, 2, 2]);
        write_single_point_las_with_geotiff_crs(&dir.path().join("c.las"), 32654);
        let paths = collect_input_paths(dir.path().to_str().expect("utf8 path")).expect("collect");
        match summarize_headers_lenient(&paths) {
            Err(MergeError::CrsMismatch { path, first, .. }) => {
                assert_eq!(path.file_name().unwrap(), "c.las");
                assert_eq!(first.file_name().unwrap(), "a.las");
            }
            Err(e) => panic!("CrsMismatchを期待したが別のエラー: {e}"),
            Ok(_) => panic!("CrsMismatchを期待したがOkだった"),
        }
    }

    fn write_single_point_las_with_transform(
        path: &Path,
        x: f64,
        y: f64,
        z: f64,
        scale: f64,
        offset: f64,
    ) {
        let mut builder = las::Builder::from((1, 2));
        builder.point_format = las::point::Format::new(3).expect("PDRF3は存在する");
        builder.transforms = las::Vector {
            x: las::Transform { scale, offset },
            y: las::Transform { scale, offset },
            z: las::Transform {
                scale: 0.001,
                offset: 0.0,
            },
        };
        let header = builder.into_header().expect("valid header");
        let file = std::fs::File::create(path).expect("create las");
        let mut writer =
            las::Writer::new(std::io::BufWriter::new(file), header).expect("las writer");
        writer
            .write_point(las::Point {
                x,
                y,
                z,
                gps_time: Some(0.0),
                color: Some(las::Color {
                    red: 10,
                    green: 20,
                    blue: 30,
                }),
                ..Default::default()
            })
            .expect("write point");
        writer.close().expect("close las writer");
    }

    #[test]
    fn merging_with_different_scale_and_offset_keeps_real_world_coordinates() {
        let dir = tempfile::tempdir().expect("tempdir");
        write_single_point_las_with_transform(
            &dir.path().join("tile-a.las"),
            0.0,
            0.0,
            0.0,
            0.001,
            0.0,
        );
        write_single_point_las_with_transform(
            &dir.path().join("tile-b.las"),
            123.46,
            -50.0,
            1.0,
            0.01,
            100_000.0,
        );

        let paths = collect_input_paths(dir.path().to_str().expect("utf8 path")).expect("collect");
        let summary = summarize_headers(&paths).expect("summarize");

        let output = dir.path().join("merged.copc.laz");
        let spill_dir = tempfile::tempdir().expect("spill tempdir");
        let points = MultiFileLasPoints::new(paths, summary.declared_points_total);
        let params = CopcWriterParams::new(100_000);
        write_streaming_with_cancel_and_timings(
            &output,
            summary.layout,
            points,
            &params,
            &summary.metadata,
            spill_dir.path(),
            &copc_core::NeverCancel,
            None,
            None,
        )
        .expect("write merged copc");

        let file = pcv_core::CopcFile::open(&output).expect("open merged copc");
        assert_eq!(file.info().point_count, 2);
        let close =
            |a: [f64; 3], b: [f64; 3]| a.iter().zip(b.iter()).all(|(x, y)| (x - y).abs() < 1e-6);
        assert!(
            close(file.info().min, [0.0, -50.0, 0.0]),
            "min={:?}",
            file.info().min
        );
        assert!(
            close(file.info().max, [123.46, 0.0, 1.0]),
            "max={:?}",
            file.info().max
        );

        let hierarchy_sum: u64 = file
            .hierarchy()
            .nodes()
            .map(|n| u64::from(n.point_count))
            .sum();
        assert_eq!(hierarchy_sum, 2);
    }

    #[test]
    fn merge_paths_and_timings_reports_progress_and_correct_metadata() {
        let dir = tempfile::tempdir().expect("tempdir");
        write_multi_point_las(
            &dir.path().join("a.las"),
            &[(0.0, 0.0, 0.0), (1.0, 1.0, 1.0)],
        );
        write_multi_point_las(&dir.path().join("b.las"), &[(2.0, 2.0, 2.0)]);
        let paths = collect_input_paths(dir.path().to_str().expect("utf8 path")).expect("collect");

        let output = dir.path().join("merged.copc.laz");
        let spill_dir = tempfile::tempdir().expect("spill tempdir");
        let mut last_progress: Option<ReadProgress> = None;
        let mut timings = ConversionStageTimings::default();
        let summary = merge_paths_and_timings(
            paths,
            &output,
            spill_dir.path(),
            &CopcWriterParams::new(100_000),
            &copc_core::NeverCancel,
            |p| last_progress = Some(p),
            &mut timings,
        )
        .expect("merge_paths_and_timings");

        assert_eq!(summary.declared_points_total, 3);
        let last = last_progress.expect("on_progressが最低1回は呼ばれるはず");
        assert_eq!(last.points_read, 3);
        assert_eq!(last.total_points, 3);

        let file = pcv_core::CopcFile::open(&output).expect("open merged copc");
        assert_eq!(file.info().point_count, 3);
    }
}
