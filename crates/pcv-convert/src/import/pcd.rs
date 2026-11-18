use std::io::{BufRead, Seek, SeekFrom};

use byteorder::{LittleEndian, ReadBytesExt};
use pcd_rs::{DynReader, Field};

use super::point::{PointSource, RawPoint};
use super::ImportError;

#[derive(Debug, thiserror::Error)]
pub enum PcdError {
    #[error("入出力エラー: {0}")]
    Io(#[from] std::io::Error),
    #[error("PCDの読み込みに失敗した: {0}")]
    PcdRs(#[from] pcd_rs::Error),
    #[error("PCDに x/y/z フィールドが無い")]
    MissingXyz,
    #[error(
        "binary_compressedの展開後サイズ({uncompressed_bytes}バイト)が上限\
         ({limit_bytes}バイト)を超える。この形式は展開にブロック全体をメモリに\
         載せる必要があり(モジュールのドキュメント参照)、点数に比例してメモリを\
         消費する。デスクトップ版で、より小さく分割するか、ASCII/binary(非圧縮)\
         形式に変換してから開いてください"
    )]
    BinaryCompressedTooLarge {
        uncompressed_bytes: u64,
        limit_bytes: u64,
    },
}

const MAX_BINARY_COMPRESSED_UNCOMPRESSED_BYTES: u64 = 512 * 1024 * 1024;

pub(crate) struct PcdSource<R: BufRead> {
    reader: DynReader<R>,
    ix: usize,
    iy: usize,
    iz: usize,
    i_rgb: Option<usize>,
    i_intensity: Option<usize>,
    has_color: bool,
    num_points: u64,
}

impl<R: BufRead + Seek> PcdSource<R> {
    pub(crate) fn open(mut reader: R) -> Result<Self, ImportError> {
        if let Some(uncompressed_bytes) = peek_binary_compressed_uncompressed_size(&mut reader)? {
            if uncompressed_bytes > MAX_BINARY_COMPRESSED_UNCOMPRESSED_BYTES {
                return Err(ImportError::Pcd(PcdError::BinaryCompressedTooLarge {
                    uncompressed_bytes,
                    limit_bytes: MAX_BINARY_COMPRESSED_UNCOMPRESSED_BYTES,
                }));
            }
        }
        reader.seek(SeekFrom::Start(0)).map_err(PcdError::from)?;

        let reader = DynReader::from_reader(reader).map_err(PcdError::from)?;
        let meta = reader.meta().clone();

        let field_index = |name: &str| meta.field_defs.iter().position(|f| f.name == name);
        let ix = field_index("x").ok_or(PcdError::MissingXyz)?;
        let iy = field_index("y").ok_or(PcdError::MissingXyz)?;
        let iz = field_index("z").ok_or(PcdError::MissingXyz)?;
        let i_rgb = field_index("rgb");
        let i_intensity = field_index("intensity");

        Ok(Self {
            reader,
            ix,
            iy,
            iz,
            i_rgb,
            i_intensity,
            has_color: i_rgb.is_some(),
            num_points: meta.num_points,
        })
    }
}

impl<R: BufRead> PointSource for PcdSource<R> {
    fn has_color(&self) -> bool {
        self.has_color
    }

    fn declared_point_count(&self) -> u64 {
        self.num_points
    }

    fn for_each_point(
        self,
        visit: &mut dyn FnMut(RawPoint) -> Result<(), ImportError>,
    ) -> Result<(), ImportError> {
        let PcdSource {
            reader,
            ix,
            iy,
            iz,
            i_rgb,
            i_intensity,
            ..
        } = self;
        for record in reader {
            let record = record.map_err(PcdError::from)?;
            let x = field_to_f64(&record.0[ix]);
            let y = field_to_f64(&record.0[iy]);
            let z = field_to_f64(&record.0[iz]);
            let color = i_rgb
                .map(|i| decode_packed_rgb(&record.0[i]))
                .unwrap_or([0, 0, 0]);
            let intensity = i_intensity
                .map(|i| field_to_u16_clamped(&record.0[i]))
                .unwrap_or(0);
            visit(RawPoint {
                x,
                y,
                z,
                color,
                intensity,
            })?;
        }
        Ok(())
    }
}

fn peek_binary_compressed_uncompressed_size<R: BufRead>(
    reader: &mut R,
) -> Result<Option<u64>, PcdError> {
    const MAX_HEADER_LINES: usize = 64;

    let mut line = String::new();
    for _ in 0..MAX_HEADER_LINES {
        line.clear();
        let n = reader.read_line(&mut line)?;
        if n == 0 {
            return Ok(None);
        }
        let mut tokens = line.split_whitespace();
        if tokens.next() == Some("DATA") {
            let kind = tokens.next();
            if kind != Some("binary_compressed") {
                return Ok(None);
            }
            let _compressed_size = reader.read_u32::<LittleEndian>()?;
            let uncompressed_size = reader.read_u32::<LittleEndian>()?;
            return Ok(Some(u64::from(uncompressed_size)));
        }
    }
    Ok(None)
}

fn field_to_f64(field: &Field) -> f64 {
    match field {
        Field::I8(v) => v.first().copied().unwrap_or(0) as f64,
        Field::I16(v) => v.first().copied().unwrap_or(0) as f64,
        Field::I32(v) => v.first().copied().unwrap_or(0) as f64,
        Field::I64(v) => v.first().copied().unwrap_or(0) as f64,
        Field::U8(v) => v.first().copied().unwrap_or(0) as f64,
        Field::U16(v) => v.first().copied().unwrap_or(0) as f64,
        Field::U32(v) => v.first().copied().unwrap_or(0) as f64,
        Field::U64(v) => v.first().copied().unwrap_or(0) as f64,
        Field::F32(v) => v.first().copied().unwrap_or(0.0) as f64,
        Field::F64(v) => v.first().copied().unwrap_or(0.0),
    }
}

fn field_to_u16_clamped(field: &Field) -> u16 {
    field_to_f64(field).round().clamp(0.0, u16::MAX as f64) as u16
}

fn decode_packed_rgb(field: &Field) -> [u16; 3] {
    let (r, g, b) = match field {
        Field::F32(v) => pcd_rs::float_to_rgb(v.first().copied().unwrap_or(0.0)),
        Field::U32(v) => {
            let packed = v.first().copied().unwrap_or(0);
            (
                ((packed >> 16) & 0xFF) as u8,
                ((packed >> 8) & 0xFF) as u8,
                (packed & 0xFF) as u8,
            )
        }
        _ => (0, 0, 0),
    };
    [
        scale_8bit_to_16bit(r),
        scale_8bit_to_16bit(g),
        scale_8bit_to_16bit(b),
    ]
}

fn scale_8bit_to_16bit(v: u8) -> u16 {
    u16::from(v) * 257
}
