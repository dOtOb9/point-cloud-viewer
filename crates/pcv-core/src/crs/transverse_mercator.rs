//! 横メルカトル(Gauss-Krüger)投影の順変換・逆変換。
//!
//! 平面直角座標系(JGD2000/JGD2011)とUTMは、どちらも横メルカトル図法であり、
//! 原点の緯度経度・縮尺係数・(UTMの場合は)false easting/northingが異なるだけで
//! 投影の数式自体は共通である(ADR-0008参照)。そのためこのモジュールには
//! 「原点・縮尺係数を与えれば経緯度⇄平面座標を変換する」関数を1組だけ持ち、
//! `plane_rectangular.rs` と `utm.rs` はそれぞれのゾーンのパラメータ表だけを持つ。
//!
//! # 出典(計算式)
//!
//! 河瀬和重(2011)「Gauss-Krüger投影における経緯度座標及び平面直角座標相互間の
//! 座標換算についてのより簡明な計算方法」国土地理院時報, 121, 109-124.
//! <https://www.gsi.go.jp/common/000061216.pdf>
//!
//! この論文の式(5)〜(12)が順変換(経緯度→平面座標)、式(13)〜(22)が逆変換
//! (平面座標→経緯度)である。国土地理院の測量計算サイトの解説ページ
//! <https://vldb.gsi.go.jp/sokuchi/surveycalc/surveycalc/algorithm/bl2xy/bl2xy.htm> と
//! <https://vldb.gsi.go.jp/sokuchi/surveycalc/surveycalc/algorithm/xy2bl/xy2bl.htm> は
//! 同じ式を(Ā, S̄φ0という記号でまとめた形で)掲載しており、本実装はこちらの記号に
//! 合わせている(数学的に同一であることは、この2つの資料を突き合わせて確認した)。
//!
//! 以下のコード中のコメントで式番号(例: 「式(5)」)は河瀬(2011)のものを指す。
//!
//! # 精度の検証について
//!
//! この関数自体の数値的な正しさは、このファイルの単体テストではなく
//! `crates/pcv-core/src/crs/mod.rs` の統合テストで、
//! 国土地理院の測量計算サイトAPI(実際のGRS80・平面直角座標系の値)と
//! Karney(2011)の高精度検証用データセット(WGS84・任意の中央子午線からの経度差)の
//! 両方に対してmm(またはそれ以上)オーダーで一致することを確認している。
//! 出典の詳細は `mod.rs` のテストのコメントを参照。

use super::ellipsoid::Ellipsoid;

/// 横メルカトル座標系の原点・縮尺係数などの投影パラメータ。
///
/// 平面直角座標系では `false_easting = false_northing = 0`、UTMでは
/// `false_easting = 500000`, `false_northing = 0`(北半球)となる。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TransverseMercatorParams {
    pub ellipsoid: Ellipsoid,
    /// 原点の緯度 φ0 [ラジアン]
    pub origin_lat_rad: f64,
    /// 原点の経度(中央子午線) λ0 [ラジアン]
    pub origin_lon_rad: f64,
    /// 原点における縮尺係数 m0
    pub scale_factor: f64,
    /// 東西方向のオフセット(UTMの false easting)[m]
    pub false_easting: f64,
    /// 南北方向のオフセット(UTMの false northing)[m]
    pub false_northing: f64,
}

/// 順変換(経緯度→平面座標)の結果。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ForwardResult {
    /// 平面直角座標系のX座標(南北方向)。UTMのNorthingに相当。
    pub x: f64,
    /// 平面直角座標系のY座標(東西方向)。UTMのEastingに相当。
    pub y: f64,
    /// 子午線収差角 γ [ラジアン]
    pub meridian_convergence_rad: f64,
    /// 縮尺係数 m
    pub scale_factor: f64,
}

/// 逆変換(平面座標→経緯度)の結果。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct InverseResult {
    /// 緯度 φ [ラジアン]
    pub lat_rad: f64,
    /// 経度 λ [ラジアン]
    pub lon_rad: f64,
    /// 子午線収差角 γ [ラジアン]
    pub meridian_convergence_rad: f64,
    /// 縮尺係数 m
    pub scale_factor: f64,
}

/// 式(12)のα係数(j=1..5)。第三扁平率nの多項式。
/// 展開はコンパイル時に決まる有限項(5項)であり、河瀬(2011)が「通常の計算機が
/// 有する計算精度の範囲内では最初の5項までの和で十分」と述べている打ち切り次数
/// をそのまま採用している。
fn alpha_coefficients(n: f64) -> [f64; 5] {
    let n2 = n * n;
    let n3 = n2 * n;
    let n4 = n3 * n;
    let n5 = n4 * n;
    [
        0.5 * n - (2.0 / 3.0) * n2 + (5.0 / 16.0) * n3 + (41.0 / 180.0) * n4 - (127.0 / 288.0) * n5,
        (13.0 / 48.0) * n2 - (3.0 / 5.0) * n3 + (557.0 / 1440.0) * n4 + (281.0 / 630.0) * n5,
        (61.0 / 240.0) * n3 - (103.0 / 140.0) * n4 + (15061.0 / 26880.0) * n5,
        (49561.0 / 161280.0) * n4 - (179.0 / 168.0) * n5,
        (34729.0 / 80640.0) * n5,
    ]
}

/// 式(20)のβ係数(j=1..5)。逆変換で使う。
fn beta_coefficients(n: f64) -> [f64; 5] {
    let n2 = n * n;
    let n3 = n2 * n;
    let n4 = n3 * n;
    let n5 = n4 * n;
    [
        0.5 * n - (2.0 / 3.0) * n2 + (37.0 / 96.0) * n3 - (1.0 / 360.0) * n4 - (81.0 / 512.0) * n5,
        (1.0 / 48.0) * n2 + (1.0 / 15.0) * n3 - (437.0 / 1440.0) * n4 + (46.0 / 105.0) * n5,
        (17.0 / 480.0) * n3 - (37.0 / 840.0) * n4 - (209.0 / 4480.0) * n5,
        (4397.0 / 161280.0) * n4 - (11.0 / 504.0) * n5,
        (4583.0 / 161280.0) * n5,
    ]
}

/// 式(22)のδ係数(j=1..6)。逆変換で緯度を復元するときに使う。
fn delta_coefficients(n: f64) -> [f64; 6] {
    let n2 = n * n;
    let n3 = n2 * n;
    let n4 = n3 * n;
    let n5 = n4 * n;
    let n6 = n5 * n;
    [
        2.0 * n - (2.0 / 3.0) * n2 - 2.0 * n3 + (116.0 / 45.0) * n4 + (26.0 / 45.0) * n5
            - (2854.0 / 675.0) * n6,
        (7.0 / 3.0) * n2 - (8.0 / 5.0) * n3 - (227.0 / 45.0) * n4
            + (2704.0 / 315.0) * n5
            + (2323.0 / 945.0) * n6,
        (56.0 / 15.0) * n3 - (136.0 / 35.0) * n4 - (1262.0 / 105.0) * n5 + (73814.0 / 2835.0) * n6,
        (4279.0 / 630.0) * n4 - (332.0 / 35.0) * n5 - (399572.0 / 14175.0) * n6,
        (4174.0 / 315.0) * n5 - (144838.0 / 6237.0) * n6,
        (601676.0 / 22275.0) * n6,
    ]
}

/// 式(5)の A0..A5。子午線弧長(赤道からの距離)を表す標準的な級数の係数
/// (Gauss-Krüger投影の文献で広く使われる形で、河瀬(2011)の式(5)(6)にもそのまま
/// 現れる)。
fn meridian_arc_coefficients(n: f64) -> [f64; 6] {
    let n2 = n * n;
    let n3 = n2 * n;
    let n4 = n3 * n;
    let n5 = n4 * n;
    [
        1.0 + n2 / 4.0 + n4 / 64.0,
        -1.5 * (n - n3 / 8.0 - n5 / 64.0),
        (15.0 / 16.0) * (n2 - n4 / 4.0),
        -(35.0 / 48.0) * (n3 - (5.0 / 16.0) * n5),
        (315.0 / 512.0) * n4,
        -(693.0 / 1280.0) * n5,
    ]
}

/// 展開係数一式。原点・楕円体だけから決まり、投影しようとする地点によらないため
/// 事前に1回だけ計算しておける(河瀬(2011) 3.2.1節末尾の指摘のとおり)。
struct SeriesConstants {
    n: f64,
    alpha: [f64; 5],
    beta: [f64; 5],
    delta: [f64; 6],
    /// K = 2*m0*Sp/π = m0*a/(1+n)*A0 (Ā に相当)。
    k: f64,
    /// m0 * Sφ0 (原点緯度までの子午線弧長 × 縮尺係数。式(5)の減算項)。
    m0_s_phi0: f64,
}

impl SeriesConstants {
    fn new(ellipsoid: Ellipsoid, origin_lat_rad: f64, scale_factor: f64) -> Self {
        let n = ellipsoid.third_flattening();
        let a = meridian_arc_coefficients(n);
        // K = m0 * a / (1+n) * A0
        let k = scale_factor * ellipsoid.semi_major_axis / (1.0 + n) * a[0];
        // Sφ0 = (a/(1+n)) * (A0*φ0 + Σ_{j=1}^{5} Aj sin(2jφ0))
        // m0*Sφ0 = K*φ0 + m0*(a/(1+n)) * Σ Aj sin(2jφ0)
        let mut sum = 0.0;
        for (j, a_j) in a.iter().enumerate().skip(1) {
            sum += a_j * (2.0 * j as f64 * origin_lat_rad).sin();
        }
        let m0_a_over_1_plus_n = scale_factor * ellipsoid.semi_major_axis / (1.0 + n);
        let m0_s_phi0 = k * origin_lat_rad + m0_a_over_1_plus_n * sum;
        Self {
            n,
            alpha: alpha_coefficients(n),
            beta: beta_coefficients(n),
            delta: delta_coefficients(n),
            k,
            m0_s_phi0,
        }
    }
}

/// 経緯度から平面座標への順変換(河瀬(2011) 式(5)〜(12))。
///
/// `lat_rad`, `lon_rad` は変換したい地点の緯度・経度[ラジアン]。
pub fn forward(params: &TransverseMercatorParams, lat_rad: f64, lon_rad: f64) -> ForwardResult {
    let c = SeriesConstants::new(params.ellipsoid, params.origin_lat_rad, params.scale_factor);
    let n = c.n;

    // 式(10): tanχ (正角緯度の正接)。sinφから等長緯度・正角緯度への変換。
    let sqrt_n = n.sqrt();
    let two_sqrt_n_over_1_plus_n = 2.0 * sqrt_n / (1.0 + n);
    let sin_phi = lat_rad.sin();
    let tan_chi = (sin_phi.atanh()
        - two_sqrt_n_over_1_plus_n * (two_sqrt_n_over_1_plus_n * sin_phi).atanh())
    .sinh();
    let sec_chi = (1.0 + tan_chi * tan_chi).sqrt(); // = t̄ = sqrt(1+tan²χ)

    let delta_lambda = lon_rad - params.origin_lon_rad;
    let cos_dlambda = delta_lambda.cos();
    let sin_dlambda = delta_lambda.sin();

    // 式(9): ξ', η'
    let xi_p = tan_chi.atan2(cos_dlambda);
    let eta_p = (sin_dlambda / sec_chi).atanh();

    // 式(11): σ, τ (式(5)(6)の和の中の三角/双曲線関数と共通の中間量)
    let mut sigma = 1.0;
    let mut tau = 0.0;
    let mut x_sum = xi_p;
    let mut y_sum = eta_p;
    for j in 1..=5usize {
        let jf = j as f64;
        let arg_xi = 2.0 * jf * xi_p;
        let arg_eta = 2.0 * jf * eta_p;
        let alpha_j = c.alpha[j - 1];
        let cosh_eta = arg_eta.cosh();
        let sinh_eta = arg_eta.sinh();
        let sin_xi = arg_xi.sin();
        let cos_xi = arg_xi.cos();

        x_sum += alpha_j * sin_xi * cosh_eta;
        y_sum += alpha_j * cos_xi * sinh_eta;
        sigma += 2.0 * jf * alpha_j * cos_xi * cosh_eta;
        tau += 2.0 * jf * alpha_j * sin_xi * sinh_eta;
    }

    // 式(5)(6)
    let x = c.k * x_sum - c.m0_s_phi0;
    let y = c.k * y_sum;

    // 式(7): 子午線収差角γ。tχ, t̄, λc, λsを直接使う形(bl2xy.htmの表記)。
    //
    // 符号について: 式(7)をそのまま実装すると、国土地理院 測量計算サイトAPI
    // (bl2xy.pl)が返す`gridConv`とは符号が逆になることを実測で確認した
    // (例: IX系原点より西の地点で、式(7)は負・APIは正を返す。X, Yと縮尺係数mは
    // 0.1mm/1e-7の精度で完全に一致するため、これは実装の誤りではなく、
    // 「子午線収差角をどちら向きに正とするか」という定義上の符号の取り方の違いで
    // ある)。本crateはUI等で表示する値がGSIの公開している値と一致するように、
    // ここでAPIの符号に合わせる。
    let gamma = -(tau * sec_chi * cos_dlambda + sigma * tan_chi * sin_dlambda)
        .atan2(sigma * sec_chi * cos_dlambda - tau * tan_chi * sin_dlambda);

    // 式(8): 縮尺係数m
    let m = (c.k / params.ellipsoid.semi_major_axis)
        * ((sigma * sigma + tau * tau) / (tan_chi * tan_chi + cos_dlambda * cos_dlambda)
            * (1.0 + ((1.0 - n) / (1.0 + n) * lat_rad.tan()).powi(2)))
        .sqrt();

    ForwardResult {
        x: x + params.false_northing,
        y: y + params.false_easting,
        meridian_convergence_rad: gamma,
        scale_factor: m,
    }
}

/// 平面座標から経緯度への逆変換(河瀬(2011) 式(13)〜(22))。
///
/// `x`, `y` は false_easting/false_northingを含む「見かけの」座標(UTMなら
/// Easting=500000+..., Northing=...)を渡す。内部で `params` のオフセットを差し引く。
pub fn inverse(params: &TransverseMercatorParams, x: f64, y: f64) -> InverseResult {
    let x = x - params.false_northing;
    let y = y - params.false_easting;

    let c = SeriesConstants::new(params.ellipsoid, params.origin_lat_rad, params.scale_factor);
    let n = c.n;

    // 式(17): ξ = (x + m0*Sφ0) / K, η = y / K
    let xi = (x + c.m0_s_phi0) / c.k;
    let eta = y / c.k;

    // 式(18)(19)
    let mut xi_p = xi;
    let mut eta_p = eta;
    let mut sigma_p = 1.0;
    let mut tau_p = 0.0;
    for j in 1..=5usize {
        let jf = j as f64;
        let arg_xi = 2.0 * jf * xi;
        let arg_eta = 2.0 * jf * eta;
        let beta_j = c.beta[j - 1];
        let cosh_eta = arg_eta.cosh();
        let sinh_eta = arg_eta.sinh();
        let sin_xi = arg_xi.sin();
        let cos_xi = arg_xi.cos();

        xi_p -= beta_j * sin_xi * cosh_eta;
        eta_p -= beta_j * cos_xi * sinh_eta;
        sigma_p -= 2.0 * jf * beta_j * cos_xi * cosh_eta;
        tau_p += 2.0 * jf * beta_j * sin_xi * sinh_eta;
    }

    // 式(21): χ = asin(sinξ'/coshη')
    let chi = (xi_p.sin() / eta_p.cosh()).asin();

    // 式(13): φ = χ + Σ δj sin(2jχ)
    let mut phi = chi;
    for (j, delta_j) in c.delta.iter().enumerate() {
        let jf = (j + 1) as f64;
        phi += delta_j * (2.0 * jf * chi).sin();
    }

    // 式(14): Δλ = atan(sinhη'/cosξ')
    let delta_lambda = eta_p.sinh().atan2(xi_p.cos());
    let lon = params.origin_lon_rad + delta_lambda;

    // 式(15): 子午線収差角γ。符号については`forward`関数の同種のコメントを参照
    // (国土地理院APIの`gridConv`に合わせて符号を反転している)。
    let tan_xi_p = xi_p.tan();
    let tanh_eta_p = eta_p.tanh();
    let gamma =
        -(tau_p + sigma_p * tan_xi_p * tanh_eta_p).atan2(sigma_p - tau_p * tan_xi_p * tanh_eta_p);

    // 式(16): 縮尺係数m
    let m = (c.k / params.ellipsoid.semi_major_axis)
        * ((xi_p.cos().powi(2) + eta_p.sinh().powi(2)) / (sigma_p * sigma_p + tau_p * tau_p)
            * (1.0 + ((1.0 - n) / (1.0 + n) * phi.tan()).powi(2)))
        .sqrt();

    InverseResult {
        lat_rad: phi,
        lon_rad: lon,
        meridian_convergence_rad: gamma,
        scale_factor: m,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crs::ellipsoid::GRS80;

    fn params_ix_system() -> TransverseMercatorParams {
        // 平面直角座標系 IX系: 原点 北緯36度, 東経139度50分, m0=0.9999
        TransverseMercatorParams {
            ellipsoid: GRS80,
            origin_lat_rad: 36.0_f64.to_radians(),
            origin_lon_rad: (139.0 + 50.0 / 60.0_f64).to_radians(),
            scale_factor: 0.9999,
            false_easting: 0.0,
            false_northing: 0.0,
        }
    }

    #[test]
    fn origin_maps_to_zero() {
        // 原点そのものを変換すると、定義上X=Y=0になるはず(式(5)の-m0Sφ0項が
        // ちょうどこれを打ち消すように作られている)。これは出典付きの期待値による
        // 検証ではなく、式の構造から導かれる自明な性質の確認である。
        let p = params_ix_system();
        let r = forward(&p, p.origin_lat_rad, p.origin_lon_rad);
        assert!(r.x.abs() < 1e-9, "x={}", r.x);
        assert!(r.y.abs() < 1e-9, "y={}", r.y);
    }

    #[test]
    fn round_trip_forward_then_inverse_stays_within_submillimeter() {
        // 往復テスト。mmオーダーの精度検証そのものではないが(出典付きの期待値による
        // テストとは別物として扱う、M4-5タスクシートの注記のとおり)、実装が
        // 自己矛盾していないことの確認として置く。
        let p = params_ix_system();
        let lat = 35.681236_f64.to_radians();
        let lon = 139.767125_f64.to_radians();
        let f = forward(&p, lat, lon);
        let inv = inverse(&p, f.x, f.y);
        let lat_diff_m = (inv.lat_rad - lat) * 6_378_137.0; // 概算: 緯度1radのずれ→距離
        let lon_diff_m = (inv.lon_rad - lon) * 6_378_137.0 * lat.cos();
        assert!(lat_diff_m.abs() < 1e-6, "lat diff {lat_diff_m} m");
        assert!(lon_diff_m.abs() < 1e-6, "lon diff {lon_diff_m} m");
    }
}
