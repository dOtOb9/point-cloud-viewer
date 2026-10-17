//! PLY reader for the Web conversion (R7, `TaskSheets/R7-web-ply-e57.md`).
//!
//! This is a COPY of `crates/pcv-convert/src/import/ply.rs`, rewritten in one way: the original
//! pushes points into a `visit` callback, but the Web converter is driven batch by batch
//! (`feed`), so here the reader keeps its position and `next_point` returns one point per call.
//! The header parsing, the property handling and the colour / intensity scaling are the same.
//!
//! Why copied instead of shared: see the comment on the `pcd-rs` dependency in
//! `crates/pcv-wasm/Cargo.toml`. A fix in one file must be made in the other.
//!
//! Supported: `ascii`, `binary_little_endian`, `binary_big_endian`. Elements other than `vertex`
//! (for example `face` with list properties) are read and thrown away so that the byte / line
//! position stays correct.
//!
//! Memory: the header (a few KB) and one row. Nothing depends on the number of points.
//!
//! Colour: `uchar` is scaled by 257 to 16 bit, `ushort` is used as is, other types are
//! rounded and clamped. Intensity: `uchar` is scaled by 257, float / double are taken as
//! 0.0..1.0, other types are rounded and clamped (same rules as the desktop import).

use std::io::{BufRead, Read};

use byteorder::{BigEndian, ByteOrder, LittleEndian};

use crate::point_file_import::RawPoint;

type Result<T> = std::result::Result<T, String>;

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

    /// `bytes` is exactly `byte_size()` long (the caller reads that many bytes).
    fn decode(self, bytes: &[u8], big_endian: bool) -> f64 {
        match self {
            ScalarType::Int8 => f64::from(bytes[0] as i8),
            ScalarType::UInt8 => f64::from(bytes[0]),
            ScalarType::Int16 => f64::from(if big_endian {
                BigEndian::read_i16(bytes)
            } else {
                LittleEndian::read_i16(bytes)
            }),
            ScalarType::UInt16 => f64::from(if big_endian {
                BigEndian::read_u16(bytes)
            } else {
                LittleEndian::read_u16(bytes)
            }),
            ScalarType::Int32 => f64::from(if big_endian {
                BigEndian::read_i32(bytes)
            } else {
                LittleEndian::read_i32(bytes)
            }),
            ScalarType::UInt32 => f64::from(if big_endian {
                BigEndian::read_u32(bytes)
            } else {
                LittleEndian::read_u32(bytes)
            }),
            ScalarType::Float32 => f64::from(if big_endian {
                BigEndian::read_f32(bytes)
            } else {
                LittleEndian::read_f32(bytes)
            }),
            ScalarType::Float64 => {
                if big_endian {
                    BigEndian::read_f64(bytes)
                } else {
                    LittleEndian::read_f64(bytes)
                }
            }
        }
    }

    fn parse(name: &str) -> Result<Self> {
        Ok(match name {
            "char" | "int8" => ScalarType::Int8,
            "uchar" | "uint8" => ScalarType::UInt8,
            "short" | "int16" => ScalarType::Int16,
            "ushort" | "uint16" => ScalarType::UInt16,
            "int" | "int32" => ScalarType::Int32,
            "uint" | "uint32" => ScalarType::UInt32,
            "float" | "float32" => ScalarType::Float32,
            "double" | "float64" => ScalarType::Float64,
            other => return Err(format!("PLYヘッダの形式が不正: 未知の型: {other}")),
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

    /// The value type. For a list it is the element type (x/y/z/colour/intensity are never
    /// lists in practice, this is only a safe fallback).
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

/// First value of property `idx` in a row (0.0 if the row is shorter than the header says).
fn first_value(values: &[Vec<f64>], idx: usize) -> f64 {
    values
        .get(idx)
        .and_then(|v| v.first())
        .copied()
        .unwrap_or(0.0)
}

impl VertexLayout {
    fn resolve(vertex: &ElementDef) -> Result<Self> {
        let find = |name: &str| vertex.properties.iter().position(|p| p.name() == name);
        let missing = || "'vertex'要素に x/y/z プロパティが無い".to_string();
        let x_idx = find("x").ok_or_else(missing)?;
        let y_idx = find("y").ok_or_else(missing)?;
        let z_idx = find("z").ok_or_else(missing)?;

        // Colour only counts when all of red / green / blue are there.
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

    /// Build a point from one row (one `Vec` per property: length 1 for a scalar, the number
    /// of elements for a list).
    fn extract(&self, values: &[Vec<f64>]) -> RawPoint {
        let color = match &self.color {
            Some(c) => [
                scale_channel_to_u16(first_value(values, c.r_idx), c.ty),
                scale_channel_to_u16(first_value(values, c.g_idx), c.ty),
                scale_channel_to_u16(first_value(values, c.b_idx), c.ty),
            ],
            None => [0, 0, 0],
        };
        let intensity = match &self.intensity {
            Some(i) => scale_intensity_to_u16(first_value(values, i.idx), i.ty),
            None => 0,
        };
        RawPoint {
            x: first_value(values, self.x_idx),
            y: first_value(values, self.y_idx),
            z: first_value(values, self.z_idx),
            color,
            intensity,
        }
    }
}

/// 8 bit (0-255) to 16 bit (0-65535) with `* 257`. Other types have no range convention in
/// PLY, so they are only rounded and clamped.
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

/// A PLY file opened after its header. `next_point` walks the body row by row.
pub(crate) struct PlyStream<R: BufRead> {
    reader: R,
    format: PlyFormat,
    elements: Vec<ElementDef>,
    layout: VertexLayout,
    vertex_count: u64,
    /// Where we are: element index and the next row inside that element.
    element_idx: usize,
    row_in_element: usize,
    /// Reused line buffer for the ascii format.
    line: String,
}

impl<R: BufRead> PlyStream<R> {
    pub(crate) fn open(mut reader: R) -> Result<Self> {
        let header = read_header(&mut reader)?;
        let vertex = header
            .elements
            .iter()
            .find(|e| e.name == "vertex")
            .ok_or_else(|| "PLYに'vertex'要素が無い".to_string())?;
        let layout = VertexLayout::resolve(vertex)?;
        let vertex_count = vertex.count as u64;
        Ok(Self {
            reader,
            format: header.format,
            elements: header.elements,
            layout,
            vertex_count,
            element_idx: 0,
            row_in_element: 0,
            line: String::new(),
        })
    }

    pub(crate) fn has_color(&self) -> bool {
        self.layout.color.is_some()
    }

    pub(crate) fn declared_point_count(&self) -> u64 {
        self.vertex_count
    }

    /// The next `vertex` row as a point, or `None` at the end. Rows of other elements are
    /// read and dropped.
    pub(crate) fn next_point(&mut self) -> Result<Option<RawPoint>> {
        loop {
            let Some(element) = self.elements.get(self.element_idx) else {
                return Ok(None);
            };
            if self.row_in_element >= element.count {
                self.element_idx += 1;
                self.row_in_element = 0;
                continue;
            }
            self.row_in_element += 1;

            let values = match self.format {
                PlyFormat::Ascii => read_ascii_row(&mut self.reader, &mut self.line, element)?,
                PlyFormat::BinaryLittleEndian => read_binary_row(&mut self.reader, element, false)?,
                PlyFormat::BinaryBigEndian => read_binary_row(&mut self.reader, element, true)?,
            };
            if element.name == "vertex" {
                return Ok(Some(self.layout.extract(&values)));
            }
        }
    }
}

/// Read lines up to and including `end_header` and parse them. Afterwards the reader is at
/// the start of the body.
fn read_header<R: BufRead>(reader: &mut R) -> Result<PlyHeader> {
    let mut header_text = String::new();
    let mut line = String::new();
    loop {
        line.clear();
        let n = reader
            .read_line(&mut line)
            .map_err(|e| format!("入出力エラー: {e}"))?;
        if n == 0 {
            return Err("PLYのヘッダに'end_header'が無い".to_string());
        }
        header_text.push_str(&line);
        if line.trim_end_matches(['\r', '\n']) == "end_header" {
            break;
        }
    }
    parse_header(&header_text)
}

fn invalid_header(what: &str) -> String {
    format!("PLYヘッダの形式が不正: {what}")
}

fn parse_header(header_text: &str) -> Result<PlyHeader> {
    let mut lines = header_text.lines();
    let magic = lines.next().ok_or_else(|| invalid_header("空のヘッダ"))?;
    if magic.trim() != "ply" {
        return Err(invalid_header("先頭行が'ply'ではない"));
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
                    .ok_or_else(|| invalid_header("formatの種類が無い"))?;
                format = Some(match kind {
                    "ascii" => PlyFormat::Ascii,
                    "binary_little_endian" => PlyFormat::BinaryLittleEndian,
                    "binary_big_endian" => PlyFormat::BinaryBigEndian,
                    other => return Err(invalid_header(&format!("未対応のformat: {other}"))),
                });
            }
            Some("element") => {
                let name = tokens
                    .next()
                    .ok_or_else(|| invalid_header("element名が無い"))?
                    .to_string();
                let count = tokens
                    .next()
                    .ok_or_else(|| invalid_header("elementの個数が無い"))?
                    .parse::<usize>()
                    .map_err(|_| invalid_header("elementの個数が数値でない"))?;
                elements.push(ElementDef {
                    name,
                    count,
                    properties: Vec::new(),
                });
            }
            Some("property") => {
                let element = elements
                    .last_mut()
                    .ok_or_else(|| invalid_header("propertyがelementより前にある"))?;
                let second = tokens
                    .next()
                    .ok_or_else(|| invalid_header("propertyの型が無い"))?;
                if second == "list" {
                    let count_ty = ScalarType::parse(
                        tokens
                            .next()
                            .ok_or_else(|| invalid_header("list propertyの要素数の型が無い"))?,
                    )?;
                    let elem_ty = ScalarType::parse(
                        tokens
                            .next()
                            .ok_or_else(|| invalid_header("list propertyの要素の型が無い"))?,
                    )?;
                    let name = tokens
                        .next()
                        .ok_or_else(|| invalid_header("property名が無い"))?
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
                        .ok_or_else(|| invalid_header("property名が無い"))?
                        .to_string();
                    element.properties.push(PropertyDef::Scalar { name, ty });
                }
            }
            // Unknown declaration lines are ignored; not worth stopping the import.
            _ => {}
        }
    }

    let format = format.ok_or_else(|| invalid_header("formatの宣言が無い"))?;
    Ok(PlyHeader { format, elements })
}

fn unexpected_eof() -> String {
    "PLYのデータがファイル末尾より前に終わっている".to_string()
}

fn parse_ascii_number(token: &str) -> Result<f64> {
    token
        .parse::<f64>()
        .map_err(|_| format!("PLYのデータが不正: 数値として読めない: {token}"))
}

/// Read one line and split it into the values of `element`'s properties.
fn read_ascii_row<R: BufRead>(
    reader: &mut R,
    line: &mut String,
    element: &ElementDef,
) -> Result<Vec<Vec<f64>>> {
    line.clear();
    let n = reader
        .read_line(line)
        .map_err(|e| format!("入出力エラー: {e}"))?;
    if n == 0 {
        return Err(unexpected_eof());
    }
    let mut tokens = line.trim_end_matches(['\r', '\n']).split_whitespace();
    let mut values: Vec<Vec<f64>> = Vec::with_capacity(element.properties.len());

    for prop in &element.properties {
        match prop {
            PropertyDef::Scalar { .. } => {
                let tok = tokens.next().ok_or_else(unexpected_eof)?;
                values.push(vec![parse_ascii_number(tok)?]);
            }
            PropertyDef::List { .. } => {
                let count_tok = tokens.next().ok_or_else(unexpected_eof)?;
                let count = count_tok
                    .parse::<usize>()
                    .map_err(|_| "PLYのデータが不正: listの要素数が数値でない".to_string())?;
                // No `with_capacity(count)`: the count comes from the file.
                let mut list_values = Vec::new();
                for _ in 0..count {
                    let tok = tokens.next().ok_or_else(unexpected_eof)?;
                    list_values.push(parse_ascii_number(tok)?);
                }
                values.push(list_values);
            }
        }
    }
    Ok(values)
}

/// Read the binary values of one row of `element`.
fn read_binary_row<R: Read>(
    reader: &mut R,
    element: &ElementDef,
    big_endian: bool,
) -> Result<Vec<Vec<f64>>> {
    let mut values: Vec<Vec<f64>> = Vec::with_capacity(element.properties.len());
    for prop in &element.properties {
        match prop {
            PropertyDef::Scalar { ty, .. } => {
                values.push(vec![read_scalar(reader, *ty, big_endian)?]);
            }
            PropertyDef::List {
                count_ty, elem_ty, ..
            } => {
                let count = read_scalar(reader, *count_ty, big_endian)? as usize;
                // No `with_capacity(count)`: the count comes from the file.
                let mut list_values = Vec::new();
                for _ in 0..count {
                    list_values.push(read_scalar(reader, *elem_ty, big_endian)?);
                }
                values.push(list_values);
            }
        }
    }
    Ok(values)
}

/// Read one scalar (at most 8 bytes).
fn read_scalar<R: Read>(reader: &mut R, ty: ScalarType, big_endian: bool) -> Result<f64> {
    let size = ty.byte_size();
    let mut buf = [0u8; 8];
    reader.read_exact(&mut buf[..size]).map_err(|e| {
        if e.kind() == std::io::ErrorKind::UnexpectedEof {
            unexpected_eof()
        } else {
            format!("入出力エラー: {e}")
        }
    })?;
    Ok(ty.decode(&buf[..size], big_endian))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    type SamplePoint = (f32, f32, f32, u8, u8, u8, f32);

    fn sample_points() -> Vec<SamplePoint> {
        vec![
            (0.0, 0.0, 0.0, 0, 0, 0, 0.0),
            (1.5, -2.25, 3.75, 255, 128, 0, 0.5),
            (-10.0, 20.0, -30.0, 10, 200, 40, 1.0),
            (100.0, 200.0, 300.0, 255, 255, 255, 0.25),
        ]
    }

    fn ply_header(format_line: &str, vertex_count: usize, include_faces: bool) -> String {
        let mut header = String::from("ply\n");
        header.push_str(format_line);
        header.push_str(&format!("element vertex {vertex_count}\n"));
        header.push_str("property float x\nproperty float y\nproperty float z\n");
        header.push_str("property uchar red\nproperty uchar green\nproperty uchar blue\n");
        header.push_str("property float intensity\n");
        if include_faces {
            header.push_str("element face 1\nproperty list uchar int vertex_indices\n");
        }
        header.push_str("end_header\n");
        header
    }

    fn build_ascii(points: &[SamplePoint], include_faces: bool) -> Vec<u8> {
        let mut text = ply_header("format ascii 1.0\n", points.len(), include_faces);
        for &(x, y, z, r, g, b, i) in points {
            text.push_str(&format!("{x} {y} {z} {r} {g} {b} {i}\n"));
        }
        if include_faces {
            let indices: Vec<String> = (0..points.len()).map(|i| i.to_string()).collect();
            text.push_str(&format!("{} {}\n", points.len(), indices.join(" ")));
        }
        text.into_bytes()
    }

    fn build_binary(points: &[SamplePoint], little_endian: bool, include_faces: bool) -> Vec<u8> {
        let format_line = if little_endian {
            "format binary_little_endian 1.0\n"
        } else {
            "format binary_big_endian 1.0\n"
        };
        let mut out = ply_header(format_line, points.len(), include_faces).into_bytes();
        let f32_bytes = |v: f32| {
            if little_endian {
                v.to_le_bytes()
            } else {
                v.to_be_bytes()
            }
        };
        for &(x, y, z, r, g, b, i) in points {
            out.extend_from_slice(&f32_bytes(x));
            out.extend_from_slice(&f32_bytes(y));
            out.extend_from_slice(&f32_bytes(z));
            out.extend_from_slice(&[r, g, b]);
            out.extend_from_slice(&f32_bytes(i));
        }
        if include_faces {
            out.push(points.len() as u8);
            for i in 0..points.len() {
                let v = i as i32;
                out.extend_from_slice(&if little_endian {
                    v.to_le_bytes()
                } else {
                    v.to_be_bytes()
                });
            }
        }
        out
    }

    fn read_all(bytes: Vec<u8>) -> (bool, u64, Vec<RawPoint>) {
        let mut stream = PlyStream::open(Cursor::new(bytes)).expect("open");
        let mut points = Vec::new();
        while let Some(p) = stream.next_point().expect("next_point") {
            points.push(p);
        }
        (stream.has_color(), stream.declared_point_count(), points)
    }

    fn assert_matches_sample(has_color: bool, declared: u64, points: &[RawPoint]) {
        let sample = sample_points();
        assert!(has_color);
        assert_eq!(declared, sample.len() as u64);
        assert_eq!(points.len(), sample.len());
        for (p, &(x, y, z, r, g, b, i)) in points.iter().zip(&sample) {
            assert_eq!((p.x, p.y, p.z), (f64::from(x), f64::from(y), f64::from(z)));
            assert_eq!(
                p.color,
                [u16::from(r) * 257, u16::from(g) * 257, u16::from(b) * 257]
            );
            assert_eq!(p.intensity, (f64::from(i) * 65535.0).round() as u16);
        }
    }

    #[test]
    fn ascii_round_trips_xyz_color_and_intensity() {
        let (c, n, pts) = read_all(build_ascii(&sample_points(), false));
        assert_matches_sample(c, n, &pts);
    }

    #[test]
    fn binary_little_endian_round_trips() {
        let (c, n, pts) = read_all(build_binary(&sample_points(), true, false));
        assert_matches_sample(c, n, &pts);
    }

    #[test]
    fn binary_big_endian_round_trips() {
        let (c, n, pts) = read_all(build_binary(&sample_points(), false, false));
        assert_matches_sample(c, n, &pts);
    }

    #[test]
    fn face_element_after_vertex_is_skipped_in_both_encodings() {
        let (c, n, pts) = read_all(build_ascii(&sample_points(), true));
        assert_matches_sample(c, n, &pts);
        let (c, n, pts) = read_all(build_binary(&sample_points(), true, true));
        assert_matches_sample(c, n, &pts);
    }

    #[test]
    fn missing_xyz_and_truncated_body_are_errors_not_panics() {
        let no_z = "ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nproperty float y\nend_header\n1 2\n";
        assert!(PlyStream::open(Cursor::new(no_z.as_bytes().to_vec())).is_err());

        let mut bytes = build_binary(&sample_points(), true, false);
        bytes.truncate(bytes.len() - 5);
        let mut stream = PlyStream::open(Cursor::new(bytes)).expect("open");
        let mut result = Ok(Some(RawPoint::default()));
        while matches!(result, Ok(Some(_))) {
            result = stream.next_point();
        }
        assert!(result.is_err(), "a truncated body must be an error");
    }

    /// Memory does not depend on the number of points: the stream holds the header plus one
    /// row, and `next_point` hands out one point at a time. Here 50_000 points are read from
    /// a reader that produces them on the fly (the whole file never exists in memory)
    /// through a 64 byte `BufReader`.
    #[test]
    fn streaming_does_not_buffer_the_body() {
        struct Generated {
            head: Cursor<Vec<u8>>,
            remaining_rows: usize,
            row: [u8; 16],
            row_pos: usize,
        }
        impl Read for Generated {
            fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
                let n = self.head.read(out)?;
                if n > 0 {
                    return Ok(n);
                }
                if self.row_pos == self.row.len() {
                    if self.remaining_rows == 0 {
                        return Ok(0);
                    }
                    self.remaining_rows -= 1;
                    self.row_pos = 0;
                }
                let n = out.len().min(self.row.len() - self.row_pos);
                out[..n].copy_from_slice(&self.row[self.row_pos..self.row_pos + n]);
                self.row_pos += n;
                Ok(n)
            }
        }

        let count = 50_000usize;
        let header = "ply\nformat binary_little_endian 1.0\nelement vertex 50000\n\
                      property float x\nproperty float y\nproperty float z\n\
                      property float intensity\nend_header\n";
        let mut row = [0u8; 16];
        row[..4].copy_from_slice(&1.0f32.to_le_bytes());
        let source = Generated {
            head: Cursor::new(header.as_bytes().to_vec()),
            remaining_rows: count,
            row,
            row_pos: row.len(),
        };
        // A small BufReader capacity: if the stream tried to hold the file, it could not.
        let mut stream =
            PlyStream::open(std::io::BufReader::with_capacity(64, source)).expect("open");
        let mut n = 0usize;
        while let Some(p) = stream.next_point().expect("next_point") {
            assert_eq!(p.x, 1.0);
            n += 1;
        }
        assert_eq!(n, count);
    }
}
