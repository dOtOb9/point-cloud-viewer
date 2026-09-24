//! UTM(ユニバーサル横メルカトル図法)のゾーンパラメータ表。
//!
//! 対応範囲は日本に関係する北半球の帯、51N〜56N(中央子午線 東経123度〜153度)に限定する
//! (ADR-0008「対応範囲」節。「日本に関係する帯(51〜56N)を含む北半球」)。
//! これは沖縄・南西諸島(51N)から北海道東部・南鳥島(56N)までをカバーする。
//! それ以外の帯は現時点では非対応とし、`Crs::Unknown`として扱う
//! (`crs::detect`参照)。
//!
//! UTMのパラメータ自体(縮尺係数・false easting/northing・帯幅6度)は世界共通の定義であり、
//! 出典は多数あるが、ここではEPSGレジストリの定義(例: EPSG:32654 "WGS 84 / UTM zone 54N")
//! に基づく値を採用する。楕円体はADR-0008の方針(EPSG:326xx系列)に従いWGS84とする。

use super::ellipsoid::{Ellipsoid, WGS84};
use super::transverse_mercator::{
    forward, inverse, ForwardResult, InverseResult, TransverseMercatorParams,
};

/// UTMの縮尺係数(中央子午線上)。世界共通。
pub const SCALE_FACTOR: f64 = 0.9996;
/// UTMのfalse easting[m]。世界共通。
pub const FALSE_EASTING: f64 = 500_000.0;
/// UTMのfalse northing[m](北半球)。
pub const FALSE_NORTHING_NORTH: f64 = 0.0;

/// 本crateが対応するUTM帯番号の範囲(北半球)。
pub const MIN_SUPPORTED_ZONE: u8 = 51;
pub const MAX_SUPPORTED_ZONE: u8 = 56;

/// UTM帯1つ分の定義。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct UtmZone {
    /// 帯番号(51〜56)
    pub number: u8,
    /// 中央子午線の経度[度]
    pub central_meridian_deg: f64,
}

/// 帯番号から中央子午線を計算する(UTMの世界共通の定義: 帯1の中央子午線が
/// 西経177度、以後6度おき。 CM = 6*zone - 183)。
fn central_meridian_deg(zone: u8) -> f64 {
    6.0 * zone as f64 - 183.0
}

/// 対応範囲(51N〜56N)のUTM帯定義を返す。範囲外なら`None`。
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

/// UTM(北半球、WGS84)の1帯。実際の変換に使う単位。
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

    /// 緯度経度[ラジアン]からUTM座標(Easting, Northing)[m]への順変換。
    /// `ForwardResult::y` がEasting、`ForwardResult::x` がNorthingに対応する
    /// (`transverse_mercator`モジュールの命名は平面直角座標系のX(南北)/Y(東西)を
    /// 基準にしているため)。
    pub fn project(&self, lat_rad: f64, lon_rad: f64) -> ForwardResult {
        forward(&self.params(), lat_rad, lon_rad)
    }

    /// UTM座標(Easting, Northing)[m]から緯度経度[ラジアン]への逆変換。
    pub fn unproject(&self, easting: f64, northing: f64) -> InverseResult {
        inverse(&self.params(), northing, easting)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn central_meridians_match_known_japan_zones() {
        // 出典: 国土地理院や測量業界で広く引用されるUTM帯と中央子午線の対応
        // (帯51: 東経123度, 52: 129度, 53: 135度, 54: 141度, 55: 147度, 56: 153度)。
        // これはUTMの世界共通の定義(CM = 6*zone-183)から一意に決まる値であり、
        // 個別の資料に頼らずとも式から導出できるが、日本の実務でよく使われる
        // 帯番号と中央子午線の対応表(例: 国土交通省国土地理院の技術資料や
        // 各種GIS解説)とも一致することをここで確認しておく。
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
