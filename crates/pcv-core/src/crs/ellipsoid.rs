#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Ellipsoid {
    pub semi_major_axis: f64,
    pub inverse_flattening: f64,
}

impl Ellipsoid {
    pub fn third_flattening(&self) -> f64 {
        1.0 / (2.0 * self.inverse_flattening - 1.0)
    }
}

pub const GRS80: Ellipsoid = Ellipsoid {
    semi_major_axis: 6_378_137.0,
    inverse_flattening: 298.257_222_101,
};

pub const WGS84: Ellipsoid = Ellipsoid {
    semi_major_axis: 6_378_137.0,
    inverse_flattening: 298.257_223_563,
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn third_flattening_matches_reference_program() {
        let n = GRS80.third_flattening();
        let n_js_form = 0.5 / (GRS80.inverse_flattening - 0.5);
        assert!((n - n_js_form).abs() < 1e-18);
    }
}
