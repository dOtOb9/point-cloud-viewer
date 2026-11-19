pub mod describe;
pub mod ellipsoid;
pub mod plane_rectangular;
pub mod transverse_mercator;
pub mod utm;

pub use describe::{describe_crs_from_las_header, read_crs_info, CrsInfo, CrsKind};
pub use ellipsoid::{Ellipsoid, GRS80, WGS84};
pub use plane_rectangular::{JgdEpoch, PlaneRectangularCrs, PlaneRectangularZone};
pub use transverse_mercator::{ForwardResult, InverseResult};
pub use utm::{UtmCrs, UtmZone};

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Crs {
    PlaneRectangular(PlaneRectangularCrs),
    Utm(UtmCrs),
    Unknown,
}

impl Crs {
    pub fn from_epsg(code: u32) -> Crs {
        const JGD2011_BASE: u32 = 6668;
        const JGD2000_BASE: u32 = 2442;
        const UTM_NORTH_BASE: u32 = 32600;

        if (JGD2011_BASE + 1..=JGD2011_BASE + 19).contains(&code) {
            let number = (code - JGD2011_BASE) as u8;
            if let Some(crs) = PlaneRectangularCrs::new(number, JgdEpoch::Jgd2011) {
                return Crs::PlaneRectangular(crs);
            }
        }
        if (JGD2000_BASE + 1..=JGD2000_BASE + 19).contains(&code) {
            let number = (code - JGD2000_BASE) as u8;
            if let Some(crs) = PlaneRectangularCrs::new(number, JgdEpoch::Jgd2000) {
                return Crs::PlaneRectangular(crs);
            }
        }
        if code > UTM_NORTH_BASE && code <= UTM_NORTH_BASE + 60 {
            let zone = (code - UTM_NORTH_BASE) as u8;
            if let Some(crs) = UtmCrs::new(zone) {
                return Crs::Utm(crs);
            }
        }
        Crs::Unknown
    }
}

pub const MAX_GEOTIFF_EPSG_CODE: u32 = 32766;

pub fn is_geotiff_epsg_code(code: u32) -> bool {
    (1..=MAX_GEOTIFF_EPSG_CODE).contains(&code)
}

pub fn detect_crs_from_las_header(header: &las::Header) -> Crs {
    if let Some(wkt) = header.get_wkt_crs_bytes() {
        if let Some(code) = epsg_from_wkt(wkt) {
            return Crs::from_epsg(code);
        }
        return Crs::Unknown;
    }
    match header.get_geotiff_crs() {
        Ok(Some(geotiff)) => match geotiff.get_projected_crs_geo_key_value() {
            Some(code) if is_geotiff_epsg_code(u32::from(code)) => Crs::from_epsg(code as u32),
            _ => Crs::Unknown,
        },
        _ => Crs::Unknown,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CrsId {
    Missing,
    Epsg(u32),
    Other(String),
}

impl CrsId {
    pub fn is_missing(&self) -> bool {
        *self == CrsId::Missing
    }
}

pub fn crs_id_from_las_header(header: &las::Header) -> CrsId {
    if let Some(wkt) = header.get_wkt_crs_bytes() {
        let text = String::from_utf8_lossy(wkt);
        let text = text.trim_matches(|c: char| c == '\0' || c.is_whitespace());
        if text.is_empty() {
            return CrsId::Missing;
        }
        return match epsg_from_wkt(wkt) {
            Some(code) => CrsId::Epsg(code),
            None => CrsId::Other(text.to_string()),
        };
    }
    match header.get_geotiff_crs() {
        Ok(Some(geotiff)) => {
            let code = geotiff
                .get_projected_crs_geo_key_value()
                .or_else(|| geotiff.get_geodetic_crs_geo_key_value());
            match code {
                Some(code) if is_geotiff_epsg_code(u32::from(code)) => CrsId::Epsg(u32::from(code)),
                _ => CrsId::Other("GeoTIFF keys without an EPSG code".to_string()),
            }
        }
        Ok(None) => CrsId::Missing,
        Err(e) => CrsId::Other(format!("unreadable GeoTIFF keys: {e}")),
    }
}

fn epsg_from_wkt(bytes: &[u8]) -> Option<u32> {
    let wkt = String::from_utf8_lossy(bytes);
    let horizontal = wkt.split("VERT").next().unwrap_or(&wkt);
    horizontal
        .rmatch_indices("AUTHORITY[\"EPSG\",\"")
        .next()
        .and_then(|(start, matched)| {
            let after = &horizontal[start + matched.len()..];
            let digits: String = after.chars().take_while(|c| c.is_ascii_digit()).collect();
            digits.parse::<u32>().ok()
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn geotiff_epsg_code_range_is_written_only_in_is_geotiff_epsg_code() {
        for (path, source) in [
            ("crs/describe.rs", include_str!("describe.rs")),
            ("raster/output.rs", include_str!("../raster/output.rs")),
            ("raster/geotiff.rs", include_str!("../raster/geotiff.rs")),
        ] {
            for number in ["32766", "32767"] {
                assert!(
                    !source.contains(number),
                    "{path} has {number}; call is_geotiff_epsg_code"
                );
            }
        }
    }

    #[test]
    fn geotiff_epsg_code_is_1_to_32766() {
        assert!(!is_geotiff_epsg_code(0));
        assert!(is_geotiff_epsg_code(1));
        assert!(is_geotiff_epsg_code(32766));
        assert!(!is_geotiff_epsg_code(32767));
    }

    fn assert_close_m(actual: f64, expected: f64, tol_m: f64, what: &str) {
        let diff = (actual - expected).abs();
        assert!(
            diff <= tol_m,
            "{what}: actual={actual}, expected={expected}, diff={diff}m (tol={tol_m}m)"
        );
    }

    #[test]
    fn gsi_api_ix_system_tokyo_station_area() {
        let crs = PlaneRectangularCrs::new(9, JgdEpoch::Jgd2011).unwrap();
        let r = crs.project(35.681236_f64.to_radians(), 139.767125_f64.to_radians());
        assert_close_m(r.x, -35363.2377, 0.0005, "IX系 X");
        assert_close_m(r.y, -5992.9196, 0.0005, "IX系 Y");
        let grid_conv_deg = r.meridian_convergence_rad.to_degrees();
        assert_close_m(grid_conv_deg, 0.038616667, 2e-6, "IX系 子午線収差角[度]");
        assert_close_m(r.scale_factor, 0.99990044, 1e-7, "IX系 縮尺係数");
    }

    #[test]
    fn gsi_api_i_system_kyushu() {
        let crs = PlaneRectangularCrs::new(1, JgdEpoch::Jgd2011).unwrap();
        let r = crs.project(33.1595_f64.to_radians(), 129.7233_f64.to_radians());
        assert_close_m(r.x, 17709.9187, 0.0005, "I系 X");
        assert_close_m(r.y, 20828.4124, 0.0005, "I系 Y");
        assert_close_m(
            r.meridian_convergence_rad.to_degrees(),
            -0.122138889,
            2e-6,
            "I系 子午線収差角[度]",
        );
        assert_close_m(r.scale_factor, 0.99990535, 1e-7, "I系 縮尺係数");
    }

    #[test]
    fn gsi_api_xix_system_remote_island() {
        let crs = PlaneRectangularCrs::new(19, JgdEpoch::Jgd2011).unwrap();
        let r = crs.project(26.5_f64.to_radians(), 154.5_f64.to_radians());
        assert_close_m(r.x, 55487.4167, 0.0005, "XIX系 X");
        assert_close_m(r.y, 49840.4455, 0.0005, "XIX系 Y");
    }

    #[test]
    fn gsi_api_ix_system_far_from_origin_edge_of_zone() {
        let crs = PlaneRectangularCrs::new(9, JgdEpoch::Jgd2011).unwrap();
        let r = crs.project(36.0_f64.to_radians(), 141.3_f64.to_radians());
        assert_close_m(r.x, 994.9177, 0.0005, "IX系端 X");
        assert_close_m(r.y, 132231.3547, 0.0005, "IX系端 Y");
    }

    #[test]
    fn gsi_api_vii_system_inverse() {
        let crs = PlaneRectangularCrs::new(7, JgdEpoch::Jgd2011).unwrap();
        let r = crs.unproject(50000.000, -20000.000);
        let lat_deg = r.lat_rad.to_degrees();
        let lon_deg = r.lon_rad.to_degrees();
        assert_close_m(lat_deg, 36.45043645, 2e-8, "VII系逆変換 緯度[度]");
        assert_close_m(lon_deg, 136.94355016, 2e-8, "VII系逆変換 経度[度]");
        assert_close_m(
            r.meridian_convergence_rad.to_degrees(),
            0.132561111111111,
            2e-6,
            "VII系逆変換 子午線収差角[度]",
        );
        assert_close_m(r.scale_factor, 0.99990493, 1e-7, "VII系逆変換 縮尺係数");
    }

    #[test]
    fn round_trip_multiple_zones_and_positions() {
        let cases: &[(u8, f64, f64)] = &[
            (9, 35.681236, 139.767125),
            (1, 33.1595, 129.7233),
            (19, 26.5, 154.5),
            (9, 36.0, 141.3),
            (13, 43.0, 144.5),
        ];
        for &(zone, lat_deg, lon_deg) in cases {
            let crs = PlaneRectangularCrs::new(zone, JgdEpoch::Jgd2011).unwrap();
            let lat = lat_deg.to_radians();
            let lon = lon_deg.to_radians();
            let f = crs.project(lat, lon);
            let inv = crs.unproject(f.x, f.y);
            let lat_diff_m = (inv.lat_rad - lat) * 6_378_137.0;
            let lon_diff_m = (inv.lon_rad - lon) * 6_378_137.0 * lat.cos();
            assert!(
                lat_diff_m.abs() < 1e-6,
                "zone {zone} lat diff {lat_diff_m} m"
            );
            assert!(
                lon_diff_m.abs() < 1e-6,
                "zone {zone} lon diff {lon_diff_m} m"
            );
        }
    }

    #[test]
    fn karney_2011_tmcoords_small_delta_lambda() {
        let ellipsoid = Ellipsoid {
            semi_major_axis: 6_378_137.0,
            inverse_flattening: 298.257_223_563,
        };
        let params = transverse_mercator::TransverseMercatorParams {
            ellipsoid,
            origin_lat_rad: 0.0,
            origin_lon_rad: 0.0,
            scale_factor: 0.9996,
            false_easting: 0.0,
            false_northing: 0.0,
        };
        let lat = 41.883357469578_f64.to_radians();
        let lon = 0.582386968573_f64.to_radians();
        let r = transverse_mercator::forward(&params, lat, lon);
        assert_close_m(r.y, 48_319.978_043_334, 1e-6, "Karney easting");
        assert_close_m(r.x, 4_636_989.623_809_08, 1e-6, "Karney northing");
    }

    #[test]
    fn karney_2011_tmcoords_larger_delta_lambda() {
        let ellipsoid = Ellipsoid {
            semi_major_axis: 6_378_137.0,
            inverse_flattening: 298.257_223_563,
        };
        let params = transverse_mercator::TransverseMercatorParams {
            ellipsoid,
            origin_lat_rad: 0.0,
            origin_lon_rad: 0.0,
            scale_factor: 0.9996,
            false_easting: 0.0,
            false_northing: 0.0,
        };
        let lat = 29.524235381756_f64.to_radians();
        let lon = 2.523399708599_f64.to_radians();
        let r = transverse_mercator::forward(&params, lat, lon);
        assert_close_m(r.y, 244_569.524_213_355_8, 1e-6, "Karney easting (wide)");
        assert_close_m(r.x, 3_268_723.758_616_713, 1e-6, "Karney northing (wide)");
    }

    #[test]
    fn cross_zone_conversion_via_lat_lon() {
        let ix = PlaneRectangularCrs::new(9, JgdEpoch::Jgd2011).unwrap();
        let lat = 35.681236_f64.to_radians();
        let lon = 139.767125_f64.to_radians();
        let plane = ix.project(lat, lon);

        let back = ix.unproject(plane.x, plane.y);
        let utm54 = UtmCrs::new(54).unwrap();
        let utm = utm54.project(back.lat_rad, back.lon_rad);

        assert!(utm.y < 500_000.0);
        assert!((3_900_000.0..4_000_000.0).contains(&utm.x));
    }

    #[test]
    fn epsg_maps_to_expected_crs() {
        match Crs::from_epsg(6677) {
            Crs::PlaneRectangular(crs) => {
                assert_eq!(crs.zone.number, 9);
                assert_eq!(crs.epoch, JgdEpoch::Jgd2011);
            }
            other => panic!("unexpected {other:?}"),
        }
        match Crs::from_epsg(2451) {
            Crs::PlaneRectangular(crs) => {
                assert_eq!(crs.zone.number, 9);
                assert_eq!(crs.epoch, JgdEpoch::Jgd2000);
            }
            other => panic!("unexpected {other:?}"),
        }
        match Crs::from_epsg(32654) {
            Crs::Utm(crs) => assert_eq!(crs.zone.number, 54),
            other => panic!("unexpected {other:?}"),
        }
        assert!(matches!(Crs::from_epsg(32660), Crs::Unknown));
        assert!(matches!(Crs::from_epsg(4326), Crs::Unknown));
    }

    fn header_with_geotiff_projected_crs(epsg: u16) -> las::Header {
        let mut builder = las::Builder::from((1, 4));
        let mut main_vlr_data = Vec::new();
        main_vlr_data.extend_from_slice(&1u16.to_le_bytes());
        main_vlr_data.extend_from_slice(&1u16.to_le_bytes());
        main_vlr_data.extend_from_slice(&1u16.to_le_bytes());
        main_vlr_data.extend_from_slice(&1u16.to_le_bytes());
        main_vlr_data.extend_from_slice(&3072u16.to_le_bytes());
        main_vlr_data.extend_from_slice(&0u16.to_le_bytes());
        main_vlr_data.extend_from_slice(&1u16.to_le_bytes());
        main_vlr_data.extend_from_slice(&epsg.to_le_bytes());

        let vlr = las::Vlr {
            user_id: "LASF_Projection".to_string(),
            record_id: 34735,
            description: String::new(),
            data: main_vlr_data,
        };
        builder.vlrs.push(vlr);
        builder.into_header().expect("valid header")
    }

    fn header_with_wkt_crs(wkt: &str) -> las::Header {
        let builder = las::Builder::from((1, 4));
        let mut header = builder.into_header().expect("valid header");
        header
            .set_wkt_crs(wkt.as_bytes().to_vec())
            .expect("set wkt");
        header
    }

    #[test]
    fn detect_crs_from_geotiff_projected_key_jgd2011_ix() {
        let header = header_with_geotiff_projected_crs(6677);
        match detect_crs_from_las_header(&header) {
            Crs::PlaneRectangular(crs) => {
                assert_eq!(crs.zone.number, 9);
                assert_eq!(crs.epoch, JgdEpoch::Jgd2011);
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn detect_crs_from_geotiff_unsupported_epsg_is_unknown() {
        let header = header_with_geotiff_projected_crs(3857);
        assert!(matches!(detect_crs_from_las_header(&header), Crs::Unknown));
    }

    #[test]
    fn detect_crs_from_wkt_utm54n() {
        let wkt = "PROJCS[\"WGS 84 / UTM zone 54N\",GEOGCS[\"WGS 84\",AUTHORITY[\"EPSG\",\"4326\"]],AUTHORITY[\"EPSG\",\"32654\"]]";
        let header = header_with_wkt_crs(wkt);
        match detect_crs_from_las_header(&header) {
            Crs::Utm(crs) => assert_eq!(crs.zone.number, 54),
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn detect_crs_from_wkt_ignores_vertical_authority() {
        let wkt = "PROJCS[\"JGD2011 / Japan Plane Rectangular CS IX\",AUTHORITY[\"EPSG\",\"6677\"]],VERT_CS[\"JGD2011 height\",AUTHORITY[\"EPSG\",\"6695\"]]";
        let header = header_with_wkt_crs(wkt);
        match detect_crs_from_las_header(&header) {
            Crs::PlaneRectangular(crs) => assert_eq!(crs.zone.number, 9),
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn crs_id_separates_missing_unsupported_and_unnamed() {
        let no_crs = las::Builder::from((1, 4))
            .into_header()
            .expect("valid header");
        assert_eq!(crs_id_from_las_header(&no_crs), CrsId::Missing);

        let empty_wkt = header_with_wkt_crs("\0");
        assert_eq!(crs_id_from_las_header(&empty_wkt), CrsId::Missing);

        let wkt_2992 = "PROJCS[\"NAD83 / Oregon GIC Lambert (ft)\",AUTHORITY[\"EPSG\",\"2992\"]]";
        let id = crs_id_from_las_header(&header_with_wkt_crs(wkt_2992));
        assert_eq!(id, CrsId::Epsg(2992));
        assert!(matches!(
            detect_crs_from_las_header(&header_with_wkt_crs(wkt_2992)),
            Crs::Unknown
        ));
        assert_eq!(
            crs_id_from_las_header(&header_with_geotiff_projected_crs(2992)),
            CrsId::Epsg(2992)
        );

        let unnamed = header_with_wkt_crs("PROJCS[\"local grid\"]");
        assert_eq!(
            crs_id_from_las_header(&unnamed),
            CrsId::Other("PROJCS[\"local grid\"]".to_string())
        );
    }

    #[test]
    fn detect_crs_missing_returns_unknown() {
        let builder = las::Builder::from((1, 4));
        let header = builder.into_header().expect("valid header");
        assert!(matches!(detect_crs_from_las_header(&header), Crs::Unknown));
    }
}
