//! 画面に出すためのCRSの説明(`CrsInfo`)。
//!
//! `Crs`(`mod.rs`)は「変換に使えるか」だけを持ち、対応範囲外だとEPSGコードも名前も
//! 失われる。画面には「対応範囲外でも、ファイルに書いてある名前かEPSGコード」を
//! 出したいので、ここで別の型にまとめる。パーサは新しく書かず、`mod.rs`の
//! `epsg_from_wkt`と`las`クレートのGeoTIFF解析をそのまま使う。
//!
//! ADR-0015: 読み取りの失敗は`Result`で返さず`CrsInfo::error`に入れる。
//! CRSが読めなくてもファイルは開けるべきなので、呼び出し側は常に`CrsInfo`を受け取る。

use std::io::{Read, Seek, SeekFrom};

use super::{epsg_from_wkt, Crs, JgdEpoch};

/// 画面向けの分類。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CrsKind {
    /// 平面直角座標系(JGD2000/JGD2011)
    PlaneRectangular,
    /// UTM(対応範囲の北半球の帯)
    Utm,
    /// CRS情報はあるが、本アプリが扱う系ではない(または読み取れなかった)
    Other,
    /// ファイルにCRS情報が無い
    None,
}

impl CrsKind {
    /// フロントに渡す文字列。Tauri版・Web版のDTOで共通。
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
    /// 表示名。`kind`が`None`のときは空文字列。
    pub name: String,
    pub kind: CrsKind,
    /// 読み取りに失敗したときのエラー文言。成功なら`None`。
    pub error: Option<String>,
}

impl CrsInfo {
    pub fn none() -> Self {
        Self {
            epsg: None,
            name: String::new(),
            kind: CrsKind::None,
            error: None,
        }
    }

    pub fn failed(message: String) -> Self {
        Self {
            epsg: None,
            name: String::new(),
            kind: CrsKind::Other,
            error: Some(message),
        }
    }
}

/// ローマ数字(平面直角座標系の系番号1〜19用)。
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

/// `Crs`の表示名(対応範囲内のみ)。
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

/// WKTの最初の`PROJCS["名前"`/`PROJCRS["名前"`(なければ`COMPD_CS`・`GEOGCS`)を取り出す。
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

/// `las::Header`のCRS(WKT優先、なければGeoTIFFキー)を説明にする。
pub fn describe_crs_from_las_header(header: &las::Header) -> CrsInfo {
    // 空のWKT(書き出し側が「CRSなし」を空のVLRで表すことがある)は「無い」と同じ扱い。
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
            },
            None => CrsInfo {
                epsg,
                name: wkt_name(wkt)
                    .or_else(|| epsg.map(|c| format!("EPSG:{c}")))
                    .unwrap_or_else(|| "（名前なし）".to_string()),
                kind: CrsKind::Other,
                error: None,
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
                    },
                    None => CrsInfo {
                        epsg: Some(epsg),
                        name: format!("EPSG:{epsg}"),
                        kind: CrsKind::Other,
                        error: None,
                    },
                }
            }
            // 投影座標系のキーが無い(地理座標系のみ等)。CRS情報はあるが扱える系ではない。
            _ => CrsInfo {
                epsg: None,
                name: "地理座標系または未対応の座標系".to_string(),
                kind: CrsKind::Other,
                error: None,
            },
        },
        Ok(None) => CrsInfo::none(),
        Err(e) => CrsInfo::failed(format!("GeoTIFFキーを読めなかった: {e}")),
    }
}

/// LAS/LAZ/COPCの先頭からヘッダーとVLRだけを読み、CRSの説明を返す。
///
/// 点データやEVLR(COPCの階層は数MBになりうる)は読まない。`reader`の位置は
/// 呼び出し後に不定なので、呼び出し側が`seek`し直すこと。
/// どんな失敗でも`CrsInfo::failed`で返し、パニックしない(ADR-0015)。
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

    /// 実データのヘッダーを読む。データが無い環境(CI)では何もしない。
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
