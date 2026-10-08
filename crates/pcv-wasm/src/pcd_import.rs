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
//! # 変換の流れ(LAS/LAZ版`convert.rs`との違い)
//!
//! `SpillWriter::create`→`push`→`finalize`→`write_copc_from_spill_with_fs`という
//! 部品はLAS/LAZ版(`WasmConverter`)と同じ。違いは2点:
//!
//! 1. **並列展開(M4-7)が無い。** `pcd-rs`の読み込みはLAZのようなエントロピー
//!    復号を伴わない(`binary_compressed`だけがLZF圧縮を使うが、
//!    `DynReader::from_reader`の時点で一括展開されるため、そもそも分割読みの
//!    余地が無い)。そのため`feed`は単純な逐次バッチループのみで、複数Workerへ
//!    分担させる仕組みは持たない
//! 2. **スケール・オフセットを「読み終えてから」選ぶ。** PCDの座標に元々
//!    scale/offsetは無いため(`crates/pcv-convert/src/import/scale.rs`と同じ
//!    設計、本ファイルの`choose_scale_offset`に複製)、`finish()`で
//!    `SpillReader::bounds()`を見てから選ぶ(M4-9の`crates/pcv-convert/src/
//!    import/convert.rs`と同じ「1パスで書ける」設計をそのまま踏襲した)
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

use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::Path;
use std::time::Duration;

use byteorder::{LittleEndian, ReadBytesExt};
use copc_core::{LasPointRecord, NeverCancel, StreamingLayout};
use copc_writer::{
    write_copc_from_spill_with_fs_and_timings, CopcWriteMetadata, CopcWriterParams, SpillWriter,
};
use js_sys::Array;
use pcd_rs::{DynReader, Field};
use wasm_bindgen::prelude::*;
use web_sys::{File, FileSystemSyncAccessHandle};
use web_time::Instant;

use crate::convert::handles_from_js_array;
use crate::file_reader::FileRangeReader;
use crate::opfs::OpfsScratchFs;
use crate::stats::Stats;

fn to_js_error<E: std::fmt::Display>(err: E) -> JsValue {
    JsValue::from_str(&err.to_string())
}

/// `FileRangeReader`を包む先読みバッファのサイズ。`convert.rs`の
/// `READ_BUFFER_BYTES`と同じ値・同じ理由(1回のJS往復をまとめて減らす)。
const READ_BUFFER_BYTES: usize = 4 * 1024 * 1024;

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
) -> Result<Option<u64>, JsValue> {
    const MAX_HEADER_LINES: usize = 64;

    let mut line = String::new();
    for _ in 0..MAX_HEADER_LINES {
        line.clear();
        let n = reader.read_line(&mut line).map_err(to_js_error)?;
        if n == 0 {
            return Ok(None);
        }
        let mut tokens = line.split_whitespace();
        if tokens.next() == Some("DATA") {
            let kind = tokens.next();
            if kind != Some("binary_compressed") {
                return Ok(None);
            }
            let _compressed_size = reader.read_u32::<LittleEndian>().map_err(to_js_error)?;
            let uncompressed_size = reader.read_u32::<LittleEndian>().map_err(to_js_error)?;
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
fn choose_scale_offset(
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

type PcdReader = DynReader<BufReader<FileRangeReader>>;

/// Web版のPCD→COPC変換。`src/datasource/copc.worker.ts`の
/// `handlePcdConvertStart`が使う。メソッド構成は`convert.rs`の
/// `WasmConverter`に揃えてある(`totalPoints`/`feed`/`finish`)。
#[wasm_bindgen]
pub struct WasmPcdConverter {
    reader: PcdReader,
    ix: usize,
    iy: usize,
    iz: usize,
    i_rgb: Option<usize>,
    i_intensity: Option<usize>,
    spill: Option<SpillWriter>,
    fs: OpfsScratchFs,
    total_points: u64,
    points_fed: u64,
    output_name: String,
    params: CopcWriterParams,
    /// M4-12(`TaskSheets/M4-import-and-conversion.md`):
    /// `crates/pcv-wasm/src/convert.rs`の`WasmConverter`と同じ理由・同じ
    /// 考え方(バッチ単位でしか`Instant::now()`を呼ばない。`feed`参照)。
    source_read_and_decode: Duration,
    spill_write: Duration,
    file_size_bytes: u64,
}

#[wasm_bindgen]
impl WasmPcdConverter {
    #[wasm_bindgen(constructor)]
    pub fn new(
        file: File,
        scratch_handles: Array,
        output_handle: FileSystemSyncAccessHandle,
        output_name: String,
        max_points_per_node: u32,
    ) -> Result<WasmPcdConverter, JsValue> {
        // M4-12: `file`は直後に`FileRangeReader::new`へ所有権が渡るため、
        // 先にサイズを読んでおく(`convert.rs`の`WasmConverter::new`と同じ)。
        let file_size_bytes = file.size() as u64;
        let stats = Stats::new();
        let source = FileRangeReader::new(file, stats);
        let mut buffered = BufReader::with_capacity(READ_BUFFER_BYTES, source);

        if let Some(uncompressed_bytes) = peek_binary_compressed_uncompressed_size(&mut buffered)? {
            if uncompressed_bytes > MAX_BINARY_COMPRESSED_UNCOMPRESSED_BYTES {
                return Err(to_js_error(format!(
                    "binary_compressedの展開後サイズ({uncompressed_bytes}バイト)が上限\
                     ({MAX_BINARY_COMPRESSED_UNCOMPRESSED_BYTES}バイト)を超える。この形式は\
                     展開にブロック全体をメモリに載せる必要があり、点数に比例してメモリを\
                     消費する。デスクトップ版で、より小さく分割するか、ASCII/binary(非圧縮)\
                     形式に変換してから開いてください"
                )));
            }
        }
        buffered.seek(SeekFrom::Start(0)).map_err(to_js_error)?;

        let reader = DynReader::from_reader(buffered).map_err(to_js_error)?;
        let meta = reader.meta().clone();
        let field_index = |name: &str| meta.field_defs.iter().position(|f| f.name == name);
        let ix = field_index("x").ok_or_else(|| to_js_error("PCDにx/y/zフィールドが無い"))?;
        let iy = field_index("y").ok_or_else(|| to_js_error("PCDにx/y/zフィールドが無い"))?;
        let iz = field_index("z").ok_or_else(|| to_js_error("PCDにx/y/zフィールドが無い"))?;
        let i_rgb = field_index("rgb");
        let i_intensity = field_index("intensity");
        let total_points = meta.num_points;

        let handles = handles_from_js_array(&scratch_handles)?;
        let fs = OpfsScratchFs::new(handles, output_handle);
        let layout = StreamingLayout {
            point_format: 0,
            has_gps: false,
            has_color: i_rgb.is_some(),
            has_nir: false,
            has_waveform: false,
            extra_bytes: 0,
            extra_bytes_descriptors: Vec::new(),
        };
        let spill = SpillWriter::create(&fs, layout).map_err(to_js_error)?;

        Ok(Self {
            reader,
            ix,
            iy,
            iz,
            i_rgb,
            i_intensity,
            spill: Some(spill),
            fs,
            total_points,
            points_fed: 0,
            output_name,
            params: CopcWriterParams::new(max_points_per_node),
            source_read_and_decode: Duration::ZERO,
            spill_write: Duration::ZERO,
            file_size_bytes,
        })
    }

    /// 入力の総点数(ヘッダーの申告値)。`convert.rs`の`WasmConverter::total_points`
    /// と同じ役割。
    #[wasm_bindgen(js_name = totalPoints)]
    pub fn total_points(&self) -> f64 {
        self.total_points as f64
    }

    /// 最大`batch_size`点を読み、spillへ書く。LAS/LAZ版と違い並列展開は無い
    /// (モジュールドキュメント参照)ので、呼び出し側は常にこの逐次バッチ
    /// ループで進める。
    #[wasm_bindgen(js_name = feed)]
    pub fn feed(&mut self, batch_size: u32) -> Result<JsValue, JsValue> {
        let spill = self
            .spill
            .as_mut()
            .ok_or_else(|| JsValue::from_str("feedはfinishの後には呼べない"))?;

        // M4-12: `convert.rs`の`WasmConverter::feed`と同じ理由で、「読み込み」
        // 「spill書き込み」の2段に分け、このバッチ(最大`batch_size`点、
        // 点数全体には比例しない一時バッファ)単位で区切って測る
        // (1点ごとに`Instant::now()`を呼ばない。モジュールドキュメント・
        // `source_read_and_decode`フィールドのコメント参照)。
        let read_start = Instant::now();
        let mut records = Vec::with_capacity(batch_size as usize);
        let mut done = false;
        while records.len() < batch_size as usize {
            match self.reader.next() {
                Some(Ok(record)) => {
                    let x = field_to_f64(&record.0[self.ix]);
                    let y = field_to_f64(&record.0[self.iy]);
                    let z = field_to_f64(&record.0[self.iz]);
                    let color = self
                        .i_rgb
                        .map(|i| decode_packed_rgb(&record.0[i]))
                        .unwrap_or([0, 0, 0]);
                    let intensity = self
                        .i_intensity
                        .map(|i| field_to_u16_clamped(&record.0[i]))
                        .unwrap_or(0);
                    records.push(LasPointRecord {
                        x,
                        y,
                        z,
                        intensity,
                        red: color[0],
                        green: color[1],
                        blue: color[2],
                        ..LasPointRecord::default()
                    });
                }
                Some(Err(e)) => return Err(to_js_error(e)),
                None => {
                    done = true;
                    break;
                }
            }
        }
        self.source_read_and_decode += read_start.elapsed();

        let push_start = Instant::now();
        for record in &records {
            spill.push(record).map_err(to_js_error)?;
            self.points_fed += 1;
        }
        self.spill_write += push_start.elapsed();

        let dto = crate::dto::FeedResultDto {
            points_read: self.points_fed,
            total_points: self.total_points,
            done,
        };
        serde_wasm_bindgen::to_value(&dto).map_err(to_js_error)
    }

    /// 読み込みを終え、octreeを構築してOPFSの出力ハンドルへ書き出す
    /// (`convert.rs`の`WasmConverter::finish`と同じ役割)。
    #[wasm_bindgen(js_name = finish)]
    pub fn finish(mut self) -> Result<JsValue, JsValue> {
        let spill = self
            .spill
            .take()
            .ok_or_else(|| JsValue::from_str("finishは既に呼ばれている"))?;
        let reader = spill.finalize().map_err(to_js_error)?;
        let bounds = reader.bounds();
        let (scale, offset) = choose_scale_offset(bounds.min, bounds.max);

        let mut metadata = CopcWriteMetadata::default();
        metadata.scale = Some(scale);
        metadata.offset = Some(offset);
        // PCDはCRSの概念を持たない(ADR-0008)。`wkt_crs`はデフォルトの`None`のまま
        // (推測で補わない。crates/pcv-convert/src/import/mod.rsのドキュメント参照)。

        let post_timings = write_copc_from_spill_with_fs_and_timings(
            &self.fs,
            Path::new(&self.output_name),
            reader,
            &self.params,
            &NeverCancel,
            &metadata,
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
            ),
        };
        serde_wasm_bindgen::to_value(&dto).map_err(to_js_error)
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
