use pcv_core::crs::{Crs, JgdEpoch};

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

    fn geo_key_directory_with_one_projected_crs_key(epsg: u16) -> Vec<u8> {
        let key_directory_version = 1u16;
        let key_revision = 1u16;
        let minor_revision = 1u16;
        let number_of_keys = 1u16;
        let projected_crs_geo_key = 3072u16;
        let value_stored_inline = 0u16;
        let value_count = 1u16;
        [
            key_directory_version,
            key_revision,
            minor_revision,
            number_of_keys,
            projected_crs_geo_key,
            value_stored_inline,
            value_count,
            epsg,
        ]
        .iter()
        .flat_map(|value| value.to_le_bytes())
        .collect()
    }

    fn header_with_geotiff_projected_crs(epsg: u16) -> las::Header {
        let mut builder = las::Builder::from((1, 4));
        let data = geo_key_directory_with_one_projected_crs_key(epsg);

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
