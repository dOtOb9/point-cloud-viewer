//! PCD(Point Cloud Data、PCLの標準形式) → ストリーミングの点ソース。
//!
//! # クレート選定
//!
//! `pcd-rs` 0.13.0を使う。選定理由・落とした候補は
//! `TaskSheets/ADR-0008-formats-and-crs.md`のM4-4追記を参照。
//! ここでは`derive`機能を使わず`DynReader`(実行時にスキーマを見る版)で読む。
//! フィールドの並び・型はPCDファイルごとに違うため、コンパイル時に固定した
//! 構造体で読むより、名前でフィールドを探す方がこの用途に合う。
//!
//! # M4-9: ストリーミング化と`binary_compressed`の例外
//!
//! `pcd_rs::DynReader`は`Iterator`を実装しており、ASCII(`read_line`)・
//! binary(`read_chunk`、固定長の次レコード分だけ)はどちらも**1レコード分だけ**
//! を読み進める設計であることを`pcd-rs` 0.13.0のソース(`src/reader.rs`)で
//! 確認した。M4-4時点の実装は、この既にストリーミングなイテレータの結果を
//! 自分で`Vec<ImportedPoint>`に貯め直していただけだったので、貯めるのをやめて
//! `visit`へその場で渡すだけでストリーミングになる。
//!
//! **例外: `binary_compressed`だけは点数に比例するメモリを使う。**
//! 同じソースを読むと、`DynReader::from_reader`は`DataKind::BinaryCompressed`を
//! 検出した**その場で**、LZF圧縮データ全体を展開した上(`col_major`、
//! 展開後サイズ丸ごと)に、行優先に転置した**もう1つの全体コピー**
//! (`row_major`、同じく展開後サイズ丸ごと)を作る(列優先⇔行優先の変換に
//! バッファ全体のランダムアクセスが要るため、1レコードずつの変換では済まない)。
//! つまり`binary_compressed`は、`DynReader::from_reader`を呼んだ時点で
//! 展開後サイズの**最大2倍**のメモリを使う。これは`pcd-rs`のアルゴリズムの
//! 性質であり、本クレート側のコードを直してもこの形式である限り避けられない
//! (フォーマットの仕様上、圧縮ブロックが1つなので部分展開ができない)。
//!
//! **対策: 展開前に、ヘッダー直後の`uncompressed_size`フィールド(PCD
//! `binary_compressed`データ節の先頭8バイトは`compressed_size`・
//! `uncompressed_size`という2つの`u32`と仕様で決まっている)だけを自前で
//! 覗き見て、[`MAX_BINARY_COMPRESSED_UNCOMPRESSED_BYTES`]を超えるなら
//! `pcd-rs`の重い展開を呼ぶ前にエラーで知らせる。** 覗き見た後は
//! `Seek::seek(SeekFrom::Start(0))`でファイル先頭へ戻し、`pcd-rs`自身に
//! ヘッダーから読み直させる(ヘッダー分だけ2回読むことになるが、せいぜい
//! 数百バイトなので無視できる)。

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

/// `binary_compressed`の展開後サイズの上限。
///
/// 根拠: `pcd-rs`の展開は`col_major`+`row_major`の2バッファ(展開後サイズの
/// 最大2倍)を同時に確保する(モジュール冒頭コメント参照)。本アプリの変換先は
/// デスクトップ・Android(`TaskSheets/M4-import-and-conversion.md`のM4-1b
/// 「変換を行う環境の範囲」参照、Androidは実機RAM 4GBを基準値としてADR-0006で
/// 記録済み)。512MiBを上限にすると、ピークはおよそ1〜1.5GiB
/// (2倍のバッファ+圧縮データ自体+その後のspill等)に収まり、4GB機でも
/// OS・アプリ本体の分を残して動く見込みがある、という判断。実測していない
/// 判断値であることを明記する(`disk_space.rs`の11倍係数のような実測比ではなく、
/// 「この形式は原理的に2倍かかる」という構造だけから見積もった値)。
const MAX_BINARY_COMPRESSED_UNCOMPRESSED_BYTES: u64 = 512 * 1024 * 1024;

/// `DynReader`から、ストリーミングで点を取り出す。
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
    /// パスだけでなく`BufRead + Seek`から開けるコア実装(他形式の`open`と
    /// 同じ考え方)。`Seek`は`binary_compressed`のサイズ確認(モジュール冒頭
    /// コメント参照)のためだけに要る。
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

/// ヘッダーを自前で(`pcd-rs`を介さず)行単位に読み進め、`DATA`行が
/// `binary_compressed`なら、続く8バイト(`compressed_size`・
/// `uncompressed_size`、ともにリトルエンディアンu32。PCD仕様で固定の配置)から
/// 展開後サイズだけを読んで返す。それ以外の`DATA`種別なら`Ok(None)`。
///
/// 呼び出し後の`reader`の読み取り位置は、ヘッダーの途中(またはサイズ確認の
/// 8バイト分だけ進んだ位置)で止まる。呼び出し側は必ず`seek`で先頭へ戻し、
/// `pcd-rs`自身にヘッダーから読み直させること(関数内で戻さないのは、
/// 「このまま読み進めればよい」という誤解を避けるため)。
///
/// ヘッダーが64行を超えても`DATA`行が見つからない場合は壊れた/未対応の
/// 入力とみなし、サイズ確認をあきらめて`Ok(None)`を返す(その後`pcd-rs`
/// 自身のヘッダー解析が、より分かりやすいエラーを出す)。
fn peek_binary_compressed_uncompressed_size<R: BufRead>(
    reader: &mut R,
) -> Result<Option<u64>, PcdError> {
    const MAX_HEADER_LINES: usize = 64;

    let mut line = String::new();
    for _ in 0..MAX_HEADER_LINES {
        line.clear();
        let n = reader.read_line(&mut line)?;
        if n == 0 {
            return Ok(None); // ファイルがヘッダーの途中で終わっている(壊れた入力)。
        }
        // `pcd-rs`自身(`src/utils.rs`の`load_meta`)もヘッダー行を空白区切りの
        // 先頭トークンで判定しており、"DATA"は大文字小文字を区別しない
        // 緩い一致ではない。`pcd-rs`が実際に読むのと同じ基準で判定することで、
        // ここでの判定とその後の本読み込みの認識が食い違わないようにする。
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

/// フィールドの値をf64として取り出す(count>1のフィールドでは先頭要素のみ、
/// x/y/z/intensityは常にcount==1の想定)。
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

/// 値域の規約が無い数値をLASのintensity(u16)へ、丸めてクランプするだけで写す。
fn field_to_u16_clamped(field: &Field) -> u16 {
    field_to_f64(field).round().clamp(0.0, u16::MAX as f64) as u16
}

/// PCL標準のパック済みrgb(f32またはu32、`0x00RRGGBB`)を復号し、
/// 8bit/chをLASの16bit幅へ写す(`v * 257`)。
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
        // rgbフィールドがそれ以外の型で書かれているPCDは仕様の想定外。
        // 変換全体は止めず、色無し(黒)として扱う。
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
