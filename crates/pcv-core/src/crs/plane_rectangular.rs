use super::ellipsoid::{Ellipsoid, GRS80};
use super::transverse_mercator::{
    forward, inverse, ForwardResult, InverseResult, TransverseMercatorParams,
};

pub const SCALE_FACTOR: f64 = 0.9999;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PlaneRectangularZone {
    pub number: u8,
    pub origin_lat_deg: f64,
    pub origin_lon_deg: f64,
}

pub const ZONES: [PlaneRectangularZone; 19] = [
    PlaneRectangularZone {
        number: 1,
        origin_lat_deg: 33.0,
        origin_lon_deg: 129.5,
    },
    PlaneRectangularZone {
        number: 2,
        origin_lat_deg: 33.0,
        origin_lon_deg: 131.0,
    },
    PlaneRectangularZone {
        number: 3,
        origin_lat_deg: 36.0,
        origin_lon_deg: 132.0 + 10.0 / 60.0,
    },
    PlaneRectangularZone {
        number: 4,
        origin_lat_deg: 33.0,
        origin_lon_deg: 133.5,
    },
    PlaneRectangularZone {
        number: 5,
        origin_lat_deg: 36.0,
        origin_lon_deg: 134.0 + 20.0 / 60.0,
    },
    PlaneRectangularZone {
        number: 6,
        origin_lat_deg: 36.0,
        origin_lon_deg: 136.0,
    },
    PlaneRectangularZone {
        number: 7,
        origin_lat_deg: 36.0,
        origin_lon_deg: 137.0 + 10.0 / 60.0,
    },
    PlaneRectangularZone {
        number: 8,
        origin_lat_deg: 36.0,
        origin_lon_deg: 138.5,
    },
    PlaneRectangularZone {
        number: 9,
        origin_lat_deg: 36.0,
        origin_lon_deg: 139.0 + 50.0 / 60.0,
    },
    PlaneRectangularZone {
        number: 10,
        origin_lat_deg: 40.0,
        origin_lon_deg: 140.0 + 50.0 / 60.0,
    },
    PlaneRectangularZone {
        number: 11,
        origin_lat_deg: 44.0,
        origin_lon_deg: 140.0 + 15.0 / 60.0,
    },
    PlaneRectangularZone {
        number: 12,
        origin_lat_deg: 44.0,
        origin_lon_deg: 142.0 + 15.0 / 60.0,
    },
    PlaneRectangularZone {
        number: 13,
        origin_lat_deg: 44.0,
        origin_lon_deg: 144.0 + 15.0 / 60.0,
    },
    PlaneRectangularZone {
        number: 14,
        origin_lat_deg: 26.0,
        origin_lon_deg: 142.0,
    },
    PlaneRectangularZone {
        number: 15,
        origin_lat_deg: 26.0,
        origin_lon_deg: 127.5,
    },
    PlaneRectangularZone {
        number: 16,
        origin_lat_deg: 26.0,
        origin_lon_deg: 124.0,
    },
    PlaneRectangularZone {
        number: 17,
        origin_lat_deg: 26.0,
        origin_lon_deg: 131.0,
    },
    PlaneRectangularZone {
        number: 18,
        origin_lat_deg: 20.0,
        origin_lon_deg: 136.0,
    },
    PlaneRectangularZone {
        number: 19,
        origin_lat_deg: 26.0,
        origin_lon_deg: 154.0,
    },
];

pub fn zone_by_number(number: u8) -> Option<PlaneRectangularZone> {
    ZONES.iter().find(|z| z.number == number).copied()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JgdEpoch {
    Jgd2000,
    Jgd2011,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PlaneRectangularCrs {
    pub zone: PlaneRectangularZone,
    pub epoch: JgdEpoch,
}

impl PlaneRectangularCrs {
    pub fn new(number: u8, epoch: JgdEpoch) -> Option<Self> {
        zone_by_number(number).map(|zone| Self { zone, epoch })
    }

    fn ellipsoid(&self) -> Ellipsoid {
        GRS80
    }

    fn params(&self) -> TransverseMercatorParams {
        TransverseMercatorParams {
            ellipsoid: self.ellipsoid(),
            origin_lat_rad: self.zone.origin_lat_deg.to_radians(),
            origin_lon_rad: self.zone.origin_lon_deg.to_radians(),
            scale_factor: SCALE_FACTOR,
            false_easting: 0.0,
            false_northing: 0.0,
        }
    }

    pub fn project(&self, lat_rad: f64, lon_rad: f64) -> ForwardResult {
        forward(&self.params(), lat_rad, lon_rad)
    }

    pub fn unproject(&self, x: f64, y: f64) -> InverseResult {
        inverse(&self.params(), x, y)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zones_match_kawase_2011_reference_program() {
        let phi0_deg = [
            0.0, 33.0, 33.0, 36.0, 33.0, 36.0, 36.0, 36.0, 36.0, 36.0, 40.0, 44.0, 44.0, 44.0,
            26.0, 26.0, 26.0, 26.0, 20.0, 26.0,
        ];
        let lmbd0_min = [
            0.0, 7770.0, 7860.0, 7930.0, 8010.0, 8060.0, 8160.0, 8230.0, 8310.0, 8390.0, 8450.0,
            8415.0, 8535.0, 8655.0, 8520.0, 7650.0, 7440.0, 7860.0, 8160.0, 9240.0,
        ];
        for zone in ZONES {
            let idx = zone.number as usize;
            assert_eq!(zone.origin_lat_deg, phi0_deg[idx], "zone {}", zone.number);
            let expected_lon = lmbd0_min[idx] / 60.0;
            assert!(
                (zone.origin_lon_deg - expected_lon).abs() < 1e-9,
                "zone {}: {} vs {}",
                zone.number,
                zone.origin_lon_deg,
                expected_lon
            );
        }
    }
}
