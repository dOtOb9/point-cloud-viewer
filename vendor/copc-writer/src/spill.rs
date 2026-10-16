//! Disk spill for streaming COPC writes.
//!
//! Points are written once, in input order, as fixed-width records (the
//! layout is described in `record.rs`: the output's point record, with x, y, z
//! as i32 when the output scale and offset are known up front). After
//! `finalize` the spill file becomes the root run of the LOD builder
//! (`SpillReader::into_run`), which reads it sequentially.
//!
//! M4-6a: the file system is reached through `crate::scratch::ScratchFs`, so
//! the same code runs on native temporary files and on the Web build.

use std::io::{BufWriter, Write};

use copc_core::{Bounds, Error, LasPointRecord, Result, StreamingLayout};
use las::point::Format as LasFormat;

use crate::record::{output_point_format, LasTransform, RecordFormat};
use crate::scratch::{ScratchFs, ScratchReader, ScratchWriter};
use crate::source::{fields_from_record, CopcPointFields};
use crate::validate::{validate_spill_record, validate_streaming_layout_supported, PointStats};
use crate::writer::{encode_point_body, encode_point_record};

const SPILL_IO_BUFFER_BYTES: usize = 1024 * 1024;

/// Streams `LasPointRecord` values to a process-local temporary spill file.
///
/// Records are validated at intake (coordinates, scan angle, LAS field
/// ranges, GPS time) and output statistics are accumulated as they stream in,
/// so spill-backed COPC writes need no second validation pass over the data.
pub struct SpillWriter {
    file: Option<BufWriter<Box<dyn ScratchWriter>>>,
    layout: StreamingLayout,
    format: RecordFormat,
    /// The output's point format; the record body is encoded with it.
    las_format: LasFormat,
    scratch: Vec<u8>,
    /// Reused for every pushed record (keeps the `extra_bytes` allocation).
    fields: CopcPointFields,
    count: u64,
    bounds: Option<Bounds>,
    stats: PointStats,
}

impl SpillWriter {
    /// `transform` is the scale and offset of the output file. With it, x, y, z
    /// are stored as the output's i32 (12 bytes instead of 24), and the output
    /// must be written with the same scale and offset (`write_copc_from_spill`
    /// checks that). Pass `None` when the offset is only known after all
    /// points have been seen (E57/PLY/PCD import): the coordinates are then
    /// kept as f64 and quantized when the nodes are encoded.
    ///
    /// `fs` decides where the temporary file lives (OS temporary file or a
    /// memory buffer).
    pub fn create(
        fs: &dyn ScratchFs,
        layout: StreamingLayout,
        transform: Option<LasTransform>,
    ) -> Result<Self> {
        // The records hold exactly what the output can hold: NIR and waveform
        // data would be dropped silently, so refuse them here.
        validate_streaming_layout_supported(&layout)?;
        let format = RecordFormat::new(&layout, transform)?;
        let las_format = output_point_format(&layout)?;
        let file = fs.create_temp("spill")?;
        Ok(Self {
            file: Some(BufWriter::with_capacity(SPILL_IO_BUFFER_BYTES, file)),
            layout,
            format,
            las_format,
            scratch: vec![0u8; format.width()],
            fields: CopcPointFields::default(),
            count: 0,
            bounds: None,
            stats: PointStats::new(),
        })
    }

    pub fn push(&mut self, record: &LasPointRecord) -> Result<()> {
        let index = usize::try_from(self.count).unwrap_or(usize::MAX);
        validate_spill_record(record, index)?;
        let mut next_stats = self.stats;
        next_stats.record(index, record.gps_time, record.return_number)?;
        fields_from_record(record, self.layout.has_gps, &mut self.fields);
        match self.format.transform() {
            Some(t) => encode_point_record(
                &mut self.scratch,
                &self.fields,
                t.scale,
                t.offset,
                index,
                &self.las_format,
            )?,
            None => {
                let (head, body) = self.scratch.split_at_mut(self.format.xyz_bytes());
                RecordFormat::write_wide_xyz(head, record.x, record.y, record.z);
                encode_point_body(body, &self.fields, index, &self.las_format)?;
            }
        }
        let writer = self
            .file
            .as_mut()
            .ok_or_else(|| Error::InvalidInput("spill writer already finalized".into()))?;
        writer
            .write_all(&self.scratch)
            .map_err(|e| Error::io("write spill record", e))?;
        match self.bounds.as_mut() {
            Some(bounds) => bounds.extend(record.x, record.y, record.z),
            None => self.bounds = Some(Bounds::point(record.x, record.y, record.z)),
        }
        self.stats = next_stats;
        self.count = self
            .count
            .checked_add(1)
            .ok_or_else(|| Error::InvalidInput("spill record count exceeds u64 range".into()))?;
        Ok(())
    }

    pub fn count(&self) -> u64 {
        self.count
    }

    pub fn finalize(mut self) -> Result<SpillReader> {
        let mut writer = self
            .file
            .take()
            .ok_or_else(|| Error::InvalidInput("spill writer already finalized".into()))?;
        writer
            .flush()
            .map_err(|e| Error::io("flush spill writer", e))?;
        let boxed_writer = writer
            .into_inner()
            .map_err(|e| Error::io("unwrap spill writer", e.into_error()))?;
        let count = usize::try_from(self.count)
            .map_err(|_| Error::InvalidInput("spill record count exceeds usize range".into()))?;
        let reader = boxed_writer.finish_temp()?;
        let expected = self
            .format
            .width()
            .checked_mul(count)
            .ok_or_else(|| Error::InvalidInput("spill size overflow".into()))?;
        let actual = reader.len()?;
        if actual != expected as u64 {
            return Err(Error::InvalidInput(format!(
                "spill file is {} bytes, expected {}",
                actual, expected
            )));
        }
        let bounds = self.bounds.unwrap_or_else(|| Bounds::point(0.0, 0.0, 0.0));
        Ok(SpillReader {
            reader,
            layout: self.layout,
            format: self.format,
            count,
            bounds,
            stats: self.stats,
        })
    }
}

/// A finalized spill file: the root run of the LOD builder, plus what was
/// learned about the points while they were written.
pub struct SpillReader {
    /// Owns the file (a native temporary file is deleted when it is dropped).
    reader: Box<dyn ScratchReader>,
    layout: StreamingLayout,
    format: RecordFormat,
    count: usize,
    bounds: Bounds,
    stats: PointStats,
}

impl SpillReader {
    pub(crate) fn stats(&self) -> PointStats {
        self.stats
    }

    pub(crate) fn format(&self) -> RecordFormat {
        self.format
    }

    /// Hands the spill file over to the LOD builder as its root run. The
    /// spill is deleted when the builder has partitioned it (ADR-0019).
    pub(crate) fn into_run(self) -> crate::lod::Run {
        crate::lod::Run {
            reader: self.reader,
            count: self.count,
        }
    }

    pub fn len(&self) -> usize {
        self.count
    }

    pub fn is_empty(&self) -> bool {
        self.count == 0
    }

    pub fn layout(&self) -> &StreamingLayout {
        &self.layout
    }

    /// Bounds of the pushed points (the original f64 coordinates, not the
    /// quantized ones).
    pub fn bounds(&self) -> Bounds {
        self.bounds
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lod::read_run;
    use crate::scratch::MemoryScratchFs;
    #[cfg(feature = "native-fs")]
    use crate::scratch::NativeScratchFs;

    fn layout(has_color: bool, has_gps: bool) -> StreamingLayout {
        StreamingLayout {
            point_format: 3,
            has_gps,
            has_color,
            has_nir: false,
            has_waveform: false,
            extra_bytes: 2,
            extra_bytes_descriptors: Vec::new(),
        }
    }

    fn transform() -> LasTransform {
        LasTransform {
            scale: (0.001, 0.001, 0.001),
            offset: (0.0, -600.0, 0.0),
        }
    }

    fn record(seed: u32) -> LasPointRecord {
        let f = f64::from(seed);
        LasPointRecord {
            x: f * 1.5,
            y: -f * 2.25,
            z: f * 0.125,
            intensity: seed as u16,
            return_number: (seed % 5) as u8,
            number_of_returns: 5,
            classification: (seed % 32) as u8,
            scan_direction_flag: seed.is_multiple_of(2),
            edge_of_flight_line: seed.is_multiple_of(3),
            scan_angle: (seed as f32) * 0.006 - 0.6,
            user_data: (seed % 256) as u8,
            point_source_id: seed as u16,
            synthetic: seed.is_multiple_of(4),
            key_point: seed % 4 == 1,
            withheld: seed % 4 == 2,
            overlap: false,
            scan_channel: (seed % 4) as u8,
            gps_time: 1.0e9 + f,
            red: (seed * 7) as u16,
            green: (seed * 11) as u16,
            blue: (seed * 13) as u16,
            extra_bytes: vec![(seed & 0xff) as u8, ((seed >> 8) & 0xff) as u8],
            ..LasPointRecord::default()
        }
    }

    /// What the output would store for `record`, made without the spill.
    fn expected_bytes(
        record: &LasPointRecord,
        layout: &StreamingLayout,
        transform: Option<LasTransform>,
    ) -> Vec<u8> {
        let las_format = output_point_format(layout).unwrap();
        let mut fields = CopcPointFields::default();
        fields_from_record(record, layout.has_gps, &mut fields);
        let mut las = vec![0u8; usize::from(las_format.len())];
        // Quantize with the transform, or with a trivial one for wide records
        // (only the body is compared then).
        let t = transform.unwrap_or(LasTransform {
            scale: (1.0, 1.0, 1.0),
            offset: (-1e9, -1e9, -1e9),
        });
        encode_point_record(&mut las, &fields, t.scale, t.offset, 0, &las_format).unwrap();
        match transform {
            Some(_) => las,
            None => {
                let mut wide = Vec::new();
                for v in [record.x, record.y, record.z] {
                    wide.extend_from_slice(&v.to_le_bytes());
                }
                wide.extend_from_slice(&las[12..]);
                wide
            }
        }
    }

    fn round_trips_records_and_bounds(
        fs: &dyn ScratchFs,
        has_color: bool,
        has_gps: bool,
        transform: Option<LasTransform>,
        expected_width: usize,
    ) {
        let layout = layout(has_color, has_gps);
        let mut writer = SpillWriter::create(fs, layout.clone(), transform).unwrap();
        let originals: Vec<LasPointRecord> = (0..256).map(record).collect();
        for rec in &originals {
            writer.push(rec).unwrap();
        }
        assert_eq!(writer.count(), 256);
        let reader = writer.finalize().unwrap();
        assert_eq!(reader.len(), 256);
        assert_eq!(reader.format().width(), expected_width);
        let format = reader.format();
        let run = reader.into_run();
        let bytes = read_run(&run, expected_width).unwrap();
        assert_eq!(bytes.len(), 256 * expected_width);
        for (i, (stored, original)) in bytes
            .chunks_exact(expected_width)
            .zip(&originals)
            .enumerate()
        {
            let mut original = original.clone();
            if !has_gps {
                original.gps_time = 0.0;
            }
            assert_eq!(
                stored,
                expected_bytes(&original, &layout, transform).as_slice(),
                "record {i}"
            );
            // The stored position is the pushed one, to the output's
            // resolution (exactly, for wide records).
            let (x, y, z) = format.xyz(stored);
            let tolerance = if transform.is_some() {
                0.0005 + 1e-9
            } else {
                0.0
            };
            assert!((x - original.x).abs() <= tolerance, "record {i} x");
            assert!((y - original.y).abs() <= tolerance, "record {i} y");
            assert!((z - original.z).abs() <= tolerance, "record {i} z");
        }
    }

    #[test]
    fn quantized_records_are_the_output_point_records() {
        let fs = MemoryScratchFs::new();
        // PDRF 7 (36) + 2 extra bytes, PDRF 6 (30) + 2 extra bytes.
        round_trips_records_and_bounds(&fs, true, true, Some(transform()), 38);
        round_trips_records_and_bounds(&fs, false, true, Some(transform()), 32);
        // Without GPS in the source layout the output still has the field.
        round_trips_records_and_bounds(&fs, true, false, Some(transform()), 38);
    }

    #[test]
    fn wide_records_keep_the_f64_position() {
        let fs = MemoryScratchFs::new();
        round_trips_records_and_bounds(&fs, true, true, None, 50);
        round_trips_records_and_bounds(&fs, false, true, None, 44);
    }

    #[cfg(feature = "native-fs")]
    #[test]
    fn quantized_records_native() {
        let dir = tempfile::tempdir().unwrap();
        round_trips_records_and_bounds(
            &NativeScratchFs::new(dir.path()),
            true,
            true,
            Some(transform()),
            38,
        );
    }

    #[test]
    fn bounds_are_the_original_coordinates() {
        let fs = MemoryScratchFs::new();
        let mut writer = SpillWriter::create(&fs, layout(true, true), Some(transform())).unwrap();
        for seed in 0..256 {
            writer.push(&record(seed)).unwrap();
        }
        let bounds = writer.finalize().unwrap().bounds();
        assert_eq!(bounds.min, (0.0, -573.75, 0.0));
        assert_eq!(bounds.max, (382.5, 0.0, 31.875));
    }

    #[test]
    fn coordinate_outside_the_i32_range_fails_at_push() {
        let fs = MemoryScratchFs::new();
        let mut writer = SpillWriter::create(&fs, layout(true, true), Some(transform())).unwrap();
        let mut far = record(1);
        far.x = 1.0e9; // 1e9 / 0.001 = 1e12, beyond i32
        let error = writer.push(&far).unwrap_err();
        assert!(error.to_string().contains("outside LAS i32 range"));
        // A wide spill takes it: it is quantized only when a node is encoded.
        let mut wide = SpillWriter::create(&fs, layout(true, true), None).unwrap();
        wide.push(&far).unwrap();
    }

    #[test]
    fn scan_angle_survives_as_the_same_las_integer() {
        let fs = MemoryScratchFs::new();
        let layout = layout(false, true);
        let mut writer = SpillWriter::create(&fs, layout.clone(), Some(transform())).unwrap();
        let angles = [-90.0f32, -29.994, -0.003, 0.0, 0.003, 0.006, 12.345, 89.994];
        for angle in angles {
            let mut rec = record(0);
            rec.scan_angle = angle;
            writer.push(&rec).unwrap();
        }
        let reader = writer.finalize().unwrap();
        let width = reader.format().width();
        let run = reader.into_run();
        let bytes = read_run(&run, width).unwrap();
        for (stored, angle) in bytes.chunks_exact(width).zip(angles) {
            // Body byte 6..8 (record byte 18..20) is the LAS 1.4 scan angle.
            let stored_angle = i16::from_le_bytes([stored[18], stored[19]]);
            assert_eq!(
                stored_angle,
                crate::validate::scan_angle_to_las_scaled(angle)
            );
        }
    }

    fn empty_spill_finalizes(fs: &dyn ScratchFs) {
        let writer = SpillWriter::create(fs, layout(true, true), Some(transform())).unwrap();
        let reader = writer.finalize().unwrap();
        assert!(reader.is_empty());
        assert_eq!(0, reader.len());
    }

    #[cfg(feature = "native-fs")]
    #[test]
    fn empty_spill_finalizes_without_mapping_an_empty_file() {
        let dir = tempfile::tempdir().unwrap();
        empty_spill_finalizes(&NativeScratchFs::new(dir.path()));
    }

    #[test]
    fn empty_spill_finalizes_memory() {
        empty_spill_finalizes(&MemoryScratchFs::new());
    }

    #[test]
    fn nir_layout_is_refused() {
        let mut nir = layout(true, true);
        nir.has_nir = true;
        assert!(SpillWriter::create(&MemoryScratchFs::new(), nir, None).is_err());
    }
}
