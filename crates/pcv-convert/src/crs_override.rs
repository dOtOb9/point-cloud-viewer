//! M4-3: LASヘッダーのCRS(WKTまたはGeoTIFF)を、COPC出力へ運ぶためのWKT文字列に
//! 解決する。
//!
//! # 背景(方針転換で必要になった理由)
//!
//! 当初(パスを渡すだけの一括関数`convert_las_to_copc_streaming_with_crs_wkt_override`を
//! 使う設計)は、元にWKTのVLRがあれば`copc-writer`が自動でそれを出力へ運んで
//! くれるため、本モジュールは「GeoTIFFキーだけの場合の穴埋め」だけを担えばよかった。
//!
//! **Android対応のため低水準API`write_streaming_with_cancel`を使う方針に変えた
//! (`streaming.rs`参照)。** この関数が受け取る`copc_writer::CopcWriteMetadata`は
//! `wkt_crs: Option<String>`という素のWKT文字列を渡す口しか持たず、
//! 「元のWKT VLRを自動で探して運ぶ」処理はしてくれない。そのため、
//! **既にWKTのVLRがある場合も含めて、CRSの解決を自分で行う必要がある。**
//!
//! `TaskSheets/M4-import-and-conversion.md`のM4-1が記録したとおり、`pcv-core`の
//! 読み込み側はLASヘッダーのglobal encoding WKTビット(bit4)が立っていることを
//! 前提にしている。`copc-writer` 0.9.0のソース(`validate.rs`)を読んで確認すると、
//! GeoTIFFキーだけ(WKTのVLRが無い)の入力は、`crs_wkt_override`を渡さない限り
//! **変換そのものが`Error::Unsupported("... GeoTIFF-to-WKT CRS conversion is not
//! implemented in copc-writer")`で失敗する**。つまりこのケースを放置すると、
//! CRSが失われるだけでなく**変換自体がエラーで止まる**。所有者の実データ
//! (GeoTIFF形式のCRSを持つLAS/LAZ)を一切変換できなくなるため、これは
//! 無視できない問題である。
//!
//! `resolved_wkt_crs_for_header`は次の優先順で解決する:
//!
//! 1. 元にWKTのVLR(通常VLRまたはEVLR)があれば、そのままそのWKT文字列を使う
//! 2. GeoTIFFキーだけで、かつ`pcv_core::crs`(M4-5)が対応する系
//!    (平面直角座標系19系・UTM 51N〜56N)なら、検証済みのゾーンパラメータから
//!    WKTを組み立てる
//! 3. それ以外(WKTも対応済みGeoTIFFも無い)は`None`。CRSが失われることを
//!    許容する(対応していない系の変換式を持っていないため、これ以上は
//!    できない)
//!
//! # 生成するWKTについて(正直に)
//!
//! ゾーンの原点緯度経度・central meridian・縮尺係数は`pcv_core::crs`が
//! 国土地理院資料・EPSGレジストリ実測で検証済みの値(M4-5)をそのまま使う。
//! 一方、datum/楕円体/単位のEPSG権威コード(GRS80=7019、JGD2000 datum=6612、
//! JGD2011 datum=1128、JGD2000地理座標系=4612、JGD2011地理座標系=6668、
//! WGS84関連=4326/6326/7030、Greenwich=8901、degree=9122、metre=9001)は
//! 広く使われる既知の固定値であり、GDAL等が出力するWKTでも同じ値が使われるが、
//! **本セッションでEPSGレジストリへ都度問い合わせて確認してはいない**
//! (M4-5のmm精度テストのような、その場で取得した値ではない)。誤りがあれば
//! この一覧を直せばよい形にしてある。
//!
//! 正しさの確認は、生成したWKTを`pcv_core::crs::detect_crs_from_las_header`に
//! 通し、**元と同じ系(zone/epoch)に戻ること**をテストする(下記`tests`)。
//! これはAUTHORITY部分の構造が正しいことの裏付けにはなるが、GDAL等の
//! 外部ツールが全体を有効なWKTとして受理するかまでは確認していない。

use pcv_core::crs::{Crs, JgdEpoch};

/// LASヘッダーのCRSをWKT文字列として解決する。モジュールのドキュメント参照。
pub fn resolved_wkt_crs_for_header(header: &las::Header) -> Option<String> {
    if let Some(bytes) = header.get_wkt_crs_bytes() {
        return Some(decode_wkt_bytes(bytes));
    }
    let epsg = header
        .get_geotiff_crs()
        .ok()
        .flatten()
        .and_then(|geotiff| geotiff.get_projected_crs_geo_key_value())?;
    wkt_for_epsg(epsg)
}

/// WKTのVLRデータはヌル終端されていることがある(`copc-writer`の
/// `null_terminated_wkt_bytes`と同じ想定、`las`クレートの`set_wkt_crs`も
/// ヌル終端を前提にしている)。末尾のヌルバイト以降を切り落としてから
/// 文字列化する。
fn decode_wkt_bytes(bytes: &[u8]) -> String {
    let trimmed = bytes.split(|&b| b == 0).next().unwrap_or(bytes);
    String::from_utf8_lossy(trimmed).into_owned()
}

fn wkt_for_epsg(epsg: u16) -> Option<String> {
    match Crs::from_epsg(u32::from(epsg)) {
        Crs::PlaneRectangular(crs) => Some(plane_rectangular_wkt(
            crs.zone.number,
            crs.epoch,
            crs.zone.origin_lat_deg,
            crs.zone.origin_lon_deg,
            epsg,
        )),
        Crs::Utm(crs) => Some(utm_wkt(
            crs.zone.number,
            crs.zone.central_meridian_deg,
            epsg,
        )),
        Crs::Unknown => None,
    }
}

/// 平面直角座標系の系番号(1〜19)をEPSG命名慣習のローマ数字にする
/// (例: 9 → "IX"。"JGD2011 / Japan Plane Rectangular CS IX"のような名前に使う)。
fn roman_numeral(n: u8) -> &'static str {
    const NUMERALS: [&str; 19] = [
        "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII", "XIII", "XIV",
        "XV", "XVI", "XVII", "XVIII", "XIX",
    ];
    usize::from(n)
        .checked_sub(1)
        .and_then(|i| NUMERALS.get(i))
        .copied()
        .unwrap_or("?")
}

fn plane_rectangular_wkt(
    zone_number: u8,
    epoch: JgdEpoch,
    origin_lat_deg: f64,
    origin_lon_deg: f64,
    epsg: u16,
) -> String {
    let (epoch_name, datum_name, datum_epsg, geogcs_epsg) = match epoch {
        JgdEpoch::Jgd2000 => ("JGD2000", "Japanese Geodetic Datum 2000", 6612u32, 4612u32),
        JgdEpoch::Jgd2011 => ("JGD2011", "Japanese Geodetic Datum 2011", 1128u32, 6668u32),
    };
    let zone_roman = roman_numeral(zone_number);
    format!(
        "PROJCS[\"{epoch_name} / Japan Plane Rectangular CS {zone_roman}\",\
GEOGCS[\"{epoch_name}\",\
DATUM[\"{datum_name}\",SPHEROID[\"GRS 1980\",6378137,298.257222101,AUTHORITY[\"EPSG\",\"7019\"]],AUTHORITY[\"EPSG\",\"{datum_epsg}\"]],\
PRIMEM[\"Greenwich\",0,AUTHORITY[\"EPSG\",\"8901\"]],\
UNIT[\"degree\",0.0174532925199433,AUTHORITY[\"EPSG\",\"9122\"]],\
AUTHORITY[\"EPSG\",\"{geogcs_epsg}\"]],\
PROJECTION[\"Transverse_Mercator\"],\
PARAMETER[\"latitude_of_origin\",{origin_lat_deg}],\
PARAMETER[\"central_meridian\",{origin_lon_deg}],\
PARAMETER[\"scale_factor\",0.9999],\
PARAMETER[\"false_easting\",0],\
PARAMETER[\"false_northing\",0],\
UNIT[\"metre\",1,AUTHORITY[\"EPSG\",\"9001\"]],\
AXIS[\"X\",NORTH],AXIS[\"Y\",EAST],\
AUTHORITY[\"EPSG\",\"{epsg}\"]]"
    )
}

fn utm_wkt(zone_number: u8, central_meridian_deg: f64, epsg: u16) -> String {
    format!(
        "PROJCS[\"WGS 84 / UTM zone {zone_number}N\",\
GEOGCS[\"WGS 84\",\
DATUM[\"WGS_1984\",SPHEROID[\"WGS 84\",6378137,298.257223563,AUTHORITY[\"EPSG\",\"7030\"]],AUTHORITY[\"EPSG\",\"6326\"]],\
PRIMEM[\"Greenwich\",0,AUTHORITY[\"EPSG\",\"8901\"]],\
UNIT[\"degree\",0.0174532925199433,AUTHORITY[\"EPSG\",\"9122\"]],\
AUTHORITY[\"EPSG\",\"4326\"]],\
PROJECTION[\"Transverse_Mercator\"],\
PARAMETER[\"latitude_of_origin\",0],\
PARAMETER[\"central_meridian\",{central_meridian_deg}],\
PARAMETER[\"scale_factor\",0.9996],\
PARAMETER[\"false_easting\",500000],\
PARAMETER[\"false_northing\",0],\
UNIT[\"metre\",1,AUTHORITY[\"EPSG\",\"9001\"]],\
AXIS[\"Easting\",EAST],AXIS[\"Northing\",NORTH],\
AUTHORITY[\"EPSG\",\"{epsg}\"]]"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use pcv_core::crs::detect_crs_from_las_header;

    // pcv-core側のテスト(crates/pcv-core/src/crs/mod.rsの
    // `header_with_geotiff_projected_crs`)と同じ組み立て方
    // (GeoKeyDirectoryTagのバイナリレイアウトはGeoTIFF仕様どおり)。
    // pcv-core側のヘルパーは非公開なので、ここで独立に組み立てる。
    fn header_with_geotiff_projected_crs(epsg: u16) -> las::Header {
        let mut builder = las::Builder::from((1, 4));
        let mut data = Vec::new();
        data.extend_from_slice(&1u16.to_le_bytes()); // KeyDirectoryVersion
        data.extend_from_slice(&1u16.to_le_bytes()); // KeyRevision
        data.extend_from_slice(&1u16.to_le_bytes()); // MinorRevision
        data.extend_from_slice(&1u16.to_le_bytes()); // NumberOfKeys
        data.extend_from_slice(&3072u16.to_le_bytes()); // ProjectedCRSGeoKey
        data.extend_from_slice(&0u16.to_le_bytes()); // location=0(値そのもの)
        data.extend_from_slice(&1u16.to_le_bytes()); // count=1
        data.extend_from_slice(&epsg.to_le_bytes());

        builder.vlrs.push(las::Vlr {
            user_id: "LASF_Projection".to_string(),
            record_id: 34735,
            description: String::new(),
            data,
        });
        builder.into_header().expect("valid header")
    }

    fn header_with_wkt(wkt: &str) -> las::Header {
        let mut header = las::Builder::from((1, 4))
            .into_header()
            .expect("valid header");
        header
            .set_wkt_crs(wkt.as_bytes().to_vec())
            .expect("set wkt");
        header
    }

    #[test]
    fn header_with_existing_wkt_is_passed_through_verbatim() {
        let header = header_with_wkt("PROJCS[\"dummy\"]");
        assert_eq!(
            resolved_wkt_crs_for_header(&header).as_deref(),
            Some("PROJCS[\"dummy\"]")
        );
    }

    #[test]
    fn header_without_any_crs_resolves_to_none() {
        let header = las::Builder::from((1, 4))
            .into_header()
            .expect("valid header");
        assert!(resolved_wkt_crs_for_header(&header).is_none());
    }

    #[test]
    fn unsupported_geotiff_epsg_resolves_to_none() {
        let header = header_with_geotiff_projected_crs(3857);
        assert!(resolved_wkt_crs_for_header(&header).is_none());
    }

    #[test]
    fn jgd2011_ix_geotiff_only_generates_wkt_that_round_trips() {
        let header = header_with_geotiff_projected_crs(6677);
        let wkt = resolved_wkt_crs_for_header(&header).expect("対応範囲のはず");

        let header_with_generated_wkt = header_with_wkt(&wkt);
        match detect_crs_from_las_header(&header_with_generated_wkt) {
            Crs::PlaneRectangular(crs) => {
                assert_eq!(crs.zone.number, 9);
                assert_eq!(crs.epoch, JgdEpoch::Jgd2011);
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn jgd2000_i_geotiff_only_generates_wkt_that_round_trips() {
        let header = header_with_geotiff_projected_crs(2443);
        let wkt = resolved_wkt_crs_for_header(&header).expect("対応範囲のはず");

        let header_with_generated_wkt = header_with_wkt(&wkt);
        match detect_crs_from_las_header(&header_with_generated_wkt) {
            Crs::PlaneRectangular(crs) => {
                assert_eq!(crs.zone.number, 1);
                assert_eq!(crs.epoch, JgdEpoch::Jgd2000);
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn utm54_geotiff_only_generates_wkt_that_round_trips() {
        let header = header_with_geotiff_projected_crs(32654);
        let wkt = resolved_wkt_crs_for_header(&header).expect("対応範囲のはず");

        let header_with_generated_wkt = header_with_wkt(&wkt);
        match detect_crs_from_las_header(&header_with_generated_wkt) {
            Crs::Utm(crs) => assert_eq!(crs.zone.number, 54),
            other => panic!("unexpected {other:?}"),
        }
    }
}
