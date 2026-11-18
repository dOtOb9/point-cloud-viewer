use std::fs::File;
use std::io::{BufWriter, Seek, SeekFrom, Write};
use std::path::Path;

use byteorder::{LittleEndian, WriteBytesExt};
use copc_core::{CopcInfo, Entry, HierarchyPage};
use las::{Color, Transform, Vector};

use crate::octree::Node;
use crate::point::SourceCloud;

const LAS_HEADER_BYTES: u64 = 375;
const VLR_HEADER_BYTES: u64 = 54;
const EVLR_HEADER_BYTES: u64 = 60;
const COPC_INFO_VLR_BODY_BYTES: u64 = 160;
const COPC_USER_ID: &str = "copc";
const COPC_INFO_RECORD_ID: u16 = 1;
const COPC_HIERARCHY_RECORD_ID: u16 = 1000;
const NO_FILE_SOURCE_ID: u16 = 0;
const GLOBAL_ENCODING_WKT_BIT_REQUIRED_BY_PCV_CORE_FOR_COPC: u16 = 0x10;
const UNUSED_PROJECT_GUID: [u8; 16] = [0; 16];
const LAS_VERSION_MAJOR: u8 = 1;
const LAS_VERSION_MINOR: u8 = 4;
const VLR_COUNT_LASZIP_AND_COPC_INFO: u32 = 2;
const POINT_FORMAT_LAZ_COMPRESSED_BIT: u8 = 0x80;
const LEGACY_POINT_COUNT_UNUSED_IN_LAS_1_4: u32 = 0;
const LEGACY_POINTS_BY_RETURN_COUNT: usize = 5;
const LEGACY_POINTS_BY_RETURN_UNUSED_IN_LAS_1_4: u32 = 0;
const NO_WAVEFORM_DATA_PACKET: u64 = 0;
const EVLR_COUNT_ONE_HIERARCHY_PAGE: u32 = 1;
const POINTS_BY_RETURN_COUNT: usize = 15;
const NO_POINTS_BY_RETURN_CARRIED: u64 = 0;
const VLR_RESERVED: u16 = 0;
const LAS_1_4_OVERLAP_CLASS_REJECTED_BY_LAS_CRATE: u8 = 12;

#[derive(Debug, thiserror::Error)]
pub enum WriteError {
    #[error("入出力エラー: {0}")]
    Io(#[from] std::io::Error),
    #[error("点データのシリアライズに失敗した: {0}")]
    Las(#[from] las::Error),
    #[error("LAZ圧縮に失敗した: {0}")]
    Laz(#[from] laz::LasZipError),
    #[error("COPCバイナリ構造の組み立てに失敗した: {0}")]
    CopcCore(#[from] copc_core::Error),
}

pub struct WriteStats {
    pub node_count: usize,
    pub total_points: u64,
    pub output_bytes: u64,
}

pub fn write(
    out_path: &Path,
    source: &SourceCloud,
    nodes: &[Node],
    center: (f64, f64, f64),
    halfsize: f64,
) -> Result<WriteStats, WriteError> {
    let point_format_id: u8 = if source.has_color { 7 } else { 6 };
    let format = las::point::Format::new(point_format_id)?;
    let point_record_length = format.len();

    let transforms = Vector {
        x: Transform {
            scale: source.scale.0,
            offset: source.offset.0,
        },
        y: Transform {
            scale: source.scale.1,
            offset: source.offset.1,
        },
        z: Transform {
            scale: source.scale.2,
            offset: source.offset.2,
        },
    };

    let laz_vlr = laz::LazVlrBuilder::default()
        .with_point_format(point_format_id, 0)?
        .with_variable_chunk_size()
        .build();
    let mut laz_vlr_bytes = Vec::new();
    laz_vlr.write_to(&mut laz_vlr_bytes)?;

    let laz_vlr_total_bytes = VLR_HEADER_BYTES + laz_vlr_bytes.len() as u64;
    let copc_info_vlr_total_bytes = VLR_HEADER_BYTES + COPC_INFO_VLR_BODY_BYTES;
    let offset_to_point_data = LAS_HEADER_BYTES + copc_info_vlr_total_bytes + laz_vlr_total_bytes;
    let copc_info_body_offset = LAS_HEADER_BYTES + VLR_HEADER_BYTES;

    let total_points: u64 = nodes.iter().map(|n| n.indices.len() as u64).sum();

    let file = File::create(out_path)?;
    let mut writer = BufWriter::with_capacity(1 << 20, file);

    let header = HeaderFields {
        point_format_id,
        point_record_length,
        offset_to_point_data: u32::try_from(offset_to_point_data)
            .expect("ヘッダ+VLRは32bitに収まる小ささ"),
        scale: source.scale,
        offset: source.offset,
        bounds_min: source.bounds_min,
        bounds_max: source.bounds_max,
        total_point_count: total_points,
        start_of_first_evlr: 0,
    };
    header.write(&mut writer)?;

    write_vlr_header(
        &mut writer,
        COPC_USER_ID,
        COPC_INFO_RECORD_ID,
        COPC_INFO_VLR_BODY_BYTES as u16,
        "https://copc.io",
    )?;
    writer.write_all(&[0u8; COPC_INFO_VLR_BODY_BYTES as usize])?;

    write_vlr_header(
        &mut writer,
        laz::LazVlr::USER_ID,
        laz::LazVlr::RECORD_ID,
        laz_vlr_bytes.len() as u16,
        laz::LazVlr::DESCRIPTION,
    )?;
    writer.write_all(&laz_vlr_bytes)?;

    debug_assert_eq!(writer.stream_position()?, offset_to_point_data);

    let mut compressor = laz::LasZipCompressor::new(writer, laz_vlr)?;
    compressor.reserve_offset_to_chunk_table()?;
    let mut entries = Vec::with_capacity(nodes.len());
    let mut point_buf = Vec::with_capacity(point_record_length as usize);
    for node in nodes {
        let chunk_offset = compressor.get_mut().stream_position()?;
        for &idx in &node.indices {
            let p = source.points[idx as usize];
            let las_point = las::Point {
                x: p.x,
                y: p.y,
                z: p.z,
                intensity: p.intensity,
                return_number: 1,
                number_of_returns: 1,
                color: source
                    .has_color
                    .then(|| Color::new(p.color[0], p.color[1], p.color[2])),
                ..classification_point(p.classification)
            };
            let raw_point = las_point.into_raw(&transforms)?;
            point_buf.clear();
            raw_point.write_to(&mut point_buf, &format)?;
            compressor.compress_one(&point_buf)?;
        }
        compressor.finish_current_chunk()?;
        let chunk_end = compressor.get_mut().stream_position()?;
        entries.push(Entry {
            key: node.key,
            offset: chunk_offset,
            byte_size: i32::try_from(chunk_end - chunk_offset)
                .expect("1ノード分のLAZチャンクはi32に収まる"),
            point_count: i32::try_from(node.indices.len()).expect("1ノードの点数はi32に収まる"),
        });
    }
    compressor.done()?;
    let mut writer = compressor.into_inner();

    let start_of_first_evlr = writer.stream_position()?;
    let hierarchy_bytes = HierarchyPage::new(entries).write_le_bytes()?;
    write_evlr_header(
        &mut writer,
        COPC_USER_ID,
        COPC_HIERARCHY_RECORD_ID,
        hierarchy_bytes.len() as u64,
        "https://copc.io",
    )?;
    writer.write_all(&hierarchy_bytes)?;
    let output_bytes = writer.stream_position()?;

    writer.seek(SeekFrom::Start(0))?;
    let header = HeaderFields {
        start_of_first_evlr,
        ..header
    };
    header.write(&mut writer)?;

    let volume = (halfsize * 2.0).powi(3);
    let spacing = (volume / total_points.max(1) as f64)
        .cbrt()
        .max(f64::MIN_POSITIVE);

    let copc_info = CopcInfo {
        center,
        halfsize,
        spacing,
        root_hier_offset: start_of_first_evlr + EVLR_HEADER_BYTES,
        root_hier_size: hierarchy_bytes.len() as u64,
        gpstime_min: 0.0,
        gpstime_max: 0.0,
    };
    writer.seek(SeekFrom::Start(copc_info_body_offset))?;
    writer.write_all(&copc_info.write_le_bytes()?)?;

    writer.flush()?;

    Ok(WriteStats {
        node_count: nodes.len(),
        total_points,
        output_bytes,
    })
}

fn classification_point(code: u8) -> las::Point {
    if code == LAS_1_4_OVERLAP_CLASS_REJECTED_BY_LAS_CRATE {
        las::Point {
            classification: las::point::Classification::Unclassified,
            is_overlap: true,
            ..Default::default()
        }
    } else {
        las::Point {
            classification: las::point::Classification::new(code)
                .unwrap_or(las::point::Classification::Unclassified),
            ..Default::default()
        }
    }
}

struct HeaderFields {
    point_format_id: u8,
    point_record_length: u16,
    offset_to_point_data: u32,
    scale: (f64, f64, f64),
    offset: (f64, f64, f64),
    bounds_min: (f64, f64, f64),
    bounds_max: (f64, f64, f64),
    total_point_count: u64,
    start_of_first_evlr: u64,
}

impl HeaderFields {
    fn write<W: Write>(&self, w: &mut W) -> std::io::Result<()> {
        w.write_all(b"LASF")?;
        w.write_u16::<LittleEndian>(NO_FILE_SOURCE_ID)?;
        w.write_u16::<LittleEndian>(GLOBAL_ENCODING_WKT_BIT_REQUIRED_BY_PCV_CORE_FOR_COPC)?;
        w.write_all(&UNUSED_PROJECT_GUID)?;
        w.write_u8(LAS_VERSION_MAJOR)?;
        w.write_u8(LAS_VERSION_MINOR)?;
        w.write_all(&pad_ascii("pcv-convert (M4-1 spike)", 32))?;
        w.write_all(&pad_ascii("pcv-convert 0.1", 32))?;
        let (day, year) = creation_day_and_year();
        w.write_u16::<LittleEndian>(day)?;
        w.write_u16::<LittleEndian>(year)?;
        w.write_u16::<LittleEndian>(LAS_HEADER_BYTES as u16)?;
        w.write_u32::<LittleEndian>(self.offset_to_point_data)?;
        w.write_u32::<LittleEndian>(VLR_COUNT_LASZIP_AND_COPC_INFO)?;
        w.write_u8(self.point_format_id | POINT_FORMAT_LAZ_COMPRESSED_BIT)?;
        w.write_u16::<LittleEndian>(self.point_record_length)?;
        w.write_u32::<LittleEndian>(LEGACY_POINT_COUNT_UNUSED_IN_LAS_1_4)?;
        for _ in 0..LEGACY_POINTS_BY_RETURN_COUNT {
            w.write_u32::<LittleEndian>(LEGACY_POINTS_BY_RETURN_UNUSED_IN_LAS_1_4)?;
        }
        w.write_f64::<LittleEndian>(self.scale.0)?;
        w.write_f64::<LittleEndian>(self.scale.1)?;
        w.write_f64::<LittleEndian>(self.scale.2)?;
        w.write_f64::<LittleEndian>(self.offset.0)?;
        w.write_f64::<LittleEndian>(self.offset.1)?;
        w.write_f64::<LittleEndian>(self.offset.2)?;
        w.write_f64::<LittleEndian>(self.bounds_max.0)?;
        w.write_f64::<LittleEndian>(self.bounds_min.0)?;
        w.write_f64::<LittleEndian>(self.bounds_max.1)?;
        w.write_f64::<LittleEndian>(self.bounds_min.1)?;
        w.write_f64::<LittleEndian>(self.bounds_max.2)?;
        w.write_f64::<LittleEndian>(self.bounds_min.2)?;
        w.write_u64::<LittleEndian>(NO_WAVEFORM_DATA_PACKET)?;
        w.write_u64::<LittleEndian>(self.start_of_first_evlr)?;
        w.write_u32::<LittleEndian>(EVLR_COUNT_ONE_HIERARCHY_PAGE)?;
        w.write_u64::<LittleEndian>(self.total_point_count)?;
        for _ in 0..POINTS_BY_RETURN_COUNT {
            w.write_u64::<LittleEndian>(NO_POINTS_BY_RETURN_CARRIED)?;
        }
        Ok(())
    }
}

fn write_vlr_header<W: Write>(
    w: &mut W,
    user_id: &str,
    record_id: u16,
    body_size: u16,
    description: &str,
) -> std::io::Result<()> {
    w.write_u16::<LittleEndian>(VLR_RESERVED)?;
    w.write_all(&pad_ascii(user_id, 16))?;
    w.write_u16::<LittleEndian>(record_id)?;
    w.write_u16::<LittleEndian>(body_size)?;
    w.write_all(&pad_ascii(description, 32))?;
    Ok(())
}

fn write_evlr_header<W: Write>(
    w: &mut W,
    user_id: &str,
    record_id: u16,
    body_size: u64,
    description: &str,
) -> std::io::Result<()> {
    w.write_u16::<LittleEndian>(VLR_RESERVED)?;
    w.write_all(&pad_ascii(user_id, 16))?;
    w.write_u16::<LittleEndian>(record_id)?;
    w.write_u64::<LittleEndian>(body_size)?;
    w.write_all(&pad_ascii(description, 32))?;
    Ok(())
}

fn pad_ascii(value: &str, len: usize) -> Vec<u8> {
    let mut out = value.as_bytes()[..value.len().min(len)].to_vec();
    out.resize(len, 0);
    out
}

fn creation_day_and_year() -> (u16, u16) {
    let days_since_epoch = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() / 86_400)
        .unwrap_or(0);

    let mut year = 1970u16;
    let mut remaining = days_since_epoch;
    loop {
        let days_in_year = if is_leap_year(year) { 366 } else { 365 };
        if remaining < days_in_year {
            break;
        }
        remaining -= days_in_year;
        year += 1;
    }
    (u16::try_from(remaining + 1).unwrap_or(1), year)
}

fn is_leap_year(year: u16) -> bool {
    (year.is_multiple_of(4) && !year.is_multiple_of(100)) || year.is_multiple_of(400)
}
