use std::io::BufReader;
use std::path::Path;
use std::time::Duration;

use copc_core::{deserialize_le, serialize_le, LasPointRecord, NeverCancel, StreamingLayout};
use copc_writer::{write_copc_from_spill_with_fs_and_timings, CopcWriterParams, SpillWriter};
use js_sys::Array;
use pcv_core::crs::{crs_id_from_las_header, CrsId};
use wasm_bindgen::prelude::*;
use web_sys::{File, FileSystemSyncAccessHandle};
use web_time::Instant;

use crate::file_reader::FileRangeReader;
use crate::opfs::OpfsScratchFs;
use crate::stats::BytesReadCounter;
use crate::write_metadata::copc_write_metadata_from_source_header;

fn to_js_error<E: std::fmt::Display>(err: E) -> JsValue {
    JsValue::from_str(&err.to_string())
}

const READ_BUFFER_BYTES: usize = 4 * 1024 * 1024;

pub(crate) fn handles_from_js_array(
    array: &Array,
) -> Result<Vec<FileSystemSyncAccessHandle>, JsValue> {
    let mut handles = Vec::with_capacity(array.length() as usize);
    for value in array.iter() {
        let handle: FileSystemSyncAccessHandle = value.dyn_into().map_err(|_| {
            JsValue::from_str("scratch_handlesの要素がFileSystemSyncAccessHandleではない")
        })?;
        handles.push(handle);
    }
    Ok(handles)
}

fn check_layout_and_crs_match(
    current_layout: &StreamingLayout,
    new_layout: &StreamingLayout,
    current_crs: &CrsId,
    new_crs: &CrsId,
) -> Result<CrsOutcome, String> {
    if new_layout != current_layout {
        return Err(format!(
            "入力ファイルの点フォーマットが一致しない({new_layout:?} != {current_layout:?})"
        ));
    }
    if new_crs.is_missing() {
        return Ok(CrsOutcome::NewFileHasNoCrs);
    }
    if current_crs.is_missing() {
        return Ok(CrsOutcome::AdoptNewFileCrs);
    }
    if new_crs != current_crs {
        return Err(format!(
            "入力ファイルのCRSが一致しない({new_crs:?} != {current_crs:?})"
        ));
    }
    Ok(CrsOutcome::Same)
}

#[derive(Debug, PartialEq, Eq)]
enum CrsOutcome {
    Same,
    NewFileHasNoCrs,
    AdoptNewFileCrs,
}

fn missing_crs_warnings(names: &[String], result_crs: &CrsId) -> Vec<String> {
    let result = if result_crs.is_missing() {
        "どのファイルにもCRSが無いので、結果にもCRSはありません"
    } else {
        "結果のCRSはCRSのあるファイルのものにしました"
    };
    names
        .iter()
        .map(|name| {
            format!(
                "{name}: CRS(座標系)の情報がありません。他のファイルと同じ座標系とみなして結合しました({result})"
            )
        })
        .collect()
}

#[wasm_bindgen(js_name = inspectLasHeaderSummary)]
pub fn inspect_las_header_summary(file: File) -> Result<JsValue, JsValue> {
    let file_size_bytes = file.size() as u64;
    let stats = BytesReadCounter::new();
    let source = FileRangeReader::new(file, stats);
    let buffered = BufReader::with_capacity(READ_BUFFER_BYTES, source);
    let reader = las::Reader::new(buffered).map_err(to_js_error)?;

    let layout = StreamingLayout::from_las_header(reader.header());
    let crs = crs_id_from_las_header(reader.header());
    let declared_points = reader.header().number_of_points();

    let dto = crate::dto::HeaderSummaryDto {
        declared_points: declared_points as f64,
        layout_key: format!("{layout:?}"),
        crs_label: format!("{crs:?}"),
        file_size_bytes: file_size_bytes as f64,
    };
    serde_wasm_bindgen::to_value(&dto).map_err(to_js_error)
}

#[wasm_bindgen]
pub struct WasmConverter {
    reader: las::Reader,
    point_data: las::PointData,
    spill: Option<SpillWriter>,
    fs: OpfsScratchFs,
    total_points: u64,
    points_fed: u64,
    output_name: String,
    metadata: copc_writer::CopcWriteMetadata,
    params: CopcWriterParams,
    layout: StreamingLayout,
    source_read_and_decode: Duration,
    spill_write: Duration,
    file_size_bytes: u64,
    crs: CrsId,
    input_file_count: u64,
    missing_crs_names: Vec<String>,
}

#[wasm_bindgen]
impl WasmConverter {
    #[wasm_bindgen(constructor)]
    pub fn new(
        file: File,
        scratch_handles: Array,
        output_handle: FileSystemSyncAccessHandle,
        output_name: String,
        max_points_per_node: u32,
    ) -> Result<WasmConverter, JsValue> {
        let file_size_bytes = file.size() as u64;
        let file_name = file.name();
        let stats = BytesReadCounter::new();
        let source = FileRangeReader::new(file, stats);
        let buffered = BufReader::with_capacity(READ_BUFFER_BYTES, source);
        let reader = las::Reader::new(buffered).map_err(to_js_error)?;

        let layout = StreamingLayout::from_las_header(reader.header());
        let crs = crs_id_from_las_header(reader.header());
        let crs_is_missing = crs.is_missing();
        let metadata = copc_write_metadata_from_source_header(reader.header());
        let total_points = reader.header().number_of_points();
        let point_data = las::PointDataBuilder::new()
            .for_header(reader.header())
            .build();

        let handles = handles_from_js_array(&scratch_handles)?;
        let fs = OpfsScratchFs::new(handles, output_handle);
        let spill =
            SpillWriter::create(&fs, layout.clone(), metadata.transform()).map_err(to_js_error)?;

        Ok(Self {
            reader,
            point_data,
            spill: Some(spill),
            fs,
            total_points,
            points_fed: 0,
            output_name,
            metadata,
            params: CopcWriterParams::new(max_points_per_node),
            layout,
            source_read_and_decode: Duration::ZERO,
            spill_write: Duration::ZERO,
            file_size_bytes,
            crs,
            input_file_count: 1,
            missing_crs_names: if crs_is_missing {
                vec![file_name]
            } else {
                Vec::new()
            },
        })
    }

    #[wasm_bindgen(js_name = totalPoints)]
    pub fn total_points(&self) -> f64 {
        self.total_points as f64
    }

    #[wasm_bindgen(js_name = recordWidth)]
    pub fn record_width(&self) -> u32 {
        self.layout.record_width() as u32
    }

    #[wasm_bindgen(js_name = openNextFile)]
    pub fn open_next_file(&mut self, file: File) -> Result<(), JsValue> {
        let file_name = file.name();
        let stats = BytesReadCounter::new();
        let source = FileRangeReader::new(file, stats);
        let buffered = BufReader::with_capacity(READ_BUFFER_BYTES, source);
        let reader = las::Reader::new(buffered).map_err(to_js_error)?;

        let layout = StreamingLayout::from_las_header(reader.header());
        let crs = crs_id_from_las_header(reader.header());
        let outcome = check_layout_and_crs_match(&self.layout, &layout, &self.crs, &crs)
            .map_err(|e| JsValue::from_str(&e))?;
        match outcome {
            CrsOutcome::Same => {}
            CrsOutcome::NewFileHasNoCrs => self.missing_crs_names.push(file_name),
            CrsOutcome::AdoptNewFileCrs => {
                self.metadata.wkt_crs =
                    copc_write_metadata_from_source_header(reader.header()).wkt_crs;
                self.crs = crs;
            }
        }

        let point_data = las::PointDataBuilder::new()
            .for_header(reader.header())
            .build();
        self.input_file_count += 1;
        self.reader = reader;
        self.point_data = point_data;
        Ok(())
    }

    #[wasm_bindgen(js_name = setDeclaredTotals)]
    pub fn set_declared_totals(&mut self, total_points: f64, total_file_size_bytes: f64) {
        self.total_points = total_points as u64;
        self.file_size_bytes = total_file_size_bytes as u64;
    }

    #[wasm_bindgen(js_name = pushSerializedRecords)]
    pub fn push_serialized_records(&mut self, bytes: Vec<u8>) -> Result<(), JsValue> {
        let spill = self
            .spill
            .as_mut()
            .ok_or_else(|| JsValue::from_str("pushSerializedRecordsはfinishの後には呼べない"))?;

        let width = self.layout.record_width();
        if !bytes.len().is_multiple_of(width) {
            return Err(JsValue::from_str(&format!(
                "展開Workerから受け取ったバイト列({} バイト)がrecordWidth({width})の倍数ではない",
                bytes.len()
            )));
        }
        let decode_start = Instant::now();
        let mut records = Vec::with_capacity(bytes.len() / width);
        for chunk in bytes.chunks_exact(width) {
            records.push(deserialize_le(chunk, &self.layout).map_err(to_js_error)?);
        }
        self.source_read_and_decode += decode_start.elapsed();

        let push_start = Instant::now();
        for record in &records {
            spill.push(record).map_err(to_js_error)?;
            self.points_fed += 1;
        }
        self.spill_write += push_start.elapsed();
        Ok(())
    }

    #[wasm_bindgen(js_name = feed)]
    pub fn feed(&mut self, batch_size: u32) -> Result<JsValue, JsValue> {
        let spill = self
            .spill
            .as_mut()
            .ok_or_else(|| JsValue::from_str("feedはfinishの後には呼べない"))?;

        let fetch_start = Instant::now();
        let count = self
            .reader
            .fill_points(u64::from(batch_size), &mut self.point_data)
            .map_err(to_js_error)?;
        let records = if count > 0 {
            self.point_data
                .points()
                .map(|result| result.map(|point| LasPointRecord::from_las_point(&point)))
                .collect::<Result<Vec<_>, _>>()
                .map_err(to_js_error)?
        } else {
            Vec::new()
        };
        self.source_read_and_decode += fetch_start.elapsed();

        let push_start = Instant::now();
        for record in &records {
            spill.push(record).map_err(to_js_error)?;
            self.points_fed += 1;
        }
        self.spill_write += push_start.elapsed();

        let dto = crate::dto::FeedResultDto {
            points_read: self.points_fed,
            total_points: self.total_points,
            done: count == 0,
        };
        serde_wasm_bindgen::to_value(&dto).map_err(to_js_error)
    }

    #[wasm_bindgen(js_name = finish)]
    pub fn finish(mut self) -> Result<JsValue, JsValue> {
        let spill = self
            .spill
            .take()
            .ok_or_else(|| JsValue::from_str("finishは既に呼ばれている"))?;
        let reader = spill.finalize().map_err(to_js_error)?;
        let post_timings = write_copc_from_spill_with_fs_and_timings(
            &self.fs,
            Path::new(&self.output_name),
            reader,
            &self.params,
            &NeverCancel,
            &self.metadata,
        )
        .map_err(to_js_error)?;

        let dto = crate::dto::FinishResultDto {
            point_count: self.points_fed,
            stage_timings: crate::dto::ConversionStageBreakdownDto::new(
                self.source_read_and_decode,
                self.spill_write,
                post_timings,
                self.points_fed,
                self.file_size_bytes,
                Some(self.fs.io_timings()),
                Some(self.fs.read_stats()),
                Some(self.fs.seq_read_stats()),
                self.input_file_count,
            ),
            warnings: if self.input_file_count > 1 {
                missing_crs_warnings(&self.missing_crs_names, &self.crs)
            } else {
                Vec::new()
            },
        };
        serde_wasm_bindgen::to_value(&dto).map_err(to_js_error)
    }
}

#[wasm_bindgen]
pub struct LazRangeDecompressor {
    core: RangeDecompressorCore,
}

#[wasm_bindgen]
impl LazRangeDecompressor {
    #[wasm_bindgen(constructor)]
    pub fn new(file: File, start_index: f64, count: f64) -> Result<LazRangeDecompressor, JsValue> {
        let stats = BytesReadCounter::new();
        let source = FileRangeReader::new(file, stats);
        let buffered = BufReader::with_capacity(READ_BUFFER_BYTES, source);
        let core = RangeDecompressorCore::open(buffered, start_index as u64, count as u64)
            .map_err(|e| JsValue::from_str(&e))?;
        Ok(Self { core })
    }

    #[wasm_bindgen(js_name = feed)]
    pub fn feed(&mut self, batch_size: u32) -> Result<Vec<u8>, JsValue> {
        self.core
            .feed(batch_size)
            .map_err(|e| JsValue::from_str(&e))
    }
}

struct RangeDecompressorCore {
    reader: las::Reader,
    point_data: las::PointData,
    layout: StreamingLayout,
    remaining: u64,
}

impl RangeDecompressorCore {
    fn open<R>(source: R, start_index: u64, count: u64) -> Result<Self, String>
    where
        R: std::io::Read + std::io::Seek + Send + Sync + 'static,
    {
        let mut reader = las::Reader::new(source).map_err(|e| e.to_string())?;

        let layout = StreamingLayout::from_las_header(reader.header());
        let total_points = reader.header().number_of_points();
        let point_data = las::PointDataBuilder::new()
            .for_header(reader.header())
            .build();

        let remaining = if start_index >= total_points {
            0
        } else {
            reader.seek(start_index).map_err(|e| e.to_string())?;
            (total_points - start_index).min(count)
        };

        Ok(Self {
            reader,
            point_data,
            layout,
            remaining,
        })
    }

    fn feed(&mut self, batch_size: u32) -> Result<Vec<u8>, String> {
        if self.remaining == 0 {
            return Ok(Vec::new());
        }
        let to_read = self.remaining.min(u64::from(batch_size));
        let n = self
            .reader
            .fill_points(to_read, &mut self.point_data)
            .map_err(|e| e.to_string())?;
        if n == 0 {
            self.remaining = 0;
            return Ok(Vec::new());
        }

        let width = self.layout.record_width();
        let mut out = vec![
            0u8;
            usize::try_from(n)
                .unwrap_or(usize::MAX)
                .saturating_mul(width)
        ];
        let mut scratch = vec![0u8; width];
        let mut offset = 0usize;
        for result in self.point_data.points() {
            let point = result.map_err(|e| e.to_string())?;
            let record = LasPointRecord::from_las_point(&point);
            serialize_le(&record, &self.layout, &mut scratch).map_err(|e| e.to_string())?;
            out[offset..offset + width].copy_from_slice(&scratch);
            offset += width;
        }
        self.remaining -= n;
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use copc_writer::{write_copc_from_spill_with_fs, CopcWriteMetadata, MemoryScratchFs};
    use std::io::Cursor;

    fn layout_for_point_format(format: u8) -> StreamingLayout {
        let mut builder = las::Builder::from((1, 2));
        builder.point_format = las::point::Format::new(format).expect("有効なpoint format");
        let header = builder.into_header().expect("valid header");
        StreamingLayout::from_las_header(&header)
    }

    #[test]
    fn check_layout_and_crs_match_rejects_different_layout() {
        let layout3 = layout_for_point_format(3);
        let layout0 = layout_for_point_format(0);

        let err = check_layout_and_crs_match(&layout3, &layout0, &CrsId::Missing, &CrsId::Missing);
        assert!(err.is_err());
    }

    #[test]
    fn check_layout_and_crs_match_rejects_different_crs() {
        let layout = layout_for_point_format(3);
        let jgd2011_plane_ix = CrsId::Epsg(6677);
        let utm_54n = CrsId::Epsg(32654);

        let err = check_layout_and_crs_match(&layout, &layout, &jgd2011_plane_ix, &utm_54n);
        assert!(err.is_err());
    }

    #[test]
    fn check_layout_and_crs_match_allows_matching_layout_and_unknown_crs() {
        let layout = layout_for_point_format(3);
        assert!(
            check_layout_and_crs_match(&layout, &layout, &CrsId::Missing, &CrsId::Missing).is_ok()
        );
    }

    #[test]
    fn check_layout_and_crs_match_compares_unsupported_crs_by_epsg_code() {
        let layout = layout_for_point_format(3);
        let a = CrsId::Epsg(2992);
        assert_eq!(
            check_layout_and_crs_match(&layout, &layout, &a, &a),
            Ok(CrsOutcome::Same)
        );
        assert!(check_layout_and_crs_match(&layout, &layout, &a, &CrsId::Epsg(6677)).is_err());
    }

    #[test]
    fn check_layout_and_crs_match_passes_missing_crs_and_adopts_first_known() {
        let layout = layout_for_point_format(3);
        let known = CrsId::Epsg(6677);
        assert_eq!(
            check_layout_and_crs_match(&layout, &layout, &known, &CrsId::Missing),
            Ok(CrsOutcome::NewFileHasNoCrs)
        );
        assert_eq!(
            check_layout_and_crs_match(&layout, &layout, &CrsId::Missing, &known),
            Ok(CrsOutcome::AdoptNewFileCrs)
        );
        assert_eq!(
            check_layout_and_crs_match(&layout, &layout, &known, &known),
            Ok(CrsOutcome::Same)
        );
    }

    #[test]
    fn missing_crs_warnings_name_each_file_and_the_result() {
        let names = vec!["a.laz".to_string(), "c.laz".to_string()];
        let w = missing_crs_warnings(&names, &CrsId::Epsg(6677));
        assert_eq!(w.len(), 2);
        assert!(w[0].starts_with("a.laz: CRS"));
        assert!(w[1].contains("CRSのあるファイルのもの"));
        let none = missing_crs_warnings(&names, &CrsId::Missing);
        assert!(none[0].contains("どのファイルにもCRSが無い"));
    }

    fn synthetic_multi_chunk_laz_bytes(point_count: u32) -> Vec<u8> {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("synthetic.laz");

        let mut builder = las::Builder::from((1, 4));
        builder.point_format = las::point::Format::new(6).expect("format 6");
        let header = builder.into_header().expect("valid header");
        let mut writer = las::Writer::from_path(&path, header).expect("LAS writerの作成に失敗");
        for i in 0..point_count {
            let point = las::Point {
                x: f64::from(i),
                y: f64::from(i) * 2.0,
                z: f64::from(i) * 3.0,
                gps_time: Some(0.0),
                ..Default::default()
            };
            writer.write_point(point).expect("点の書き込みに失敗");
        }
        writer.close().expect("LAS writerのクローズに失敗");

        std::fs::read(&path).expect("書いたLAZを読み戻せなかった")
    }

    fn decompress_range_in_batches<R>(
        source: R,
        start_index: u64,
        count: u64,
        batch_size: u32,
    ) -> Result<Vec<u8>, String>
    where
        R: std::io::Read + std::io::Seek + Send + Sync + 'static,
    {
        let mut core = RangeDecompressorCore::open(source, start_index, count)?;
        let mut out = Vec::new();
        loop {
            let batch = core.feed(batch_size)?;
            if batch.is_empty() {
                break;
            }
            out.extend_from_slice(&batch);
        }
        Ok(out)
    }

    #[test]
    fn concatenated_ranges_match_a_single_full_range_read() {
        const POINT_COUNT: u32 = 300_000;
        const BATCH_SIZE: u32 = 1_000;

        let bytes = synthetic_multi_chunk_laz_bytes(POINT_COUNT);

        let full = decompress_range_in_batches(
            Cursor::new(bytes.clone()),
            0,
            u64::from(POINT_COUNT),
            POINT_COUNT,
        )
        .expect("全体の展開に失敗した");

        let boundaries_of_three_workers = [0u64, 70_000, 180_000, u64::from(POINT_COUNT)];
        let mut concatenated = Vec::new();
        for window in boundaries_of_three_workers.windows(2) {
            let (start, end) = (window[0], window[1]);
            let part = decompress_range_in_batches(
                Cursor::new(bytes.clone()),
                start,
                end - start,
                BATCH_SIZE,
            )
            .unwrap_or_else(|e| panic!("範囲[{start}, {end})の展開に失敗した: {e}"));
            concatenated.extend_from_slice(&part);
        }

        assert_eq!(
            full.len(),
            concatenated.len(),
            "全体読みと分割読みの合計バイト数が一致しない"
        );
        assert_eq!(
            full, concatenated,
            "全体読みと、範囲・バッチに分けて連結した結果がバイト単位で一致しない"
        );
    }

    #[test]
    fn range_starting_past_total_points_returns_empty() {
        const POINT_COUNT: u32 = 1_000;
        let bytes = synthetic_multi_chunk_laz_bytes(POINT_COUNT);

        let out = decompress_range_in_batches(Cursor::new(bytes), 10_000, 100, 64)
            .expect("範囲外の開始でもエラーにしない設計のはず");
        assert!(out.is_empty());
    }

    #[test]
    fn feed_batch_size_stays_bounded_regardless_of_total_point_count() {
        const BATCH_SIZE: u32 = 1_000;
        let record_width = {
            let mut builder = las::Builder::from((1, 4));
            builder.point_format = las::point::Format::new(6).expect("format 6");
            let header = builder.into_header().expect("valid header");
            StreamingLayout::from_las_header(&header).record_width()
        };
        let max_batch_bytes = usize::try_from(BATCH_SIZE).unwrap() * record_width;

        for &point_count in &[10_000u32, 100_000u32] {
            let bytes = synthetic_multi_chunk_laz_bytes(point_count);
            let mut core =
                RangeDecompressorCore::open(Cursor::new(bytes), 0, u64::from(point_count))
                    .expect("展開器を開けなかった");

            let mut max_seen = 0usize;
            let mut total_points_read = 0u64;
            loop {
                let batch = core.feed(BATCH_SIZE).expect("feedに失敗した");
                if batch.is_empty() {
                    break;
                }
                assert!(
                    batch.len() <= max_batch_bytes,
                    "point_count={point_count}: feedが1回で返したバイト数({})が上限({max_batch_bytes})を超えた",
                    batch.len()
                );
                max_seen = max_seen.max(batch.len());
                total_points_read += (batch.len() / record_width) as u64;
            }
            assert_eq!(
                total_points_read,
                u64::from(point_count),
                "point_count={point_count}: feedの合計が担当範囲の点数と一致しない"
            );
            assert!(max_seen <= max_batch_bytes);
        }
    }

    fn synthetic_copc_bytes(point_count: u32) -> Vec<u8> {
        let mut builder = las::Builder::from((1, 4));
        builder.point_format = las::point::Format::new(6).expect("format 6");
        let header = builder.into_header().expect("valid header");
        let layout = StreamingLayout::from_las_header(&header);

        let fs = MemoryScratchFs::new();
        let mut spill = SpillWriter::create(&fs, layout, None).expect("SpillWriter::create");
        for i in 0..point_count {
            let point = las::Point {
                x: f64::from((i * 37) % 500) * 0.1,
                y: f64::from((i * 53) % 500) * 0.1,
                z: f64::from((i * 13) % 200) * 0.1,
                intensity: (i % 1000) as u16,
                gps_time: Some(f64::from(i)),
                ..Default::default()
            };
            spill
                .push(&LasPointRecord::from_las_point(&point))
                .expect("spill.push");
        }
        let reader = spill.finalize().expect("spill.finalize");
        let output_path = std::path::Path::new("synthetic.copc.laz");
        write_copc_from_spill_with_fs(
            &fs,
            output_path,
            reader,
            &CopcWriterParams::new(50),
            &NeverCancel,
            &CopcWriteMetadata::default(),
        )
        .expect("write_copc_from_spill_with_fs");
        fs.take_output(output_path).expect("output recorded")
    }

    #[test]
    fn range_of_variable_chunk_copc_matches_the_same_slice_of_a_full_read() {
        const POINT_COUNT: u32 = 5_000;
        let bytes = synthetic_copc_bytes(POINT_COUNT);
        let width = {
            let mut builder = las::Builder::from((1, 4));
            builder.point_format = las::point::Format::new(6).expect("format 6");
            let header = builder.into_header().expect("valid header");
            StreamingLayout::from_las_header(&header).record_width()
        };

        let full =
            decompress_range_in_batches(Cursor::new(bytes.clone()), 0, u64::from(POINT_COUNT), 700)
                .expect("full read");
        assert_eq!(
            full.len(),
            POINT_COUNT as usize * width,
            "full read returns every point"
        );

        const WORKERS: u64 = 8;
        let range_len = u64::from(POINT_COUNT) / WORKERS;
        let mut ranges: Vec<(u64, u64)> =
            (0..WORKERS).map(|i| (i * range_len, range_len)).collect();
        ranges.extend([
            (1, 10),
            (49, 3),
            (50, 100),
            (777, 1),
            (4_990, 10),
            (4_999, 1),
        ]);
        for (start, count) in ranges {
            let part = decompress_range_in_batches(Cursor::new(bytes.clone()), start, count, 300)
                .unwrap_or_else(|e| panic!("range [{start}, +{count}) failed: {e}"));
            let from = start as usize * width;
            let to = from + count as usize * width;
            assert_eq!(
                part,
                full[from..to],
                "range [{start}, +{count}) differs from the full read"
            );
        }
    }
}
