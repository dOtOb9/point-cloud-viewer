//! 平面直角座標系(19系)のゾーンパラメータ表。
//!
//! 出典: 国土地理院「平面直角座標系」原点一覧
//! <https://www.gsi.go.jp/LAW/heimencho.html>
//!
//! 各系の原点緯度・経度は上記ページの値をそのまま使う。念のため、
//! 河瀬和重(2011)国土地理院時報121号 119ページのプログラム例に埋め込まれている
//! 同じ表(`phi0=[...]`, `lmbd0=[...]`、経度は分単位)とも突き合わせ、
//! 19系すべてで両者が一致することを確認済み(このファイルの`tests`参照)。

use super::ellipsoid::{Ellipsoid, GRS80};
use super::transverse_mercator::{
    forward, inverse, ForwardResult, InverseResult, TransverseMercatorParams,
};

/// X軸(南北方向)上における縮尺係数。平面直角座標系は全19系共通でこの値を使う
/// (国土地理院「平面直角座標系」の定義)。
pub const SCALE_FACTOR: f64 = 0.9999;

/// 平面直角座標系の1系分の原点定義。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PlaneRectangularZone {
    /// 系番号(1=I系 〜 19=XIX系)
    pub number: u8,
    /// 原点の緯度[度]
    pub origin_lat_deg: f64,
    /// 原点の経度[度]
    pub origin_lon_deg: f64,
}

/// 平面直角座標系19系すべての原点定義(系番号1〜19の順)。
///
/// 出典: <https://www.gsi.go.jp/LAW/heimencho.html>
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

/// 系番号(1〜19)からゾーン定義を引く。範囲外なら`None`。
pub fn zone_by_number(number: u8) -> Option<PlaneRectangularZone> {
    ZONES.iter().find(|z| z.number == number).copied()
}

/// JGD2000とJGD2011の区別。
///
/// ADR-0008「対応しないもの」節のとおり、両者の間の座標補正(パラメータファイルが
/// 必要)はこの段階では実装しない。しかし東北地方太平洋沖地震による地殻変動で
/// 東日本では最大1m前後の差があるため、取り違えを防ぐ目的で型として区別する。
/// 楕円体・原点定義(このファイルの`ZONES`)自体はJGD2000/JGD2011で共通(どちらも
/// GRS80であり、平面直角座標系の原点定義に測地成果の版番号は関わらない)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JgdEpoch {
    Jgd2000,
    Jgd2011,
}

/// 平面直角座標系の1系 + 測地成果の版。実際の変換に使う単位。
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
        // JGD2000/JGD2011はどちらもGRS80(ADR-0008参照)。
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

    /// 緯度経度[ラジアン]から平面直角座標(X, Y)[m]への順変換。
    pub fn project(&self, lat_rad: f64, lon_rad: f64) -> ForwardResult {
        forward(&self.params(), lat_rad, lon_rad)
    }

    /// 平面直角座標(X, Y)[m]から緯度経度[ラジアン]への逆変換。
    pub fn unproject(&self, x: f64, y: f64) -> InverseResult {
        inverse(&self.params(), x, y)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 河瀬(2011) 国土地理院時報121号 119ページのJavaScript例に埋め込まれている
    /// 原点表と、`ZONES`(出典: heimencho.html)がすべての系で一致することを確認する。
    /// (分単位で書かれている経度を度に変換して比較する。)
    #[test]
    fn zones_match_kawase_2011_reference_program() {
        // phi0[1..19] (度), lmbd0[1..19] (分)。河瀬(2011) p.119の
        // `phi0=[0,33,33,36,33,36,36,36,36,36,40,44,44,44,26,26,26,26,20,26]`
        // `lmbd0=[0,7770,7860,7930,8010,8060,8160,8230,8310,8390,8450,8415,8535,
        //         8655,8520,7650,7440,7860,8160,9240]` を転記(添字0はダミー)。
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
