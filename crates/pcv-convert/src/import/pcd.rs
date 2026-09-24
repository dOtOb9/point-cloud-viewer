//! PCD(Point Cloud Data、PCLの標準形式) → 共通の点群表現への変換。
//!
//! # クレート選定
//!
//! `pcd-rs` 0.13.0を使う。選定理由・落とした候補は
//! `TaskSheets/ADR-0008-formats-and-crs.md`のM4-4追記を参照。
//! ここでは`derive`機能を使わず`DynReader`(実行時にスキーマを見る版)で読む。
//! フィールドの並び・型はPCDファイルごとに違うため、コンパイル時に固定した
//! 構造体で読むより、名前でフィールドを探す方がこの用途に合う。
//!
//! ASCII・binary・binary_compressed(LZF圧縮)のすべてが`pcd-rs`側で
//! 自動判定・処理される(`DynReader::open`が`DATA`行を見て切り替える)ため、
//! ここでは形式による分岐を書く必要がない。**binary_compressedの対応方針**:
//! 自前でLZF展開を書く選択肢もあったが、`pcd-rs`が2026年3月時点でも
//! メンテナンスされており(ADR-0008参照)、対応も揃っているため、自前実装は
//! しない。受け入れテスト(`tests/import_pcd.rs`)で`pcd-rs`自身の
//! `DynWriter`(`DataKind::BinaryCompressed`)で作った圧縮ファイルを
//! このモジュールで読み返し、往復できることを確認している。
//!
//! # 属性の対応
//!
//! - `x`/`y`/`z`: 必須。型は問わない(f32/f64はもちろん、整数型で座標を
//!   持つ変則的なPCDにも対応できるよう、数値型なら何でもf64へ変換する)
//! - `rgb`: PCL標準の「1個のf32/u32に0x00RRGGBBを詰めた」パック形式
//!   (`pcd_rs::float_to_rgb`。u32のPCDも見かけるため両対応)。
//!   PCDには色の値域を示すメタデータが無い(E57のcolorLimitsのような
//!   ものが無い)ため、パック済みの8bit/chという前提を置く
//!   (PCLの実質的な標準)。8bit値をLASの16bit幅へ写すのは
//!   `v * 257`(0..255 → 0..65535に過不足なく写る)
//! - `intensity`: PCDにも値域のメタデータが無く、単位もセンサ依存で
//!   規約が無い。**正規化はせず、値をそのままLASのintensity(0-65535の
//!   整数)へ丸めてクランプする**。この割り切りをADR-0008に記録した

use std::path::Path;

use pcd_rs::{DynReader, Field};

use super::point::{ImportedCloud, ImportedPoint};

#[derive(Debug, thiserror::Error)]
pub enum PcdError {
    #[error("入出力エラー: {0}")]
    Io(#[from] std::io::Error),
    #[error("PCDの読み込みに失敗した: {0}")]
    PcdRs(#[from] pcd_rs::Error),
    #[error("PCDに x/y/z フィールドが無い")]
    MissingXyz,
}

pub(crate) fn read(path: &Path) -> Result<ImportedCloud, PcdError> {
    read_from(std::fs::File::open(path)?)
}

/// パスだけでなく`Read`から読めるコア実装(理由は`e57.rs`の`read_from`の
/// コメントと同じ)。`pcd-rs`の`DynReader::from_reader`が`BufRead`を要求する
/// ため、ここで`BufReader`に包む。
pub(crate) fn read_from<R: std::io::Read>(reader: R) -> Result<ImportedCloud, PcdError> {
    let reader = DynReader::from_reader(std::io::BufReader::new(reader))?;
    let meta = reader.meta().clone();

    let field_index = |name: &str| meta.field_defs.iter().position(|f| f.name == name);
    let ix = field_index("x").ok_or(PcdError::MissingXyz)?;
    let iy = field_index("y").ok_or(PcdError::MissingXyz)?;
    let iz = field_index("z").ok_or(PcdError::MissingXyz)?;
    let i_rgb = field_index("rgb");
    let i_intensity = field_index("intensity");
    let has_color = i_rgb.is_some();

    let mut points = Vec::with_capacity(meta.num_points as usize);
    for record in reader {
        let record = record?;
        let x = field_to_f64(&record.0[ix]);
        let y = field_to_f64(&record.0[iy]);
        let z = field_to_f64(&record.0[iz]);
        let color = i_rgb
            .map(|i| decode_packed_rgb(&record.0[i]))
            .unwrap_or([0, 0, 0]);
        let intensity = i_intensity
            .map(|i| field_to_u16_clamped(&record.0[i]))
            .unwrap_or(0);
        points.push(ImportedPoint {
            x,
            y,
            z,
            color,
            intensity,
        });
    }

    Ok(ImportedCloud { points, has_color })
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
