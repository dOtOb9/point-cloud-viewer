const I32_ABS_MAX: f64 = i32::MAX as f64;

const SCALE_CANDIDATES: [f64; 8] = [0.0001, 0.001, 0.01, 0.1, 1.0, 10.0, 100.0, 1000.0];

pub fn choose_scale_offset(
    min: (f64, f64, f64),
    max: (f64, f64, f64),
) -> ((f64, f64, f64), (f64, f64, f64)) {
    let scale = (
        choose_axis_scale(min.0, max.0),
        choose_axis_scale(min.1, max.1),
        choose_axis_scale(min.2, max.2),
    );
    (scale, min)
}

fn choose_axis_scale(min: f64, max: f64) -> f64 {
    let range = (max - min).abs();
    for &candidate in &SCALE_CANDIDATES {
        if range / candidate <= I32_ABS_MAX {
            return candidate;
        }
    }
    range / I32_ABS_MAX
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn small_range_gets_finest_scale() {
        let (scale, offset) = choose_scale_offset((-10.0, -5.0, 0.0), (40.0, 55.0, 20.0));
        assert_eq!(scale, (0.0001, 0.0001, 0.0001));
        assert_eq!(offset, (-10.0, -5.0, 0.0));
    }

    #[test]
    fn boundary_between_finest_and_next_candidate() {
        let just_fits = i32::MAX as f64 * 0.0001;
        let scale_at_boundary = choose_axis_scale(0.0, just_fits);
        assert_eq!(scale_at_boundary, 0.0001);

        let just_over = just_fits + 1.0;
        let scale_over_boundary = choose_axis_scale(0.0, just_over);
        assert_eq!(scale_over_boundary, 0.001);
    }

    #[test]
    fn large_range_falls_back_but_still_keeps_submillimeter_precision() {
        let scale = choose_axis_scale(0.0, 500_000.0);
        assert_eq!(scale, 0.001);
        let max_quantization_error = scale / 2.0;
        assert!(max_quantization_error <= 0.001);
    }

    #[test]
    fn degenerate_zero_range_does_not_panic() {
        let (scale, offset) = choose_scale_offset((1.0, 2.0, 3.0), (1.0, 2.0, 3.0));
        assert_eq!(scale, (0.0001, 0.0001, 0.0001));
        assert_eq!(offset, (1.0, 2.0, 3.0));
    }

    #[test]
    fn axes_choose_independent_scales() {
        let (scale, _offset) = choose_scale_offset((0.0, 0.0, 0.0), (600_000.0, 600_000.0, 8.0));
        assert_eq!(scale.0, 0.001);
        assert_eq!(scale.1, 0.001);
        assert_eq!(scale.2, 0.0001);
    }

    #[test]
    fn quantization_round_trip_stays_within_half_scale() {
        let min = (-123.456, 0.0, -9.999);
        let max = (789.012, 1000.0, 50.5);
        let (scale, offset) = choose_scale_offset(min, max);

        let sample_fractions = [0.0, 0.001, 0.25, 0.3333, 0.5, 0.6789, 0.9999, 1.0];
        for &t in &sample_fractions {
            let original = (
                min.0 + (max.0 - min.0) * t,
                min.1 + (max.1 - min.1) * t,
                min.2 + (max.2 - min.2) * t,
            );
            let quantized = (
                ((original.0 - offset.0) / scale.0).round() as i64,
                ((original.1 - offset.1) / scale.1).round() as i64,
                ((original.2 - offset.2) / scale.2).round() as i64,
            );
            assert!(quantized.0 >= i32::MIN as i64 && quantized.0 <= i32::MAX as i64);
            assert!(quantized.1 >= i32::MIN as i64 && quantized.1 <= i32::MAX as i64);
            assert!(quantized.2 >= i32::MIN as i64 && quantized.2 <= i32::MAX as i64);

            let restored = (
                quantized.0 as f64 * scale.0 + offset.0,
                quantized.1 as f64 * scale.1 + offset.1,
                quantized.2 as f64 * scale.2 + offset.2,
            );
            assert!((restored.0 - original.0).abs() <= scale.0 / 2.0 + f64::EPSILON);
            assert!((restored.1 - original.1).abs() <= scale.1 / 2.0 + f64::EPSILON);
            assert!((restored.2 - original.2).abs() <= scale.2 / 2.0 + f64::EPSILON);
        }
    }

    #[test]
    fn extreme_range_does_not_panic() {
        let scale = choose_axis_scale(0.0, 1.0e13);
        assert!(scale.is_finite());
        assert!(scale > 0.0);
    }
}
