use super::ellipsoid::{Ellipsoid, WGS84};
use super::transverse_mercator::{
    forward, inverse, ForwardResult, InverseResult, TransverseMercatorParams,
};

pub const SCALE_FACTOR: f64 = 0.9996;
pub const FALSE_EASTING: f64 = 500_000.0;
pub const FALSE_NORTHING_NORTH: f64 = 0.0;

pub const MIN_SUPPORTED_ZONE: u8 = 51;
pub const MAX_SUPPORTED_ZONE: u8 = 56;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct UtmZone {
    pub number: u8,
    pub central_meridian_deg: f64,
}

const ZONE_WIDTH_DEG: f64 = 6.0;
const CENTRAL_MERIDIAN_OF_ZONE_0_DEG: f64 = -183.0;

fn central_meridian_deg(zone: u8) -> f64 {
    ZONE_WIDTH_DEG * zone as f64 + CENTRAL_MERIDIAN_OF_ZONE_0_DEG
}

pub fn zone_by_number(number: u8) -> Option<UtmZone> {
    if (MIN_SUPPORTED_ZONE..=MAX_SUPPORTED_ZONE).contains(&number) {
        Some(UtmZone {
            number,
            central_meridian_deg: central_meridian_deg(number),
        })
    } else {
        None
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct UtmCrs {
    pub zone: UtmZone,
}

impl UtmCrs {
    pub fn new(number: u8) -> Option<Self> {
        zone_by_number(number).map(|zone| Self { zone })
    }

    fn ellipsoid(&self) -> Ellipsoid {
        WGS84
    }

    fn params(&self) -> TransverseMercatorParams {
        TransverseMercatorParams {
            ellipsoid: self.ellipsoid(),
            origin_lat_rad: 0.0,
            origin_lon_rad: self.zone.central_meridian_deg.to_radians(),
            scale_factor: SCALE_FACTOR,
            false_easting: FALSE_EASTING,
            false_northing: FALSE_NORTHING_NORTH,
        }
    }

    pub fn project(&self, lat_rad: f64, lon_rad: f64) -> ForwardResult {
        forward(&self.params(), lat_rad, lon_rad)
    }

    pub fn unproject(&self, easting: f64, northing: f64) -> InverseResult {
        inverse(&self.params(), northing, easting)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn central_meridians_match_known_japan_zones() {
        let expected = [
            (51u8, 123.0),
            (52, 129.0),
            (53, 135.0),
            (54, 141.0),
            (55, 147.0),
            (56, 153.0),
        ];
        for (zone, cm) in expected {
            let z = zone_by_number(zone).expect("supported zone");
            assert!((z.central_meridian_deg - cm).abs() < 1e-9);
        }
    }

    #[test]
    fn zones_outside_supported_range_are_none() {
        assert!(zone_by_number(50).is_none());
        assert!(zone_by_number(57).is_none());
    }
}
