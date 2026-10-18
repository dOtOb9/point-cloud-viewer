//! M4-17 (`TaskSheets/M4-17-merge-any-format.md`): reading several files of any format
//! (LAS/LAZ, PLY, PCD, E57) as ONE stream of points.
//!
//! Nothing here touches the browser: the readers are generic over `Read + Seek`, so the host
//! `cargo test` runs this file with in-memory data (`Cursor`). The browser part (`File`, OPFS,
//! the spill) is in `point_file_import.rs`.
//!
//! # The three pieces
//!
//! 1. `PointStream`: one opened file. "Give me the next point" for every format.
//! 2. `plan_merge`: looks at the header summary of every file and decides what the output has
//!    (color or not, CRS, warnings). It runs BEFORE the first point is read, because the
//!    spill layout (does it have color?) must be known when the spill is created.
//! 3. `MergedPoints`: walks the files one after another and gives their points as one stream.
//!    A file without color gets mid gray when the output has color.
//!
//! # Memory
//!
//! Only one file is open at a time while points are read (the header pass drops each file
//! right after reading its header, except the first one, which is kept so a single file is not
//! opened twice). `LasStream` keeps at most `LAS_BATCH_POINTS` points. Nothing grows with the
//! number of points (CLAUDE.md "メモリ").

use std::io::{BufRead, Seek};

use copc_core::{LasPointRecord, StreamingLayout};
use pcv_core::crs::{crs_id_from_las_header, CrsId};

use crate::e57_import::E57Stream;
use crate::pcd_import::PcdStream;
use crate::ply_import::PlyStream;
use crate::point_file_import::RawPoint;
use crate::write_metadata::copc_write_metadata_from_source_header;

/// Mid gray (16-bit) for the points of a file without color, in an output that has color.
/// The same value as the desktop build (the sheet's "Shared rules").
pub(crate) const GRAY: [u16; 3] = [32768, 32768, 32768];

/// Shown when LAS/LAZ is merged with another format (attributes beyond x, y, z, color and
/// intensity are not carried over). The text is fixed by the sheet; the desktop build shows the same.
pub(crate) const LAS_ATTRIBUTES_WARNING: &str =
    "LAS/LAZ と他の形式を結合したため、LAS/LAZ の分類・GPS時刻・リターン番号などの属性は出力に含まれません";

/// Shown when the output has a CRS (from LAS/LAZ) and a PLY/PCD/E57 file was merged into it.
pub(crate) const NON_LAS_CRS_WARNING: &str =
    "PLY/PCD/E57 の点は LAS/LAZ と同じ座標系として結合しました";

/// Points a `LasStream` decodes at once. A constant, so memory does not depend on the file.
const LAS_BATCH_POINTS: u64 = 4096;

/// The format of one input file. Parsed from the names `detectSourceFormatByName`
/// (`src/datasource/source-format.ts`) returns.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PointFormat {
    LasLaz,
    Ply,
    Pcd,
    E57,
}

impl PointFormat {
    pub(crate) fn from_name(name: &str) -> Result<Self, String> {
        match name {
            "lasLaz" => Ok(PointFormat::LasLaz),
            "ply" => Ok(PointFormat::Ply),
            "pcd" => Ok(PointFormat::Pcd),
            "e57" => Ok(PointFormat::E57),
            other => Err(format!("Webで変換できない形式: {other}")),
        }
    }
}

/// What a reader must be: buffered, seekable, and `Send + Sync + 'static` (the `las` crate asks
/// for the last three). The browser `BufReader<FileRangeReader>` and a test `Cursor` both are.
/// A trait with a blanket impl only to avoid repeating this bound everywhere.
pub(crate) trait PointSourceReader: BufRead + Seek + Send + Sync + 'static {}
impl<T: BufRead + Seek + Send + Sync + 'static> PointSourceReader for T {}

/// A LAS/LAZ file read as a plain point stream (x, y, z, color, intensity only).
pub(crate) struct LasStream {
    reader: las::Reader,
    point_data: las::PointData,
    has_color: bool,
    declared_points: u64,
    crs: CrsId,
    wkt_crs: Option<String>,
    /// The points decoded by the last `fill_points` (at most `LAS_BATCH_POINTS`), and the
    /// index of the next one to give out.
    buffer: Vec<RawPoint>,
    next: usize,
}

impl LasStream {
    fn open<R: PointSourceReader>(source: R) -> Result<Self, String> {
        let reader = las::Reader::new(source).map_err(|e| e.to_string())?;
        let header = reader.header();
        let has_color = StreamingLayout::from_las_header(header).has_color;
        let declared_points = header.number_of_points();
        let crs = crs_id_from_las_header(header);
        let wkt_crs = copc_write_metadata_from_source_header(header).wkt_crs;
        let point_data = las::PointDataBuilder::new().for_header(header).build();
        Ok(Self {
            reader,
            point_data,
            has_color,
            declared_points,
            crs,
            wkt_crs,
            buffer: Vec::new(),
            next: 0,
        })
    }

    fn next_point(&mut self) -> Result<Option<RawPoint>, String> {
        if self.next >= self.buffer.len() {
            self.refill()?;
        }
        let point = self.buffer.get(self.next).copied();
        self.next += 1;
        Ok(point)
    }

    /// Decode the next batch. Leaves `buffer` empty at the end of the file.
    fn refill(&mut self) -> Result<(), String> {
        self.buffer.clear();
        self.next = 0;
        let count = self
            .reader
            .fill_points(LAS_BATCH_POINTS, &mut self.point_data)
            .map_err(|e| e.to_string())?;
        if count == 0 {
            return Ok(());
        }
        for result in self.point_data.points() {
            let point = result.map_err(|e| e.to_string())?;
            let record = LasPointRecord::from_las_point(&point);
            // `from_las_point` fills gray for a format without color; the merge decides that
            // itself, so give `[0, 0, 0]` here like every other reader.
            let color = if self.has_color {
                [record.red, record.green, record.blue]
            } else {
                [0, 0, 0]
            };
            self.buffer.push(RawPoint {
                x: record.x,
                y: record.y,
                z: record.z,
                color,
                intensity: record.intensity,
            });
        }
        Ok(())
    }
}

/// One opened file of any format. A plain enum instead of a trait object: there are four
/// variants and every method is a four-arm `match`.
pub(crate) enum PointStream<R: PointSourceReader> {
    Las(Box<LasStream>),
    Ply(PlyStream<R>),
    Pcd(Box<PcdStream<R>>),
    // Boxed: the E57 reader is much larger than the others (clippy::large_enum_variant).
    E57(Box<E57Stream<R>>),
}

impl<R: PointSourceReader> PointStream<R> {
    pub(crate) fn open(format: PointFormat, source: R) -> Result<Self, String> {
        Ok(match format {
            PointFormat::LasLaz => PointStream::Las(Box::new(LasStream::open(source)?)),
            PointFormat::Ply => PointStream::Ply(PlyStream::open(source)?),
            PointFormat::Pcd => PointStream::Pcd(Box::new(PcdStream::open(source)?)),
            PointFormat::E57 => PointStream::E57(Box::new(E57Stream::open(source)?)),
        })
    }

    fn has_color(&self) -> bool {
        match self {
            PointStream::Las(s) => s.has_color,
            PointStream::Ply(s) => s.has_color(),
            PointStream::Pcd(s) => s.has_color(),
            PointStream::E57(s) => s.has_color(),
        }
    }

    fn declared_point_count(&self) -> u64 {
        match self {
            PointStream::Las(s) => s.declared_points,
            PointStream::Ply(s) => s.declared_point_count(),
            PointStream::Pcd(s) => s.declared_point_count(),
            PointStream::E57(s) => s.declared_point_count(),
        }
    }

    pub(crate) fn next_point(&mut self) -> Result<Option<RawPoint>, String> {
        match self {
            PointStream::Las(s) => s.next_point(),
            PointStream::Ply(s) => s.next_point(),
            PointStream::Pcd(s) => s.next_point(),
            PointStream::E57(s) => s.next_point(),
        }
    }
}

/// The name, format and size of one input, as the browser side knows them.
pub(crate) struct InputInfo {
    pub name: String,
    pub format: PointFormat,
    pub file_size_bytes: u64,
}

/// What the header of one file says (the "header pass").
pub(crate) struct FileSummary {
    pub name: String,
    pub format: PointFormat,
    pub has_color: bool,
    pub declared_points: u64,
    pub file_size_bytes: u64,
    /// `CrsId::Missing` for PLY / PCD / E57 (they carry no CRS) and for LAS/LAZ without one.
    pub crs: CrsId,
    /// The WKT text to write into the output (LAS/LAZ only).
    pub wkt_crs: Option<String>,
}

/// What the output will look like, decided from all the summaries.
#[derive(Debug, PartialEq)]
pub(crate) struct MergePlan {
    /// True if at least one input has color.
    pub output_has_color: bool,
    /// The progress denominator: the sum of the declared point counts.
    pub total_points: u64,
    pub total_file_size_bytes: u64,
    pub wkt_crs: Option<String>,
    pub warnings: Vec<String>,
}

/// Decide the output from the header summaries (in streaming order). Fails, before any point
/// is written, if two LAS/LAZ files have different CRSs. Files whose CRS is unknown count as
/// agreeing (same rule as the LAS merge in `convert.rs`).
pub(crate) fn plan_merge(summaries: &[FileSummary]) -> Result<MergePlan, String> {
    let mut first_crs: Option<&FileSummary> = None;
    for summary in summaries {
        if summary.crs.is_missing() {
            continue;
        }
        match first_crs {
            None => first_crs = Some(summary),
            Some(first) if first.crs != summary.crs => {
                return Err(format!(
                    "{}: CRS(座標系)が{}と異なるため、まとめて変換できません",
                    summary.name, first.name
                ));
            }
            Some(_) => {}
        }
    }

    let has_las = summaries.iter().any(|s| s.format == PointFormat::LasLaz);
    let has_non_las = summaries.iter().any(|s| s.format != PointFormat::LasLaz);
    let mut warnings = Vec::new();
    if has_las && has_non_las {
        warnings.push(LAS_ATTRIBUTES_WARNING.to_string());
    }
    if first_crs.is_some() && has_non_las {
        warnings.push(NON_LAS_CRS_WARNING.to_string());
    }

    Ok(MergePlan {
        output_has_color: summaries.iter().any(|s| s.has_color),
        total_points: summaries.iter().map(|s| s.declared_points).sum(),
        total_file_size_bytes: summaries.iter().map(|s| s.file_size_bytes).sum(),
        wkt_crs: first_crs.and_then(|s| s.wkt_crs.clone()),
        warnings,
    })
}

/// Opens file number `index` (the browser side opens the `File` and wraps it in a `BufReader`;
/// the tests return a `Cursor`). A boxed closure so that `MergedPoints` does not need to know
/// what a `File` is.
pub(crate) type OpenFile<R> = Box<dyn FnMut(usize) -> Result<PointStream<R>, String>>;

/// The points of all files, one file after another, as one stream.
pub(crate) struct MergedPoints<R: PointSourceReader> {
    files: Vec<FileSummary>,
    open: OpenFile<R>,
    /// The file being read, and its index in `files`.
    current: Option<PointStream<R>>,
    current_index: usize,
    output_has_color: bool,
}

impl<R: PointSourceReader> MergedPoints<R> {
    /// The header pass: open every file once, read its header, and plan the output. Returns the
    /// stream (positioned before the first point) and the plan.
    ///
    /// `inputs` must already be in the order the files are streamed (the browser side sorts by
    /// name, so the output does not depend on the selection order).
    pub(crate) fn start(
        inputs: Vec<InputInfo>,
        mut open: OpenFile<R>,
    ) -> Result<(Self, MergePlan), String> {
        let mut files = Vec::with_capacity(inputs.len());
        let mut first_stream = None;
        for (index, input) in inputs.into_iter().enumerate() {
            let stream = open(index)?;
            let (crs, wkt_crs) = match &stream {
                PointStream::Las(las) => (las.crs.clone(), las.wkt_crs.clone()),
                _ => (CrsId::Missing, None),
            };
            files.push(FileSummary {
                name: input.name,
                format: input.format,
                has_color: stream.has_color(),
                declared_points: stream.declared_point_count(),
                file_size_bytes: input.file_size_bytes,
                crs,
                wkt_crs,
            });
            // Keep the first file open so a single file is not opened twice; drop the others
            // now (they are opened again when their turn comes).
            if index == 0 {
                first_stream = Some(stream);
            }
        }
        let plan = plan_merge(&files)?;
        let merged = Self {
            files,
            open,
            current: first_stream,
            current_index: 0,
            output_has_color: plan.output_has_color,
        };
        Ok((merged, plan))
    }

    /// The next point of the merged stream, or `None` after the last file.
    pub(crate) fn next_point(&mut self) -> Result<Option<RawPoint>, String> {
        loop {
            if self.current.is_none() {
                // The first file is already open (from `start`); open the others when needed.
                if self.current_index >= self.files.len() {
                    return Ok(None);
                }
                self.current = Some((self.open)(self.current_index)?);
            }
            let Some(stream) = self.current.as_mut() else {
                return Ok(None);
            };
            match stream.next_point()? {
                Some(mut point) => {
                    if self.output_has_color && !self.files[self.current_index].has_color {
                        point.color = GRAY;
                    }
                    return Ok(Some(point));
                }
                None => {
                    // This file is done: close it and go to the next one.
                    self.current = None;
                    self.current_index += 1;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    type Reader = Cursor<Vec<u8>>;

    fn ply_bytes(points: &[(f32, f32, f32)], color: Option<[u8; 3]>) -> Vec<u8> {
        let mut text = String::from("ply\nformat ascii 1.0\n");
        text.push_str(&format!("element vertex {}\n", points.len()));
        text.push_str("property float x\nproperty float y\nproperty float z\n");
        if color.is_some() {
            text.push_str("property uchar red\nproperty uchar green\nproperty uchar blue\n");
        }
        text.push_str("end_header\n");
        for &(x, y, z) in points {
            match color {
                Some([r, g, b]) => text.push_str(&format!("{x} {y} {z} {r} {g} {b}\n")),
                None => text.push_str(&format!("{x} {y} {z}\n")),
            }
        }
        text.into_bytes()
    }

    fn pcd_bytes(points: &[(f32, f32, f32)]) -> Vec<u8> {
        let mut text =
            String::from("VERSION .7\nFIELDS x y z\nSIZE 4 4 4\nTYPE F F F\nCOUNT 1 1 1\n");
        text.push_str(&format!(
            "WIDTH {n}\nHEIGHT 1\nVIEWPOINT 0 0 0 1 0 0 0\nPOINTS {n}\nDATA ascii\n",
            n = points.len()
        ));
        for &(x, y, z) in points {
            text.push_str(&format!("{x} {y} {z}\n"));
        }
        text.into_bytes()
    }

    /// A LAS file (point format 2 = with color, or 0 = without) with `count` points, written
    /// through a temporary file because `las::Writer::from_path` picks LAS / LAZ by extension.
    fn las_bytes(count: u32, with_color: bool) -> Vec<u8> {
        let mut builder = las::Builder::from((1, 2));
        builder.point_format =
            las::point::Format::new(if with_color { 2 } else { 0 }).expect("valid point format");
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
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("synthetic.las");
        let mut writer = las::Writer::from_path(&path, header).expect("las writer");
        for i in 0..count {
            let mut point = las::Point {
                x: f64::from(i) * 0.5,
                y: 2.0,
                z: 3.0,
                intensity: 7,
                classification: las::point::Classification::Ground,
                ..Default::default()
            };
            if with_color {
                point.color = Some(las::Color::new(1000, 2000, 3000));
            }
            writer.write_point(point).expect("write point");
        }
        writer.close().expect("close");
        std::fs::read(&path).expect("read back")
    }

    fn input(name: &str, format: PointFormat, data: &[u8]) -> InputInfo {
        InputInfo {
            name: name.to_string(),
            format,
            file_size_bytes: data.len() as u64,
        }
    }

    /// Start a merge over in-memory files and read every point.
    fn run(files: Vec<(&str, PointFormat, Vec<u8>)>) -> Result<(Vec<RawPoint>, MergePlan), String> {
        let inputs: Vec<InputInfo> = files
            .iter()
            .map(|(name, format, data)| input(name, *format, data))
            .collect();
        let formats: Vec<PointFormat> = files.iter().map(|(_, format, _)| *format).collect();
        let datas: Vec<Vec<u8>> = files.into_iter().map(|(_, _, data)| data).collect();
        let open: OpenFile<Reader> =
            Box::new(move |i| PointStream::open(formats[i], Cursor::new(datas[i].clone())));
        let (mut merged, plan) = MergedPoints::start(inputs, open)?;
        let mut points = Vec::new();
        while let Some(p) = merged.next_point()? {
            points.push(p);
        }
        Ok((points, plan))
    }

    #[test]
    fn ply_and_pcd_without_color_merge_without_color() {
        let a = ply_bytes(&[(0.0, 0.0, 0.0), (1.0, 1.0, 1.0)], None);
        let b = pcd_bytes(&[(5.0, 5.0, 5.0), (6.0, 6.0, 6.0), (7.0, 7.0, 7.0)]);
        let (points, plan) = run(vec![
            ("a.ply", PointFormat::Ply, a),
            ("b.pcd", PointFormat::Pcd, b),
        ])
        .expect("merge");
        assert_eq!(points.len(), 5);
        assert_eq!(plan.total_points, 5);
        assert!(!plan.output_has_color);
        assert!(plan.warnings.is_empty());
        // Files are read in the given order, and no gray is painted.
        assert_eq!(points[0].x, 0.0);
        assert_eq!(points[4].x, 7.0);
        assert!(points.iter().all(|p| p.color == [0, 0, 0]));
    }

    #[test]
    fn colored_ply_and_uncolored_pcd_paint_the_pcd_points_gray() {
        let a = ply_bytes(&[(0.0, 0.0, 0.0)], Some([255, 0, 0]));
        let b = pcd_bytes(&[(5.0, 5.0, 5.0), (6.0, 6.0, 6.0)]);
        let (points, plan) = run(vec![
            ("a.ply", PointFormat::Ply, a),
            ("b.pcd", PointFormat::Pcd, b),
        ])
        .expect("merge");
        assert!(plan.output_has_color);
        assert_eq!(points.len(), 3);
        assert_eq!(points[0].color, [255 * 257, 0, 0]);
        assert_eq!(points[1].color, GRAY);
        assert_eq!(points[2].color, GRAY);
    }

    #[test]
    fn las_and_ply_merge_with_the_attribute_warning() {
        let las = las_bytes(3, true);
        let ply = ply_bytes(&[(100.0, 100.0, 100.0)], None);
        let (points, plan) = run(vec![
            ("a.las", PointFormat::LasLaz, las),
            ("b.ply", PointFormat::Ply, ply),
        ])
        .expect("merge");
        assert_eq!(points.len(), 4);
        assert_eq!(plan.warnings, vec![LAS_ATTRIBUTES_WARNING.to_string()]);
        assert!(plan.output_has_color);
        // LAS points: real coordinates, color and intensity are kept.
        assert_eq!(points[1].x, 0.5);
        assert_eq!(points[1].y, 2.0);
        assert_eq!(points[1].color, [1000, 2000, 3000]);
        assert_eq!(points[1].intensity, 7);
        // The PLY point has no color: gray.
        assert_eq!(points[3].color, GRAY);
    }

    #[test]
    fn uncolored_las_and_uncolored_ply_have_no_color() {
        let las = las_bytes(2, false);
        let ply = ply_bytes(&[(1.0, 1.0, 1.0)], None);
        let (points, plan) = run(vec![
            ("a.las", PointFormat::LasLaz, las),
            ("b.ply", PointFormat::Ply, ply),
        ])
        .expect("merge");
        assert!(!plan.output_has_color);
        assert!(points.iter().all(|p| p.color == [0, 0, 0]));
    }

    fn summary(name: &str, format: PointFormat, crs: CrsId) -> FileSummary {
        FileSummary {
            name: name.to_string(),
            format,
            has_color: false,
            declared_points: 1,
            file_size_bytes: 10,
            crs,
            wkt_crs: None,
        }
    }

    #[test]
    fn two_las_with_different_crs_and_a_ply_fail_naming_the_file() {
        let err = plan_merge(&[
            summary("a.las", PointFormat::LasLaz, CrsId::Epsg(6677)),
            summary("b.las", PointFormat::LasLaz, CrsId::Epsg(32654)),
            summary("c.ply", PointFormat::Ply, CrsId::Missing),
        ])
        .expect_err("different CRSs must fail");
        assert!(err.starts_with("b.las: CRS"), "{err}");
        assert!(err.contains("a.las"), "{err}");
    }

    #[test]
    fn unknown_crs_agrees_and_ply_gets_the_crs_warning() {
        let plan = plan_merge(&[
            summary("a.las", PointFormat::LasLaz, CrsId::Epsg(6677)),
            summary("b.las", PointFormat::LasLaz, CrsId::Missing),
            summary("c.ply", PointFormat::Ply, CrsId::Missing),
        ])
        .expect("plan");
        assert_eq!(
            plan.warnings,
            vec![
                LAS_ATTRIBUTES_WARNING.to_string(),
                NON_LAS_CRS_WARNING.to_string()
            ]
        );
    }

    #[test]
    fn point_files_only_have_no_warning_and_a_single_file_is_not_opened_twice() {
        let data = ply_bytes(&[(0.0, 0.0, 0.0)], None);
        let opens = std::rc::Rc::new(std::cell::Cell::new(0));
        let counter = opens.clone();
        let open: OpenFile<Reader> = Box::new(move |_| {
            counter.set(counter.get() + 1);
            PointStream::open(PointFormat::Ply, Cursor::new(data.clone()))
        });
        let (mut merged, plan) =
            MergedPoints::start(vec![input("a.ply", PointFormat::Ply, &[0])], open).expect("start");
        assert!(plan.warnings.is_empty());
        assert!(merged.next_point().expect("point").is_some());
        assert!(merged.next_point().expect("end").is_none());
        assert_eq!(opens.get(), 1);
    }

    /// Memory: the LAS reader keeps one batch, whatever the file size.
    #[test]
    fn las_stream_buffer_stays_at_one_batch() {
        let count = 3 * LAS_BATCH_POINTS as u32 + 10;
        let mut stream = LasStream::open(Cursor::new(las_bytes(count, true))).expect("open");
        let mut read = 0u32;
        while stream.next_point().expect("point").is_some() {
            read += 1;
            assert!(stream.buffer.len() as u64 <= LAS_BATCH_POINTS);
        }
        assert_eq!(read, count);
        assert!(stream.buffer.capacity() as u64 <= 2 * LAS_BATCH_POINTS);
    }
}
