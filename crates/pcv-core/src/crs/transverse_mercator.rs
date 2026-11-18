use super::ellipsoid::Ellipsoid;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TransverseMercatorParams {
    pub ellipsoid: Ellipsoid,
    pub origin_lat_rad: f64,
    pub origin_lon_rad: f64,
    pub scale_factor: f64,
    pub false_easting: f64,
    pub false_northing: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ForwardResult {
    pub x: f64,
    pub y: f64,
    pub meridian_convergence_rad: f64,
    pub scale_factor: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct InverseResult {
    pub lat_rad: f64,
    pub lon_rad: f64,
    pub meridian_convergence_rad: f64,
    pub scale_factor: f64,
}

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

struct SeriesConstants {
    n: f64,
    alpha: [f64; 5],
    beta: [f64; 5],
    delta: [f64; 6],
    k: f64,
    m0_s_phi0: f64,
}

impl SeriesConstants {
    fn new(ellipsoid: Ellipsoid, origin_lat_rad: f64, scale_factor: f64) -> Self {
        let n = ellipsoid.third_flattening();
        let a = meridian_arc_coefficients(n);
        let k = scale_factor * ellipsoid.semi_major_axis / (1.0 + n) * a[0];
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

fn gamma_with_the_sign_of_gsi_grid_conv(gamma_as_kawase: f64) -> f64 {
    -gamma_as_kawase
}

pub fn forward(params: &TransverseMercatorParams, lat_rad: f64, lon_rad: f64) -> ForwardResult {
    let c = SeriesConstants::new(params.ellipsoid, params.origin_lat_rad, params.scale_factor);
    let n = c.n;

    let sqrt_n = n.sqrt();
    let two_sqrt_n_over_1_plus_n = 2.0 * sqrt_n / (1.0 + n);
    let sin_phi = lat_rad.sin();
    let tan_chi = (sin_phi.atanh()
        - two_sqrt_n_over_1_plus_n * (two_sqrt_n_over_1_plus_n * sin_phi).atanh())
    .sinh();
    let sec_chi = (1.0 + tan_chi * tan_chi).sqrt();

    let delta_lambda = lon_rad - params.origin_lon_rad;
    let cos_dlambda = delta_lambda.cos();
    let sin_dlambda = delta_lambda.sin();

    let xi_p = tan_chi.atan2(cos_dlambda);
    let eta_p = (sin_dlambda / sec_chi).atanh();

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

    let x = c.k * x_sum - c.m0_s_phi0;
    let y = c.k * y_sum;

    let gamma_as_kawase_eq_7 = (tau * sec_chi * cos_dlambda + sigma * tan_chi * sin_dlambda)
        .atan2(sigma * sec_chi * cos_dlambda - tau * tan_chi * sin_dlambda);
    let gamma = gamma_with_the_sign_of_gsi_grid_conv(gamma_as_kawase_eq_7);

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

pub fn inverse(params: &TransverseMercatorParams, x: f64, y: f64) -> InverseResult {
    let x = x - params.false_northing;
    let y = y - params.false_easting;

    let c = SeriesConstants::new(params.ellipsoid, params.origin_lat_rad, params.scale_factor);
    let n = c.n;

    let xi = (x + c.m0_s_phi0) / c.k;
    let eta = y / c.k;

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

    let chi = (xi_p.sin() / eta_p.cosh()).asin();

    let mut phi = chi;
    for (j, delta_j) in c.delta.iter().enumerate() {
        let jf = (j + 1) as f64;
        phi += delta_j * (2.0 * jf * chi).sin();
    }

    let delta_lambda = eta_p.sinh().atan2(xi_p.cos());
    let lon = params.origin_lon_rad + delta_lambda;

    let tan_xi_p = xi_p.tan();
    let tanh_eta_p = eta_p.tanh();
    let gamma_as_kawase_eq_15 =
        (tau_p + sigma_p * tan_xi_p * tanh_eta_p).atan2(sigma_p - tau_p * tan_xi_p * tanh_eta_p);
    let gamma = gamma_with_the_sign_of_gsi_grid_conv(gamma_as_kawase_eq_15);

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
        let p = params_ix_system();
        let r = forward(&p, p.origin_lat_rad, p.origin_lon_rad);
        assert!(r.x.abs() < 1e-9, "x={}", r.x);
        assert!(r.y.abs() < 1e-9, "y={}", r.y);
    }

    #[test]
    fn round_trip_forward_then_inverse_stays_within_submillimeter() {
        let p = params_ix_system();
        let lat = 35.681236_f64.to_radians();
        let lon = 139.767125_f64.to_radians();
        let f = forward(&p, lat, lon);
        let inv = inverse(&p, f.x, f.y);
        let lat_diff_m = (inv.lat_rad - lat) * 6_378_137.0;
        let lon_diff_m = (inv.lon_rad - lon) * 6_378_137.0 * lat.cos();
        assert!(lat_diff_m.abs() < 1e-6, "lat diff {lat_diff_m} m");
        assert!(lon_diff_m.abs() < 1e-6, "lon diff {lon_diff_m} m");
    }
}
