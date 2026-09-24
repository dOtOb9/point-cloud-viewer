//! PLY(Polygon File Format、写真測量・研究用途で広く使われる) → 共通の点群表現への変換。
//!
//! # クレート選定: 自前実装にした理由
//!
//! ADR-0008は候補として`ply-rs` 0.1.3を挙げ、「更新が古い。実装時に評価すること」と
//! 注記していた。実際に依存として追加して試したところ、**ビルド自体は通る**ものの、
//! `ply-rs`自身の`build-dependencies`に`skeptic`(READMEのコード例をdoctestとして
//! ビルド時に実行する crate)が入っており、それが`cargo_metadata`・
//! `pulldown-cmark`・`walkdir`・`semver`など多数の推移的依存を引き込むことが
//! `cargo build`のログと`Cargo.lock`で確認できた。`ply-rs`本体は2020年8月
//! (5年以上前)を最後に更新が止まっている。「点群を読むためだけに、ビルドの
//! たびにdoctest実行用のツールチェインまでコンパイルする」のは、依存を増やす
//! 理由として釣り合わないと判断し、**自前でPLYリーダーを書くことにした**。
//!
//! PLYのヘッダはテキストで自己記述的(要素・プロパティの型が全て書いてある)
//! であり、対応が必要なのは以下の3つのデータ形式だけ:
//! ASCII・binary_little_endian・binary_big_endian(いずれもPLY 1.0)。
//! 素朴な実装で数百行に収まり、退屈で読めるコードになる。
//!
//! # 属性の対応
//!
//! - `x`/`y`/`z`(`vertex`要素、必須): 型は問わず数値ならf64に変換する
//! - `red`/`green`/`blue`(3つ揃っている場合のみ色ありとして扱う): PLYには
//!   E57のcolorLimitsのような値域メタデータが無い。`uchar`(0-255、写真測量
//!   ツールの既定)なら`* 257`で16bit幅に、`ushort`(0-65535)ならそのまま使う。
//!   それ以外の型(float等)は規約が無いため素直に丸めてクランプするだけに留める
//! - `intensity`(任意、CloudCompare等が書き出す非標準拡張): `uchar`は`* 257`、
//!   `float`/`double`は0.0..1.0に正規化済みという前提で`* 65535`、
//!   それ以外は丸めてクランプする(PCDのintensityと同じ割り切り。理由は
//!   `pcd.rs`のコメント参照)
//!
//! # `vertex`以外の要素(`face`等)の扱い
//!
//! メッシュのPLYは`vertex`の後ろに`face`要素(`property list uchar int
//! vertex_indices`のような可変長リスト)を持つ。本ビューアは点群専用で
//! 面情報を使わないため中身は捨てるが、**バイト位置がずれないよう
//! 正しくスキップする必要がある**(特にbinaryでは、要素ごとの行の長さが
//! 分からないと後続を正しく読めない)。そのため、リスト型プロパティも含めて
//! 全要素を同じ汎用ループで読み進め、`vertex`要素の行だけを保持する設計にした。

use std::path::Path;

use byteorder::{BigEndian, ByteOrder, LittleEndian};

use super::point::{ImportedCloud, ImportedPoint};

#[derive(Debug, thiserror::Error)]
pub enum PlyError {
    #[error("入出力エラー: {0}")]
    Io(#[from] std::io::Error),
    #[error("ヘッダの形式が不正: {0}")]
    InvalidHeader(String),
    #[error("ヘッダに'end_header'が無い")]
    MissingEndHeader,
    #[error("'vertex'要素が無い")]
    MissingVertexElement,
    #[error("'vertex'要素に x/y/z プロパティが無い")]
    MissingXyz,
    #[error("データが不正: {0}")]
    InvalidData(String),
    #[error("データがファイル末尾より前に終わっている")]
    UnexpectedEof,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ScalarType {
    Int8,
    UInt8,
    Int16,
    UInt16,
    Int32,
    UInt32,
    Float32,
    Float64,
}

impl ScalarType {
    fn byte_size(self) -> usize {
        match self {
            ScalarType::Int8 | ScalarType::UInt8 => 1,
            ScalarType::Int16 | ScalarType::UInt16 => 2,
            ScalarType::Int32 | ScalarType::UInt32 | ScalarType::Float32 => 4,
            ScalarType::Float64 => 8,
        }
    }

    fn decode(self, bytes: &[u8], big_endian: bool) -> f64 {
        match self {
            ScalarType::Int8 => bytes[0] as i8 as f64,
            ScalarType::UInt8 => bytes[0] as f64,
            ScalarType::Int16 => {
                (if big_endian {
                    BigEndian::read_i16(bytes)
                } else {
                    LittleEndian::read_i16(bytes)
                }) as f64
            }
            ScalarType::UInt16 => {
                (if big_endian {
                    BigEndian::read_u16(bytes)
                } else {
                    LittleEndian::read_u16(bytes)
                }) as f64
            }
            ScalarType::Int32 => {
                (if big_endian {
                    BigEndian::read_i32(bytes)
                } else {
                    LittleEndian::read_i32(bytes)
                }) as f64
            }
            ScalarType::UInt32 => {
                (if big_endian {
                    BigEndian::read_u32(bytes)
                } else {
                    LittleEndian::read_u32(bytes)
                }) as f64
            }
            ScalarType::Float32 => {
                (if big_endian {
                    BigEndian::read_f32(bytes)
                } else {
                    LittleEndian::read_f32(bytes)
                }) as f64
            }
            ScalarType::Float64 => {
                if big_endian {
                    BigEndian::read_f64(bytes)
                } else {
                    LittleEndian::read_f64(bytes)
                }
            }
        }
    }

    fn parse(name: &str) -> Result<Self, PlyError> {
        Ok(match name {
            "char" | "int8" => ScalarType::Int8,
            "uchar" | "uint8" => ScalarType::UInt8,
            "short" | "int16" => ScalarType::Int16,
            "ushort" | "uint16" => ScalarType::UInt16,
            "int" | "int32" => ScalarType::Int32,
            "uint" | "uint32" => ScalarType::UInt32,
            "float" | "float32" => ScalarType::Float32,
            "double" | "float64" => ScalarType::Float64,
            other => return Err(PlyError::InvalidHeader(format!("未知の型: {other}"))),
        })
    }
}

#[derive(Debug, Clone)]
enum PropertyDef {
    Scalar {
        name: String,
        ty: ScalarType,
    },
    List {
        name: String,
        count_ty: ScalarType,
        elem_ty: ScalarType,
    },
}

impl PropertyDef {
    fn name(&self) -> &str {
        match self {
            PropertyDef::Scalar { name, .. } | PropertyDef::List { name, .. } => name,
        }
    }

    /// 値の型。リストの場合は要素の型(x/y/z/色/強度がリストになることは
    /// 実務上起こらないが、保険として定義しておく)。
    fn scalar_type(&self) -> ScalarType {
        match self {
            PropertyDef::Scalar { ty, .. } => *ty,
            PropertyDef::List { elem_ty, .. } => *elem_ty,
        }
    }
}

#[derive(Debug, Clone)]
struct ElementDef {
    name: String,
    count: usize,
    properties: Vec<PropertyDef>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PlyFormat {
    Ascii,
    BinaryLittleEndian,
    BinaryBigEndian,
}

struct PlyHeader {
    format: PlyFormat,
    elements: Vec<ElementDef>,
}

struct ColorLayout {
    r_idx: usize,
    g_idx: usize,
    b_idx: usize,
    ty: ScalarType,
}

struct IntensityLayout {
    idx: usize,
    ty: ScalarType,
}

struct VertexLayout {
    x_idx: usize,
    y_idx: usize,
    z_idx: usize,
    color: Option<ColorLayout>,
    intensity: Option<IntensityLayout>,
}

impl VertexLayout {
    fn resolve(vertex: &ElementDef) -> Result<Self, PlyError> {
        let find = |name: &str| vertex.properties.iter().position(|p| p.name() == name);
        let x_idx = find("x").ok_or(PlyError::MissingXyz)?;
        let y_idx = find("y").ok_or(PlyError::MissingXyz)?;
        let z_idx = find("z").ok_or(PlyError::MissingXyz)?;

        let color = match (find("red"), find("green"), find("blue")) {
            (Some(r_idx), Some(g_idx), Some(b_idx)) => Some(ColorLayout {
                r_idx,
                g_idx,
                b_idx,
                ty: vertex.properties[r_idx].scalar_type(),
            }),
            _ => None,
        };
        let intensity = find("intensity").map(|idx| IntensityLayout {
            idx,
            ty: vertex.properties[idx].scalar_type(),
        });

        Ok(Self {
            x_idx,
            y_idx,
            z_idx,
            color,
            intensity,
        })
    }

    fn has_color(&self) -> bool {
        self.color.is_some()
    }

    /// 1行分の生の値(プロパティごとにVec。scalarなら長さ1、listなら要素数分)から
    /// `ImportedPoint`を組み立てる。
    fn extract(&self, values: &[Vec<f64>]) -> ImportedPoint {
        let x = values[self.x_idx][0];
        let y = values[self.y_idx][0];
        let z = values[self.z_idx][0];
        let color = match &self.color {
            Some(c) => [
                scale_channel_to_u16(values[c.r_idx][0], c.ty),
                scale_channel_to_u16(values[c.g_idx][0], c.ty),
                scale_channel_to_u16(values[c.b_idx][0], c.ty),
            ],
            None => [0, 0, 0],
        };
        let intensity = match &self.intensity {
            Some(i) => scale_intensity_to_u16(values[i.idx][0], i.ty),
            None => 0,
        };
        ImportedPoint {
            x,
            y,
            z,
            color,
            intensity,
        }
    }
}

/// 8bit(0-255)を16bit幅(0-65535)へ過不足なく写す(`* 257`)。それ以外の型は
/// PLYに値域の規約が無いため、素直に丸めてクランプするだけに留める
/// (モジュール冒頭コメント参照)。
fn scale_channel_to_u16(value: f64, ty: ScalarType) -> u16 {
    match ty {
        ScalarType::UInt8 | ScalarType::Int8 => {
            (value.round().clamp(0.0, 255.0) as u16).wrapping_mul(257)
        }
        _ => value.round().clamp(0.0, 65535.0) as u16,
    }
}

fn scale_intensity_to_u16(value: f64, ty: ScalarType) -> u16 {
    match ty {
        ScalarType::UInt8 | ScalarType::Int8 => {
            (value.round().clamp(0.0, 255.0) as u16).wrapping_mul(257)
        }
        ScalarType::Float32 | ScalarType::Float64 => {
            (value.clamp(0.0, 1.0) * 65535.0).round() as u16
        }
        _ => value.round().clamp(0.0, 65535.0) as u16,
    }
}

pub(crate) fn read(path: &Path) -> Result<ImportedCloud, PlyError> {
    read_from(std::fs::File::open(path)?)
}

/// パスだけでなく`Read`から読めるコア実装(理由は`e57.rs`の`read_from`の
/// コメントと同じ。PLYは全体をメモリに読んでからバイト列として解析するため、
/// `Seek`は要らない)。
pub(crate) fn read_from<R: std::io::Read>(mut reader: R) -> Result<ImportedCloud, PlyError> {
    let mut bytes = Vec::new();
    reader.read_to_end(&mut bytes)?;
    let (header_text, data) = split_header_and_data(&bytes)?;
    let header = parse_header(&header_text)?;

    let vertex_element = header
        .elements
        .iter()
        .find(|e| e.name == "vertex")
        .ok_or(PlyError::MissingVertexElement)?;
    let layout = VertexLayout::resolve(vertex_element)?;
    let has_color = layout.has_color();

    let points = match header.format {
        PlyFormat::Ascii => read_ascii_body(data, &header, &layout)?,
        PlyFormat::BinaryLittleEndian => read_binary_body(data, &header, &layout, false)?,
        PlyFormat::BinaryBigEndian => read_binary_body(data, &header, &layout, true)?,
    };

    Ok(ImportedCloud { points, has_color })
}

/// `end_header`行の直後(改行込み)を境に、ヘッダ文字列とデータバイト列に分ける。
/// ヘッダはASCII(PLY仕様)なので、バイト列のまま部分一致を探索できる。
fn split_header_and_data(bytes: &[u8]) -> Result<(String, &[u8]), PlyError> {
    const MARKER: &[u8] = b"end_header";
    let pos = bytes
        .windows(MARKER.len())
        .position(|window| window == MARKER)
        .ok_or(PlyError::MissingEndHeader)?;
    let mut data_start = pos + MARKER.len();
    if bytes.get(data_start) == Some(&b'\r') {
        data_start += 1;
    }
    if bytes.get(data_start) == Some(&b'\n') {
        data_start += 1;
    }
    let header_text = std::str::from_utf8(&bytes[..data_start])
        .map_err(|_| PlyError::InvalidHeader("ヘッダがUTF8として不正".to_string()))?
        .to_string();
    Ok((header_text, &bytes[data_start..]))
}

fn parse_header(header_text: &str) -> Result<PlyHeader, PlyError> {
    let mut lines = header_text.lines();
    let magic = lines
        .next()
        .ok_or_else(|| PlyError::InvalidHeader("空のヘッダ".to_string()))?;
    if magic.trim() != "ply" {
        return Err(PlyError::InvalidHeader("先頭行が'ply'ではない".to_string()));
    }

    let mut format = None;
    let mut elements: Vec<ElementDef> = Vec::new();

    for line in lines {
        let line = line.trim();
        if line.is_empty() || line == "end_header" {
            continue;
        }
        if line.starts_with("comment") || line.starts_with("obj_info") {
            continue;
        }

        let mut tokens = line.split_whitespace();
        match tokens.next() {
            Some("format") => {
                let kind = tokens
                    .next()
                    .ok_or_else(|| PlyError::InvalidHeader("formatの種類が無い".to_string()))?;
                format = Some(match kind {
                    "ascii" => PlyFormat::Ascii,
                    "binary_little_endian" => PlyFormat::BinaryLittleEndian,
                    "binary_big_endian" => PlyFormat::BinaryBigEndian,
                    other => {
                        return Err(PlyError::InvalidHeader(format!("未対応のformat: {other}")))
                    }
                });
            }
            Some("element") => {
                let name = tokens
                    .next()
                    .ok_or_else(|| PlyError::InvalidHeader("element名が無い".to_string()))?
                    .to_string();
                let count = tokens
                    .next()
                    .ok_or_else(|| PlyError::InvalidHeader("elementの個数が無い".to_string()))?
                    .parse::<usize>()
                    .map_err(|_| {
                        PlyError::InvalidHeader("elementの個数が数値でない".to_string())
                    })?;
                elements.push(ElementDef {
                    name,
                    count,
                    properties: Vec::new(),
                });
            }
            Some("property") => {
                let element = elements.last_mut().ok_or_else(|| {
                    PlyError::InvalidHeader("propertyがelementより前にある".to_string())
                })?;
                let second = tokens
                    .next()
                    .ok_or_else(|| PlyError::InvalidHeader("propertyの型が無い".to_string()))?;
                if second == "list" {
                    let count_ty = ScalarType::parse(tokens.next().ok_or_else(|| {
                        PlyError::InvalidHeader("list propertyの要素数の型が無い".to_string())
                    })?)?;
                    let elem_ty = ScalarType::parse(tokens.next().ok_or_else(|| {
                        PlyError::InvalidHeader("list propertyの要素の型が無い".to_string())
                    })?)?;
                    let name = tokens
                        .next()
                        .ok_or_else(|| PlyError::InvalidHeader("property名が無い".to_string()))?
                        .to_string();
                    element.properties.push(PropertyDef::List {
                        name,
                        count_ty,
                        elem_ty,
                    });
                } else {
                    let ty = ScalarType::parse(second)?;
                    let name = tokens
                        .next()
                        .ok_or_else(|| PlyError::InvalidHeader("property名が無い".to_string()))?
                        .to_string();
                    element.properties.push(PropertyDef::Scalar { name, ty });
                }
            }
            _ => {
                // 未知の宣言行は無視する(PLY仕様上ここに来うる行を将来
                // 網羅する必要が出たら追加すればよい。読み込みを止めるほどではない)。
            }
        }
    }

    let format = format.ok_or_else(|| PlyError::InvalidHeader("formatの宣言が無い".to_string()))?;
    Ok(PlyHeader { format, elements })
}

/// 全要素を順番に読み、`vertex`要素の行だけ`ImportedPoint`として保持する。
/// `vertex`以外(`face`等)もリスト型プロパティを含めて正しく読み進めることで、
/// 後続のバイト位置がずれないようにする(モジュール冒頭コメント参照)。
fn read_ascii_body(
    data: &[u8],
    header: &PlyHeader,
    layout: &VertexLayout,
) -> Result<Vec<ImportedPoint>, PlyError> {
    let text = std::str::from_utf8(data)
        .map_err(|_| PlyError::InvalidData("ASCIIデータがUTF8として不正".to_string()))?;
    let mut lines = text.lines();
    let mut points = Vec::new();

    for element in &header.elements {
        for _ in 0..element.count {
            let line = lines.next().ok_or(PlyError::UnexpectedEof)?;
            let mut tokens = line.split_whitespace();
            let mut values: Vec<Vec<f64>> = Vec::with_capacity(element.properties.len());

            for prop in &element.properties {
                match prop {
                    PropertyDef::Scalar { .. } => {
                        let tok = tokens.next().ok_or(PlyError::UnexpectedEof)?;
                        values.push(vec![parse_ascii_number(tok)?]);
                    }
                    PropertyDef::List { .. } => {
                        let count_tok = tokens.next().ok_or(PlyError::UnexpectedEof)?;
                        let count = count_tok.parse::<usize>().map_err(|_| {
                            PlyError::InvalidData("listの要素数が数値でない".to_string())
                        })?;
                        let mut list_values = Vec::with_capacity(count);
                        for _ in 0..count {
                            let tok = tokens.next().ok_or(PlyError::UnexpectedEof)?;
                            list_values.push(parse_ascii_number(tok)?);
                        }
                        values.push(list_values);
                    }
                }
            }

            if element.name == "vertex" {
                points.push(layout.extract(&values));
            }
        }
    }

    Ok(points)
}

fn parse_ascii_number(token: &str) -> Result<f64, PlyError> {
    token
        .parse::<f64>()
        .map_err(|_| PlyError::InvalidData(format!("数値として読めない: {token}")))
}

fn read_binary_body(
    data: &[u8],
    header: &PlyHeader,
    layout: &VertexLayout,
    big_endian: bool,
) -> Result<Vec<ImportedPoint>, PlyError> {
    let mut cursor = 0usize;
    let mut points = Vec::new();

    for element in &header.elements {
        for _ in 0..element.count {
            let mut values: Vec<Vec<f64>> = Vec::with_capacity(element.properties.len());

            for prop in &element.properties {
                match prop {
                    PropertyDef::Scalar { ty, .. } => {
                        values.push(vec![read_scalar(data, &mut cursor, *ty, big_endian)?]);
                    }
                    PropertyDef::List {
                        count_ty, elem_ty, ..
                    } => {
                        let count = read_scalar(data, &mut cursor, *count_ty, big_endian)? as usize;
                        let mut list_values = Vec::with_capacity(count);
                        for _ in 0..count {
                            list_values.push(read_scalar(data, &mut cursor, *elem_ty, big_endian)?);
                        }
                        values.push(list_values);
                    }
                }
            }

            if element.name == "vertex" {
                points.push(layout.extract(&values));
            }
        }
    }

    Ok(points)
}

fn read_scalar(
    data: &[u8],
    cursor: &mut usize,
    ty: ScalarType,
    big_endian: bool,
) -> Result<f64, PlyError> {
    let size = ty.byte_size();
    let end = *cursor + size;
    let slice = data.get(*cursor..end).ok_or(PlyError::UnexpectedEof)?;
    *cursor = end;
    Ok(ty.decode(slice, big_endian))
}
