//! M4-6/M4-9追記(`TaskSheets/M4-import-and-conversion.md`): PCD→COPCの
//! Web版での直接変換。
//!
//! # なぜ`crates/pcv-convert/src/import/pcd.rs`を直接使わず複製したか
//!
//! `crates/pcv-wasm/Cargo.toml`の`pcd-rs`依存のコメントに詳細を書いた。要点:
//! pcv-wasmはルートワークスペースの外にある独立した1クレートのワークスペース
//! なので、ルートワークスペースの通常メンバーである`pcv-convert`へパス依存を
//! 足すとワークスペースの二重定義でcargoがエラーになる(実際に試して確認済み)。
//! 加えて`pcv-convert`の`copc-writer`依存は`parallel-lod`/`parallel-compress`
//! (rayon使用)を要求しており、同じ`[patch.crates-io]`先(vendor/copc-writer)を
//! 共有する以上、依存グラフのフィーチャ統合でpcv-wasmのwasm32ビルドにまで
//! `rayon`が混入してしまう(wasm32向けビルドにrayonが入り込まないという、
//! このプロジェクトの前提を破る)。そのため、PCDの読み込みロジック自体
//! (フィールドの対応・`binary_compressed`の上限チェック)をこのファイルに
//! 独立に書いた(意図した重複)。
//!
//! # Where the conversion happens (M4-17)
//!
//! This file only reads PCD (`PcdStream`: one point at a time). The spill, octree and OPFS
//! output are in `WasmPointFileConverter` (`point_file_import.rs`), shared with PLY / E57 / LAS.
//! The scale and offset are chosen after the spill is finished (`choose_scale_offset` below,
//! a copy of `crates/pcv-convert/src/import/scale.rs`), because PCD coordinates have none.
//! There is no parallel decompression (M4-7): `pcd-rs` decompresses `binary_compressed` all at
//! once in `DynReader::from_reader`, so there is nothing to split.
//!
//! # `binary_compressed`のメモリ上限
//!
//! `pcd-rs`の`DynReader::from_reader`は`DataKind::BinaryCompressed`を検出した
//! その場でLZF圧縮データ全体を展開し(`col_major`)、さらに行優先に転置した
//! もう1つの全体コピー(`row_major`)を作る(展開後サイズの最大2倍のメモリを
//! 使う。`crates/pcv-convert/src/import/pcd.rs`のモジュールドキュメント参照、
//! 同じ`pcd-rs` 0.9.0のソースを根拠にしている)。展開前にヘッダー直後の
//! `uncompressed_size`だけを覗き見て、上限を超えるなら`pcd-rs`の重い展開を
//! 呼ぶ前にエラーで知らせる(デスクトップ版と同じ上限値
//! `MAX_BINARY_COMPRESSED_UNCOMPRESSED_BYTES`)。

use std::io::{BufRead, Seek, SeekFrom};

use byteorder::{LittleEndian, ReadBytesExt};
use pcd_rs::{DynReader, Field};

use crate::point_file_import::RawPoint;

/// `binary_compressed`の展開後サイズの上限。`crates/pcv-convert/src/import/
/// pcd.rs`の`MAX_BINARY_COMPRESSED_UNCOMPRESSED_BYTES`と同じ値・同じ根拠
/// (`pcd-rs`の展開が展開後サイズの最大2倍のメモリを同時に確保する構造上の
/// 制約から見積もった値。実測比ではない)。Web版はデスクトップより利用可能な
/// メモリが少ない端末(モバイル)も対象になるため、この上限の意味は
/// デスクトップ以上に重要。
const MAX_BINARY_COMPRESSED_UNCOMPRESSED_BYTES: u64 = 512 * 1024 * 1024;

/// ヘッダーを自前で行単位に読み進め、`DATA`行が`binary_compressed`なら
/// 展開後サイズを覗き見る。`crates/pcv-convert/src/import/pcd.rs`の
/// `peek_binary_compressed_uncompressed_size`と同じロジック(複製の理由は
/// モジュールドキュメント参照)。
fn peek_binary_compressed_uncompressed_size<R: BufRead>(
    reader: &mut R,
) -> Result<Option<u64>, String> {
    const MAX_HEADER_LINES: usize = 64;

    let mut line = String::new();
    for _ in 0..MAX_HEADER_LINES {
        line.clear();
        let n = reader.read_line(&mut line).map_err(|e| e.to_string())?;
        if n == 0 {
            return Ok(None);
        }
        let mut tokens = line.split_whitespace();
        if tokens.next() == Some("DATA") {
            let kind = tokens.next();
            if kind != Some("binary_compressed") {
                return Ok(None);
            }
            let _compressed_size = reader
                .read_u32::<LittleEndian>()
                .map_err(|e| e.to_string())?;
            let uncompressed_size = reader
                .read_u32::<LittleEndian>()
                .map_err(|e| e.to_string())?;
            return Ok(Some(u64::from(uncompressed_size)));
        }
    }
    Ok(None)
}

/// `i32`で表現できる絶対値の上限。`crates/pcv-convert/src/import/scale.rs`と
/// 同じ(複製の理由はモジュールドキュメント参照)。
const I32_ABS_MAX: f64 = i32::MAX as f64;
const SCALE_CANDIDATES: [f64; 8] = [0.0001, 0.001, 0.01, 0.1, 1.0, 10.0, 100.0, 1000.0];

/// `crates/pcv-convert/src/import/scale.rs`の`choose_scale_offset`と同じ
/// ロジック(複製の理由はモジュールドキュメント参照。テストは同クレート側で
/// 既に手厚く行われているため、ここでは最小限の回帰テストだけ持つ)。
pub(crate) fn choose_scale_offset(
    min: (f64, f64, f64),
    max: (f64, f64, f64),
) -> ((f64, f64, f64), (f64, f64, f64)) {
    let scale = (
        choose_axis_scale(min.0, max.0),
        choose_axis_scale(min.1, max.1),
        choose_axis_scale(min.2, max.2),
    );
    (scale, min)
}

fn choose_axis_scale(min: f64, max: f64) -> f64 {
    let range = (max - min).abs();
    for &candidate in &SCALE_CANDIDATES {
        if range / candidate <= I32_ABS_MAX {
            return candidate;
        }
    }
    range / I32_ABS_MAX
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

/// A PCD file opened after its header. `next_point` reads one record at a time.
///
/// M4-17: this replaces the old `WasmPcdConverter` class. Reading PCD is now only "give me the
/// next point", like `PlyStream` and `E57Stream`; the spill / octree / OPFS part is the one
/// shared `WasmPointFileConverter` (`point_file_import.rs`).
pub(crate) struct PcdStream<R: BufRead> {
    reader: DynReader<R>,
    ix: usize,
    iy: usize,
    iz: usize,
    i_rgb: Option<usize>,
    i_intensity: Option<usize>,
    total_points: u64,
}

impl<R: BufRead + Seek> PcdStream<R> {
    pub(crate) fn open(mut buffered: R) -> Result<Self, String> {
        if let Some(uncompressed_bytes) = peek_binary_compressed_uncompressed_size(&mut buffered)? {
            if uncompressed_bytes > MAX_BINARY_COMPRESSED_UNCOMPRESSED_BYTES {
                return Err(format!(
                    "binary_compressedの展開後サイズ({uncompressed_bytes}バイト)が上限\
                     ({MAX_BINARY_COMPRESSED_UNCOMPRESSED_BYTES}バイト)を超える。この形式は\
                     展開にブロック全体をメモリに載せる必要があり、点数に比例してメモリを\
                     消費する。デスクトップ版で、より小さく分割するか、ASCII/binary(非圧縮)\
                     形式に変換してから開いてください"
                ));
            }
        }
        buffered
            .seek(SeekFrom::Start(0))
            .map_err(|e| e.to_string())?;

        let reader = DynReader::from_reader(buffered).map_err(|e| e.to_string())?;
        let meta = reader.meta().clone();
        let field_index = |name: &str| meta.field_defs.iter().position(|f| f.name == name);
        let missing = || "PCDにx/y/zフィールドが無い".to_string();
        let ix = field_index("x").ok_or_else(missing)?;
        let iy = field_index("y").ok_or_else(missing)?;
        let iz = field_index("z").ok_or_else(missing)?;
        Ok(Self {
            reader,
            ix,
            iy,
            iz,
            i_rgb: field_index("rgb"),
            i_intensity: field_index("intensity"),
            total_points: meta.num_points,
        })
    }

    pub(crate) fn has_color(&self) -> bool {
        self.i_rgb.is_some()
    }

    pub(crate) fn declared_point_count(&self) -> u64 {
        self.total_points
    }

    /// The next record as a point, or `None` at the end.
    pub(crate) fn next_point(&mut self) -> Result<Option<RawPoint>, String> {
        match self.reader.next() {
            Some(Ok(record)) => {
                let color = self
                    .i_rgb
                    .map(|i| decode_packed_rgb(&record.0[i]))
                    .unwrap_or([0, 0, 0]);
                let intensity = self
                    .i_intensity
                    .map(|i| field_to_u16_clamped(&record.0[i]))
                    .unwrap_or(0);
                Ok(Some(RawPoint {
                    x: field_to_f64(&record.0[self.ix]),
                    y: field_to_f64(&record.0[self.iy]),
                    z: field_to_f64(&record.0[self.iz]),
                    color,
                    intensity,
                }))
            }
            Some(Err(e)) => Err(e.to_string()),
            None => Ok(None),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `crates/pcv-convert/src/import/scale.rs`の同名テストと同じ確認
    /// (複製した関数が同じ振る舞いをすることの最小限の回帰テスト)。
    #[test]
    fn choose_scale_offset_picks_finest_candidate_for_small_range() {
        let (scale, offset) = choose_scale_offset((-10.0, -5.0, 0.0), (40.0, 55.0, 20.0));
        assert_eq!(scale, (0.0001, 0.0001, 0.0001));
        assert_eq!(offset, (-10.0, -5.0, 0.0));
    }

    #[test]
    fn choose_scale_offset_degenerate_zero_range_does_not_panic() {
        let (scale, offset) = choose_scale_offset((1.0, 2.0, 3.0), (1.0, 2.0, 3.0));
        assert_eq!(scale, (0.0001, 0.0001, 0.0001));
        assert_eq!(offset, (1.0, 2.0, 3.0));
    }

    #[test]
    fn decode_packed_rgb_u32_matches_byte_order() {
        let packed = Field::U32(vec![0x00_11_22_33]);
        assert_eq!(
            decode_packed_rgb(&packed),
            [0x11 * 257, 0x22 * 257, 0x33 * 257]
        );
    }

    /// M4-6/M4-9追記の受け入れ条件: `binary_compressed`の上限チェックは
    /// `pcd-rs`の重い展開を呼ぶ前に、ヘッダー直後の8バイトだけを覗いて判定する。
    /// `crates/pcv-convert/src/import/pcd.rs`の同種のテストと同じ考え方
    /// (複製の理由はモジュールドキュメント参照)。
    #[test]
    fn peek_binary_compressed_size_reads_header_declared_uncompressed_size() {
        let mut header = Vec::new();
        header.extend_from_slice(b"# comment\n");
        header.extend_from_slice(b"VERSION 0.7\n");
        header.extend_from_slice(b"DATA binary_compressed\n");
        header.extend_from_slice(&100u32.to_le_bytes()); // compressed_size
        header.extend_from_slice(&999u32.to_le_bytes()); // uncompressed_size
        let mut reader = std::io::BufReader::new(std::io::Cursor::new(header));
        let size = peek_binary_compressed_uncompressed_size(&mut reader)
            .expect("peekが失敗した")
            .expect("binary_compressedとして検出されるはず");
        assert_eq!(size, 999);
    }

    #[test]
    fn peek_binary_compressed_size_returns_none_for_other_data_kinds() {
        let mut header = Vec::new();
        header.extend_from_slice(b"VERSION 0.7\n");
        header.extend_from_slice(b"DATA binary\n");
        let mut reader = std::io::BufReader::new(std::io::Cursor::new(header));
        let size = peek_binary_compressed_uncompressed_size(&mut reader).expect("peekが失敗した");
        assert_eq!(size, None);
    }
}
