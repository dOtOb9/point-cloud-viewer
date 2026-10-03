//! PLY(Polygon File Format、写真測量・研究用途で広く使われる) → ストリーミングの点ソース。
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
//! 全要素を同じ汎用ループで読み進め、`vertex`要素の行だけを`visit`へ渡す
//! 設計にした。
//!
//! # M4-9: ストリーミング化
//!
//! M4-4時点は`reader.read_to_end(&mut bytes)`でファイル全体を`Vec<u8>`へ
//! 読んでから解析していた(メモリがファイルサイズに比例する)。M4-9で、
//! ヘッダーだけを`BufRead::read_line`で行単位に読み(ヘッダーは高々数KB)、
//! データ本体は`BufRead`から直接(ASCIIは行単位、binaryはプロパティの値ごとに
//! 固定長バイト列)読み進めてその場で`visit`へ渡す形に書き換えた。保持する
//! メモリは「現在読んでいる1行・1点ぶんの値」だけで、点数には比例しない。

use std::io::{BufRead, Read};

use byteorder::{BigEndian, ByteOrder, LittleEndian};

use super::point::{PointSource, RawPoint};
use super::ImportError;

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
    /// `RawPoint`を組み立てる。
    fn extract(&self, values: &[Vec<f64>]) -> RawPoint {
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
        RawPoint {
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

/// ヘッダーを読んだ後の`BufRead`から、ストリーミングで点を取り出す。
pub(crate) struct PlySource<R: BufRead> {
    reader: R,
    format: PlyFormat,
    elements: Vec<ElementDef>,
    layout: VertexLayout,
    has_color: bool,
    vertex_count: u64,
}

impl<R: BufRead> PlySource<R> {
    /// パスだけでなく`BufRead`から開けるコア実装(他形式の`open`と同じ考え方。
    /// PLYは先頭から順に読むだけで済むので`Seek`は要らない)。
    pub(crate) fn open(mut reader: R) -> Result<Self, ImportError> {
        let header = read_header(&mut reader).map_err(ImportError::Ply)?;

        let vertex_element = header
            .elements
            .iter()
            .find(|e| e.name == "vertex")
            .ok_or(PlyError::MissingVertexElement)
            .map_err(ImportError::Ply)?;
        let layout = VertexLayout::resolve(vertex_element).map_err(ImportError::Ply)?;
        let has_color = layout.has_color();
        let vertex_count = vertex_element.count as u64;

        Ok(Self {
            reader,
            format: header.format,
            elements: header.elements,
            layout,
            has_color,
            vertex_count,
        })
    }
}

impl<R: BufRead> PointSource for PlySource<R> {
    fn has_color(&self) -> bool {
        self.has_color
    }

    fn declared_point_count(&self) -> u64 {
        self.vertex_count
    }

    fn for_each_point(
        mut self,
        visit: &mut dyn FnMut(RawPoint) -> Result<(), ImportError>,
    ) -> Result<(), ImportError> {
        match self.format {
            PlyFormat::Ascii => {
                stream_ascii_body(&mut self.reader, &self.elements, &self.layout, visit)
            }
            PlyFormat::BinaryLittleEndian => {
                stream_binary_body(&mut self.reader, &self.elements, &self.layout, false, visit)
            }
            PlyFormat::BinaryBigEndian => {
                stream_binary_body(&mut self.reader, &self.elements, &self.layout, true, visit)
            }
        }
    }
}

/// `end_header`行まで(含む)を行単位で読み、ヘッダーテキストとして解析する。
/// 呼び出し後、`reader`の読み取り位置はデータ本体の先頭にある。
fn read_header<R: BufRead>(reader: &mut R) -> Result<PlyHeader, PlyError> {
    let mut header_text = String::new();
    let mut line = String::new();
    loop {
        line.clear();
        let n = reader.read_line(&mut line)?;
        if n == 0 {
            return Err(PlyError::MissingEndHeader);
        }
        header_text.push_str(&line);
        if line.trim_end_matches(['\r', '\n']) == "end_header" {
            break;
        }
    }
    parse_header(&header_text)
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

/// 全要素を順番に読み、`vertex`要素の行だけ`visit`へ渡す。`vertex`以外
/// (`face`等)もリスト型プロパティを含めて正しく読み進めることで、
/// 後続のバイト位置(行)がずれないようにする(モジュール冒頭コメント参照)。
fn stream_ascii_body<R: BufRead>(
    reader: &mut R,
    elements: &[ElementDef],
    layout: &VertexLayout,
    visit: &mut dyn FnMut(RawPoint) -> Result<(), ImportError>,
) -> Result<(), ImportError> {
    let mut line = String::new();
    for element in elements {
        for _ in 0..element.count {
            line.clear();
            let n = reader.read_line(&mut line).map_err(PlyError::from)?;
            if n == 0 {
                return Err(ImportError::Ply(PlyError::UnexpectedEof));
            }
            let mut tokens = line.trim_end_matches(['\r', '\n']).split_whitespace();
            let mut values: Vec<Vec<f64>> = Vec::with_capacity(element.properties.len());

            for prop in &element.properties {
                match prop {
                    PropertyDef::Scalar { .. } => {
                        let tok = tokens
                            .next()
                            .ok_or(PlyError::UnexpectedEof)
                            .map_err(ImportError::Ply)?;
                        values.push(vec![parse_ascii_number(tok).map_err(ImportError::Ply)?]);
                    }
                    PropertyDef::List { .. } => {
                        let count_tok = tokens
                            .next()
                            .ok_or(PlyError::UnexpectedEof)
                            .map_err(ImportError::Ply)?;
                        let count = count_tok.parse::<usize>().map_err(|_| {
                            ImportError::Ply(PlyError::InvalidData(
                                "listの要素数が数値でない".to_string(),
                            ))
                        })?;
                        let mut list_values = Vec::with_capacity(count);
                        for _ in 0..count {
                            let tok = tokens
                                .next()
                                .ok_or(PlyError::UnexpectedEof)
                                .map_err(ImportError::Ply)?;
                            list_values.push(parse_ascii_number(tok).map_err(ImportError::Ply)?);
                        }
                        values.push(list_values);
                    }
                }
            }

            if element.name == "vertex" {
                visit(layout.extract(&values))?;
            }
        }
    }

    Ok(())
}

fn parse_ascii_number(token: &str) -> Result<f64, PlyError> {
    token
        .parse::<f64>()
        .map_err(|_| PlyError::InvalidData(format!("数値として読めない: {token}")))
}

fn stream_binary_body<R: Read>(
    reader: &mut R,
    elements: &[ElementDef],
    layout: &VertexLayout,
    big_endian: bool,
    visit: &mut dyn FnMut(RawPoint) -> Result<(), ImportError>,
) -> Result<(), ImportError> {
    for element in elements {
        for _ in 0..element.count {
            let mut values: Vec<Vec<f64>> = Vec::with_capacity(element.properties.len());

            for prop in &element.properties {
                match prop {
                    PropertyDef::Scalar { ty, .. } => {
                        values.push(vec![
                            read_scalar(reader, *ty, big_endian).map_err(ImportError::Ply)?
                        ]);
                    }
                    PropertyDef::List {
                        count_ty, elem_ty, ..
                    } => {
                        let count = read_scalar(reader, *count_ty, big_endian)
                            .map_err(ImportError::Ply)?
                            as usize;
                        let mut list_values = Vec::with_capacity(count);
                        for _ in 0..count {
                            list_values.push(
                                read_scalar(reader, *elem_ty, big_endian)
                                    .map_err(ImportError::Ply)?,
                            );
                        }
                        values.push(list_values);
                    }
                }
            }

            if element.name == "vertex" {
                visit(layout.extract(&values))?;
            }
        }
    }

    Ok(())
}

/// 1スカラ分(最大8バイト、`ScalarType::Float64`)を読む。`Read::read_exact`が
/// 途中でEOFになった場合は`UnexpectedEof`として扱う(標準の`io::ErrorKind`は
/// `UnexpectedEof`という専用の種別を持つため、それを見て区別する)。
fn read_scalar<R: Read>(reader: &mut R, ty: ScalarType, big_endian: bool) -> Result<f64, PlyError> {
    let size = ty.byte_size();
    let mut buf = [0u8; 8];
    reader.read_exact(&mut buf[..size]).map_err(|e| {
        if e.kind() == std::io::ErrorKind::UnexpectedEof {
            PlyError::UnexpectedEof
        } else {
            PlyError::Io(e)
        }
    })?;
    Ok(ty.decode(&buf[..size], big_endian))
}
