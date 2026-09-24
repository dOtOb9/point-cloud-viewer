//! 地球楕円体のパラメータ。
//!
//! 平面直角座標系(JGD2000/JGD2011)は GRS80 楕円体、UTM(本crateが対応する範囲では
//! WGS84の実現)は WGS84 楕円体を使う。両者は長半径が同じ(6378137m)で、扁平率が
//! 小数点第9位でわずかに異なるだけだが、"確かめていないことを確認したと書かない"
//! という方針に従い、別の定数として区別して持つ(TaskSheets/ADR-0008-formats-and-crs.md
//! 「座標参照系」節、及びM4-import-and-conversion.md M4-5「やること」参照)。

/// 地球楕円体。長半径 `a` [m] と逆扁平率 `inverse_flattening`(= 1/f)で表す。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Ellipsoid {
    /// 長半径 a [m]
    pub semi_major_axis: f64,
    /// 逆扁平率 F = 1/f
    pub inverse_flattening: f64,
}

impl Ellipsoid {
    /// 第三扁平率 n = 1/(2F-1)。河瀬(2011)の式(1)以降で使われる基本量。
    pub fn third_flattening(&self) -> f64 {
        1.0 / (2.0 * self.inverse_flattening - 1.0)
    }
}

/// GRS80 (Geodetic Reference System 1980)。
///
/// 平面直角座標系の準拠楕円体(JGD2000・JGD2011のいずれも同じGRS80を使う。両者の違いは
/// 楕円体ではなく、その上でどの物理点がどの緯度経度で表されるかという「測地成果」の違い
/// であり、本crateが実装する投影計算そのものには影響しない)。
///
/// 出典: 国土地理院時報2011 No.121 河瀬和重
/// 「Gauss-Krüger投影における経緯度座標及び平面直角座標相互間の座標換算についてのより
/// 簡明な計算方法」119ページのプログラム例
/// (`a=6378137 ; rf=298.257222101`)。
/// <https://www.gsi.go.jp/common/000061216.pdf>
pub const GRS80: Ellipsoid = Ellipsoid {
    semi_major_axis: 6_378_137.0,
    inverse_flattening: 298.257_222_101,
};

/// WGS84 (World Geodetic System 1984)。
///
/// ADR-0008により、本crateが対応するUTMはEPSG:326xx系列(WGS84の北半球UTM)としている。
/// 出典: NGA.STND.0036 (World Geodetic System 1984, EGM2008), a=6378137m,
/// 1/f=298.257223563 (国際的に広く引用される値。EPSGレジストリのEPSG:7030
/// "WGS 84"のパラメータとも一致する)。
pub const WGS84: Ellipsoid = Ellipsoid {
    semi_major_axis: 6_378_137.0,
    inverse_flattening: 298.257_223_563,
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn third_flattening_matches_reference_program() {
        // 河瀬(2011)のJavaScript例: n=0.5/(rf-0.5) は 1/(2F-1) と数学的に同じ式の
        // 別の書き方(0.5/(rf-0.5) = 1/(2rf-1))。ここでは式の同値性そのものを確認する。
        let n = GRS80.third_flattening();
        let n_js_form = 0.5 / (GRS80.inverse_flattening - 0.5);
        assert!((n - n_js_form).abs() < 1e-18);
    }
}
