use std::io::{Read, Seek, SeekFrom};

use super::{epsg_from_wkt, Crs, JgdEpoch};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CrsKind {
    PlaneRectangular,
    Utm,
    Other,
    None,
}

impl CrsKind {
    pub fn as_str(self) -> &'static str {
        match self {
            CrsKind::PlaneRectangular => "plane-rectangular",
            CrsKind::Utm => "utm",
            CrsKind::Other => "other",
            CrsKind::None => "none",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct CrsInfo {
    pub epsg: Option<u32>,
    pub name: String,
    pub kind: CrsKind,
    pub error: Option<String>,
    pub horizontal_unit_to_meter: Option<f64>,
    pub vertical_unit_to_meter: Option<f64>,
}

impl CrsInfo {
    pub fn none() -> Self {
        Self {
            epsg: None,
            name: String::new(),
            kind: CrsKind::None,
            error: None,
            horizontal_unit_to_meter: None,
            vertical_unit_to_meter: None,
        }
    }

    pub fn failed(message: String) -> Self {
        Self {
            epsg: None,
            name: String::new(),
            kind: CrsKind::Other,
            error: Some(message),
            horizontal_unit_to_meter: None,
            vertical_unit_to_meter: None,
        }
    }
}

fn roman(mut n: u8) -> String {
    const TABLE: [(u8, &str); 4] = [(10, "X"), (9, "IX"), (5, "V"), (4, "IV")];
    let mut s = String::new();
    for (value, text) in TABLE {
        while n >= value {
            s.push_str(text);
            n -= value;
        }
    }
    for _ in 0..n {
        s.push('I');
    }
    s
}

fn recognized_name(crs: Crs) -> Option<(CrsKind, String)> {
    match crs {
        Crs::PlaneRectangular(p) => {
            let datum = match p.epoch {
                JgdEpoch::Jgd2000 => "JGD2000",
                JgdEpoch::Jgd2011 => "JGD2011",
            };
            Some((
                CrsKind::PlaneRectangular,
                format!("{datum} / 平面直角座標系 第{}系", roman(p.zone.number)),
            ))
        }
        Crs::Utm(u) => Some((
            CrsKind::Utm,
            format!("WGS 84 / UTM zone {}N", u.zone.number),
        )),
        Crs::Unknown => None,
    }
}

fn wkt_name(bytes: &[u8]) -> Option<String> {
    let wkt = String::from_utf8_lossy(bytes);
    let start = ["PROJCS[\"", "PROJCRS[\"", "COMPD_CS[\"", "GEOGCS[\""]
        .iter()
        .find_map(|key| wkt.find(key).map(|i| i + key.len()))?;
    let rest = &wkt[start..];
    let end = rest.find('"')?;
    let name = rest[..end].trim();
    (!name.is_empty()).then(|| name.to_string())
}

fn direct_unit_factor(wkt: &str, keyword: &str) -> Option<f64> {
    let start = wkt.find(keyword)? + keyword.len();
    let bytes = wkt.as_bytes();
    let mut depth = 1usize;
    let mut in_quote = false;
    let mut i = start;
    while i < bytes.len() {
        let c = bytes[i];
        if c == b'"' {
            in_quote = !in_quote;
        } else if !in_quote {
            match c {
                b'[' => depth += 1,
                b']' => {
                    depth -= 1;
                    if depth == 0 {
                        return None;
                    }
                }
                b'U' if depth == 1
                    && i > 0
                    && bytes[i - 1] == b','
                    && wkt[i..].starts_with("UNIT[") =>
                {
                    return parse_unit_factor(&wkt[i + "UNIT[".len()..]);
                }
                _ => {}
            }
        }
        i += 1;
    }
    None
}

fn parse_unit_factor(rest: &str) -> Option<f64> {
    let rest = rest.strip_prefix('"')?;
    let end = rest.find('"')?;
    let after = rest[end + 1..].trim_start_matches(',').trim_start();
    let number: String = after
        .chars()
        .take_while(|c| c.is_ascii_digit() || matches!(c, '.' | 'e' | 'E' | '+' | '-'))
        .collect();
    let factor: f64 = number.parse().ok()?;
    (factor.is_finite() && factor > 0.0).then_some(factor)
}

fn wkt_units(bytes: &[u8]) -> (Option<f64>, Option<f64>) {
    let wkt = String::from_utf8_lossy(bytes);
    (
        direct_unit_factor(&wkt, "PROJCS["),
        direct_unit_factor(&wkt, "VERT_CS["),
    )
}

pub fn describe_crs_from_las_header(header: &las::Header) -> CrsInfo {
    let mut info = describe_names(header);
    let wkt_bytes = header
        .get_wkt_crs_bytes()
        .filter(|b| b.iter().any(|c| !c.is_ascii_whitespace() && *c != 0));
    let (horizontal_wkt, vertical_wkt) = wkt_bytes.map(wkt_units).unwrap_or((None, None));
    let horizontal = match info.kind {
        CrsKind::PlaneRectangular | CrsKind::Utm => Some(1.0),
        _ => horizontal_wkt,
    };
    info.horizontal_unit_to_meter = horizontal;
    info.vertical_unit_to_meter = vertical_wkt.or(horizontal);
    info
}

fn describe_names(header: &las::Header) -> CrsInfo {
    let wkt_bytes = header
        .get_wkt_crs_bytes()
        .filter(|b| b.iter().any(|c| !c.is_ascii_whitespace() && *c != 0));
    if let Some(wkt) = wkt_bytes {
        let epsg = epsg_from_wkt(wkt);
        let crs = epsg.map(Crs::from_epsg).unwrap_or(Crs::Unknown);
        return match recognized_name(crs) {
            Some((kind, name)) => CrsInfo {
                epsg,
                name,
                kind,
                error: None,
                horizontal_unit_to_meter: None,
                vertical_unit_to_meter: None,
            },
            None => CrsInfo {
                epsg,
                name: wkt_name(wkt)
                    .or_else(|| epsg.map(|c| format!("EPSG:{c}")))
                    .unwrap_or_else(|| "（名前なし）".to_string()),
                kind: CrsKind::Other,
                error: None,
                horizontal_unit_to_meter: None,
                vertical_unit_to_meter: None,
            },
        };
    }
    match header.get_geotiff_crs() {
        Ok(Some(geotiff)) => match geotiff.get_projected_crs_geo_key_value() {
            Some(code) if (1..=32766).contains(&code) => {
                let epsg = code as u32;
                match recognized_name(Crs::from_epsg(epsg)) {
                    Some((kind, name)) => CrsInfo {
                        epsg: Some(epsg),
                        name,
                        kind,
                        error: None,
                        horizontal_unit_to_meter: None,
                        vertical_unit_to_meter: None,
                    },
                    None => CrsInfo {
                        epsg: Some(epsg),
                        name: format!("EPSG:{epsg}"),
                        kind: CrsKind::Other,
                        error: None,
                        horizontal_unit_to_meter: None,
                        vertical_unit_to_meter: None,
                    },
                }
            }
            _ => CrsInfo {
                epsg: None,
                name: "地理座標系または未対応の座標系".to_string(),
                kind: CrsKind::Other,
                error: None,
                horizontal_unit_to_meter: None,
                vertical_unit_to_meter: None,
            },
        },
        Ok(None) => CrsInfo::none(),
        Err(e) => CrsInfo::failed(format!("GeoTIFFキーを読めなかった: {e}")),
    }
}

pub fn read_crs_info<R: Read + Seek>(reader: &mut R) -> CrsInfo {
    match read_header_with_vlrs(reader) {
        Ok(header) => describe_crs_from_las_header(&header),
        Err(message) => CrsInfo::failed(message),
    }
}

fn read_header_with_vlrs<R: Read + Seek>(reader: &mut R) -> Result<las::Header, String> {
    reader
        .seek(SeekFrom::Start(0))
        .map_err(|e| format!("ファイル先頭へ移動できなかった: {e}"))?;
    let raw = las::raw::Header::read_from(&mut *reader)
        .map_err(|e| format!("LASヘッダーを読めなかった: {e}"))?;
    let vlr_count = raw.number_of_variable_length_records;
    let header_size = u64::from(raw.header_size);
    let mut builder =
        las::Builder::new(raw).map_err(|e| format!("LASヘッダーを解釈できなかった: {e}"))?;
    reader
        .seek(SeekFrom::Start(header_size))
        .map_err(|e| format!("VLRの位置へ移動できなかった: {e}"))?;
    for _ in 0..vlr_count {
        let raw_vlr = las::raw::Vlr::read_from(&mut *reader, false)
            .map_err(|e| format!("VLRを読めなかった: {e}"))?;
        builder.vlrs.push(las::Vlr::new(raw_vlr));
    }
    builder
        .into_header()
        .map_err(|e| format!("LASヘッダーを組み立てられなかった: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn header_with_wkt(wkt: &str) -> las::Header {
        let mut header = las::Builder::from((1, 4)).into_header().expect("header");
        header
            .set_wkt_crs(wkt.as_bytes().to_vec())
            .expect("set wkt");
        header
    }

    #[test]
    fn roman_numerals_for_all_zones() {
        assert_eq!(roman(1), "I");
        assert_eq!(roman(4), "IV");
        assert_eq!(roman(9), "IX");
        assert_eq!(roman(14), "XIV");
        assert_eq!(roman(19), "XIX");
    }

    #[test]
    fn wkt_jgd2011_ix_is_plane_rectangular() {
        let info = describe_crs_from_las_header(&header_with_wkt(
            "PROJCS[\"JGD2011 / Japan Plane Rectangular CS IX\",AUTHORITY[\"EPSG\",\"6677\"]]",
        ));
        assert_eq!(info.epsg, Some(6677));
        assert_eq!(info.kind, CrsKind::PlaneRectangular);
        assert_eq!(info.name, "JGD2011 / 平面直角座標系 第IX系");
        assert_eq!(info.error, None);
    }

    #[test]
    fn wkt_unsupported_keeps_raw_name_and_epsg() {
        let info = describe_crs_from_las_header(&header_with_wkt(
            "PROJCS[\"NAD83 / Oregon GIC Lambert (ft)\",AUTHORITY[\"EPSG\",\"2992\"]]",
        ));
        assert_eq!(info.epsg, Some(2992));
        assert_eq!(info.kind, CrsKind::Other);
        assert_eq!(info.name, "NAD83 / Oregon GIC Lambert (ft)");
    }

    #[test]
    fn wkt_without_authority_keeps_name_only() {
        let info = describe_crs_from_las_header(&header_with_wkt("PROJCS[\"Local grid\"]"));
        assert_eq!(info.epsg, None);
        assert_eq!(info.kind, CrsKind::Other);
        assert_eq!(info.name, "Local grid");
    }

    const AUTZEN_WKT: &str = "COMPD_CS[\"NAD83 / Oregon GIC Lambert (ft) + NAVD88 height (ftUS)\",PROJCS[\"NAD83 / Oregon GIC Lambert (ft)\",GEOGCS[\"NAD83\",DATUM[\"North_American_Datum_1983\",SPHEROID[\"GRS 1980\",6378137,298.257222101,AUTHORITY[\"EPSG\",\"7019\"]],AUTHORITY[\"EPSG\",\"6269\"]],PRIMEM[\"Greenwich\",0,AUTHORITY[\"EPSG\",\"8901\"]],UNIT[\"degree\",0.0174532925199433,AUTHORITY[\"EPSG\",\"9122\"]],AUTHORITY[\"EPSG\",\"4269\"]],PROJECTION[\"Lambert_Conformal_Conic_2SP\"],PARAMETER[\"false_northing\",0],UNIT[\"foot\",0.3048,AUTHORITY[\"EPSG\",\"9002\"]],AXIS[\"Easting\",EAST],AXIS[\"Northing\",NORTH],AUTHORITY[\"EPSG\",\"2992\"]],VERT_CS[\"NAVD88 height (ftUS)\",VERT_DATUM[\"North American Vertical Datum 1988\",2005,AUTHORITY[\"EPSG\",\"5103\"]],UNIT[\"US survey foot\",0.304800609601219,AUTHORITY[\"EPSG\",\"9003\"]],AXIS[\"Gravity-related height\",UP],AUTHORITY[\"EPSG\",\"6360\"]]]";

    #[test]
    fn autzen_units_are_foot_horizontal_and_us_survey_foot_vertical() {
        let info = describe_crs_from_las_header(&header_with_wkt(AUTZEN_WKT));
        assert_eq!(info.epsg, Some(2992));
        assert_eq!(info.horizontal_unit_to_meter, Some(0.3048));
        assert_eq!(info.vertical_unit_to_meter, Some(0.304800609601219));
    }

    #[test]
    fn projcs_unit_is_not_confused_with_the_geogcs_degree_unit() {
        let wkt =
            "PROJCS[\"x\",GEOGCS[\"g\",UNIT[\"degree\",0.0174532925199433]],PROJECTION[\"p\"]]";
        assert_eq!(wkt_units(wkt.as_bytes()), (None, None));
    }

    #[test]
    fn recognized_systems_are_metric_and_unknown_stays_unknown() {
        let jgd = describe_crs_from_las_header(&header_with_wkt(
            "PROJCS[\"JGD2011 / Japan Plane Rectangular CS IX\",AUTHORITY[\"EPSG\",\"6677\"]]",
        ));
        assert_eq!(jgd.horizontal_unit_to_meter, Some(1.0));
        assert_eq!(jgd.vertical_unit_to_meter, Some(1.0));
        let unknown = describe_crs_from_las_header(&header_with_wkt("PROJCS[\"Local grid\"]"));
        assert_eq!(unknown.horizontal_unit_to_meter, None);
        assert_eq!(unknown.vertical_unit_to_meter, None);
    }

    #[test]
    fn no_crs_is_none() {
        let header = las::Builder::from((1, 4)).into_header().expect("header");
        let info = describe_crs_from_las_header(&header);
        assert_eq!(info, CrsInfo::none());
        assert_eq!(info.kind.as_str(), "none");
    }

    #[test]
    fn garbage_bytes_report_error_without_panic() {
        let mut cursor = std::io::Cursor::new(vec![0u8; 10]);
        let info = read_crs_info(&mut cursor);
        assert!(info.error.is_some());
    }

    #[test]
    fn real_tile_header_is_jgd2011_ix() {
        let path =
            std::path::Path::new("C:/rust/point-cloud-viewer/data/tokyo-shibuya/09LD2659.las");
        let Ok(file) = std::fs::File::open(path) else {
            eprintln!("skip: {path:?} が無い");
            return;
        };
        let info = read_crs_info(&mut std::io::BufReader::new(file));
        assert_eq!(info.epsg, Some(6677));
        assert_eq!(info.kind, CrsKind::PlaneRectangular);
        assert!(info.name.contains("第IX系"), "{info:?}");
    }
}
