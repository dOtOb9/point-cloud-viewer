//! Disk spill for streaming COPC writes.
//!
//! M4-6a(`TaskSheets/M4-import-and-conversion.md`参照)で、ファイルシステムへの
//! 直接アクセス(`tempfile`・`memmap2`)を`crate::scratch::ScratchFs`トレイト
//! 経由に差し替えた。`SpillWriter`/`SpillReader`自体のアルゴリズムは変えて
//! いない。ネイティブの既定実装(`NativeScratchFs`)は今までどおり一時ファイル
//! +mmapで、振る舞いは変わっていない(改修前後で出力がバイト同一であることを
//! 確認済み。`PATCH.md`参照)。

use std::io::{BufWriter, Write};
use std::sync::Arc;

use copc_core::{
    deserialize_le_into, serialize_le, Bounds, Error, LasPointRecord, Result, StreamingLayout,
};

use crate::scratch::{ScratchFs, ScratchReader, ScratchWriter};
use crate::validate::{validate_spill_record, PointStats};

const SPILL_IO_BUFFER_BYTES: usize = 1024 * 1024;

/// Streams `LasPointRecord` values to a process-local temporary spill file.
///
/// Records are validated at intake (coordinates, scan angle, LAS field
/// ranges, GPS time) and output statistics are accumulated as they stream in,
/// so spill-backed COPC writes need no second validation pass over the data.
pub struct SpillWriter {
    file: Option<BufWriter<Box<dyn ScratchWriter>>>,
    layout: StreamingLayout,
    record_width: usize,
    scratch: Vec<u8>,
    count: u64,
    bounds: Option<Bounds>,
    stats: PointStats,
}

impl SpillWriter {
    /// `fs`が一時ファイルの実際の置き場所(OS一時ファイルかメモリ上のバッファ
    /// か)を決める。呼び出し側(`writer.rs`)は、今までの`spill_dir`引数と
    /// 同じ場所を指す`NativeScratchFs`を渡す。
    pub fn create(fs: &dyn ScratchFs, layout: StreamingLayout) -> Result<Self> {
        let file = fs.create_temp("spill")?;
        let record_width = layout.record_width();
        Ok(Self {
            file: Some(BufWriter::with_capacity(SPILL_IO_BUFFER_BYTES, file)),
            layout,
            record_width,
            scratch: vec![0u8; record_width],
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
        serialize_le(record, &self.layout, &mut self.scratch)
            .map_err(|e| Error::InvalidInput(format!("encode spill record: {e}")))?;
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
        let bytes = reader.as_bytes()?;
        let expected = self
            .record_width
            .checked_mul(count)
            .ok_or_else(|| Error::InvalidInput("spill size overflow".into()))?;
        let actual = bytes.as_ref().as_ref().len();
        if actual != expected {
            return Err(Error::InvalidInput(format!(
                "spill file is {} bytes, expected {}",
                actual, expected
            )));
        }
        let bounds = self.bounds.unwrap_or_else(|| Bounds::point(0.0, 0.0, 0.0));
        Ok(SpillReader {
            _reader: reader,
            bytes,
            layout: self.layout,
            record_width: self.record_width,
            count,
            bounds,
            stats: self.stats,
        })
    }
}

/// Random-access view over a finalized spill file. Backed by
/// `crate::scratch::ScratchReader::as_bytes` (native: an `mmap`'d region,
/// not a copy; see the module docs).
pub struct SpillReader {
    /// RAII: 一時ファイル(ネイティブ実装)を、このリーダーが生きている間
    /// 保持する(dropで削除される)。フィールド自体は読み出さない。
    _reader: Box<dyn ScratchReader>,
    bytes: Arc<dyn AsRef<[u8]> + Send + Sync>,
    layout: StreamingLayout,
    record_width: usize,
    count: usize,
    bounds: Bounds,
    stats: PointStats,
}

impl SpillReader {
    pub(crate) fn stats(&self) -> PointStats {
        self.stats
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

    pub fn bounds(&self) -> Bounds {
        self.bounds
    }

    #[inline]
    fn record_bytes(&self, index: usize) -> Result<&[u8]> {
        let start = index
            .checked_mul(self.record_width)
            .ok_or_else(|| Error::InvalidData("spill record offset overflow".into()))?;
        let end = start
            .checked_add(self.record_width)
            .ok_or_else(|| Error::InvalidData("spill record end overflow".into()))?;
        let data: &[u8] = self.bytes.as_ref().as_ref();
        data.get(start..end)
            .ok_or_else(|| Error::InvalidData("spill record range exceeds memory map".into()))
    }

    #[inline]
    pub fn xyz_at(&self, index: usize) -> Result<(f64, f64, f64)> {
        if index >= self.count {
            return Err(Error::InvalidInput(format!(
                "spill index {index} out of range (len {})",
                self.count
            )));
        }
        let bytes = self.record_bytes(index)?;
        let x = f64::from_le_bytes(bytes[0..8].try_into().expect("spill x width"));
        let y = f64::from_le_bytes(bytes[8..16].try_into().expect("spill y width"));
        let z = f64::from_le_bytes(bytes[16..24].try_into().expect("spill z width"));
        Ok((x, y, z))
    }

    pub fn record_at(&self, index: usize) -> Result<LasPointRecord> {
        let mut record = LasPointRecord::default();
        self.record_into(index, &mut record)?;
        Ok(record)
    }

    /// Decode the record at `index` into `out`, reusing its allocations.
    pub fn record_into(&self, index: usize, out: &mut LasPointRecord) -> Result<()> {
        if index >= self.count {
            return Err(Error::InvalidInput(format!(
                "spill index {index} out of range (len {})",
                self.count
            )));
        }
        deserialize_le_into(self.record_bytes(index)?, &self.layout, out)
            .map_err(|e| Error::InvalidData(format!("decode spill record {index}: {e}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scratch::MemoryScratchFs;
    #[cfg(feature = "native-fs")]
    use crate::scratch::NativeScratchFs;

    fn layout_with_color() -> StreamingLayout {
        StreamingLayout {
            point_format: 3,
            has_gps: true,
            has_color: true,
            has_nir: false,
            has_waveform: false,
            extra_bytes: 2,
            extra_bytes_descriptors: Vec::new(),
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
            scan_angle: (seed as f32) - 100.25,
            user_data: (seed % 256) as u8,
            point_source_id: seed as u16,
            synthetic: seed.is_multiple_of(4),
            key_point: seed % 4 == 1,
            withheld: seed % 4 == 2,
            overlap: false,
            scan_channel: 0,
            gps_time: 1.0e9 + f,
            red: (seed * 7) as u16,
            green: (seed * 11) as u16,
            blue: (seed * 13) as u16,
            nir: 0,
            wave_packet_descriptor_index: 0,
            byte_offset_to_waveform_data: 0,
            waveform_packet_size: 0,
            return_point_waveform_location: 0.0,
            extra_bytes: vec![(seed & 0xff) as u8, ((seed >> 8) & 0xff) as u8],
        }
    }

    /// spill.rs自身のテストは、`ScratchFs`の実装がネイティブでもメモリでも
    /// 同じ結果になることを確かめる(M4-6aの受け入れ条件「メモリ上の実装で
    /// ネイティブのテストが通ること」)。ファイル削除・パーミッションなど
    /// ネイティブ固有の振る舞いは`scratch.rs`側のテストで確認している。
    fn round_trips_records_and_bounds(fs: &dyn ScratchFs) {
        let layout = layout_with_color();
        let mut writer = SpillWriter::create(fs, layout).unwrap();
        let originals: Vec<LasPointRecord> = (0..256).map(record).collect();
        for rec in &originals {
            writer.push(rec).unwrap();
        }
        assert_eq!(writer.count(), 256);
        let reader = writer.finalize().unwrap();
        assert_eq!(reader.len(), 256);
        for (i, original) in originals.iter().enumerate() {
            assert_eq!(reader.record_at(i).unwrap(), *original);
            assert_eq!(
                reader.xyz_at(i).unwrap(),
                (original.x, original.y, original.z)
            );
        }
        let bounds = reader.bounds();
        assert_eq!(bounds.min, (0.0, -573.75, 0.0));
        assert_eq!(bounds.max, (382.5, 0.0, 31.875));
    }

    #[cfg(feature = "native-fs")]
    #[test]
    fn spill_round_trips_records_and_bounds_native() {
        let dir = tempfile::tempdir().unwrap();
        round_trips_records_and_bounds(&NativeScratchFs::new(dir.path()));
    }

    #[test]
    fn spill_round_trips_records_and_bounds_memory() {
        round_trips_records_and_bounds(&MemoryScratchFs::new());
    }

    fn empty_spill_finalizes_without_reading_out_of_range(fs: &dyn ScratchFs) {
        let writer = SpillWriter::create(fs, layout_with_color()).unwrap();
        let reader = writer.finalize().unwrap();
        assert!(reader.is_empty());
        assert_eq!(0, reader.len());
        assert!(reader.record_at(0).is_err());
    }

    #[cfg(feature = "native-fs")]
    #[test]
    fn empty_spill_finalizes_without_mapping_an_empty_file() {
        let dir = tempfile::tempdir().unwrap();
        empty_spill_finalizes_without_reading_out_of_range(&NativeScratchFs::new(dir.path()));
    }

    #[test]
    fn empty_spill_finalizes_without_reading_out_of_range_memory() {
        empty_spill_finalizes_without_reading_out_of_range(&MemoryScratchFs::new());
    }
}
