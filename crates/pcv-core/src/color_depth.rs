#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ColorBitDepth {
    Eight,
    Sixteen,
}

impl ColorBitDepth {
    pub fn to_u8(self, value: u16) -> u8 {
        match self {
            ColorBitDepth::Eight => value as u8,
            ColorBitDepth::Sixteen => (value >> 8) as u8,
        }
    }
}

pub fn detect<I: IntoIterator<Item = (u16, u16, u16)>>(colors: I) -> ColorBitDepth {
    for (r, g, b) in colors {
        if r > 255 || g > 255 || b > 255 {
            return ColorBitDepth::Sixteen;
        }
    }
    ColorBitDepth::Eight
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_eight_bit_when_every_channel_fits_in_a_byte() {
        let colors = vec![(10, 20, 30), (255, 0, 128), (0, 0, 0)];
        assert_eq!(detect(colors), ColorBitDepth::Eight);
    }

    #[test]
    fn detects_sixteen_bit_when_any_single_channel_exceeds_255() {
        let colors = vec![(10, 20, 30), (2048, 8704, 256)];
        assert_eq!(detect(colors), ColorBitDepth::Sixteen);
    }

    #[test]
    fn all_zero_colors_are_treated_as_eight_bit_and_shift_result_is_identical_either_way() {
        let colors = vec![(0, 0, 0), (0, 0, 0)];
        assert_eq!(detect(colors), ColorBitDepth::Eight);
        assert_eq!(ColorBitDepth::Eight.to_u8(0), 0);
        assert_eq!(ColorBitDepth::Sixteen.to_u8(0), 0);
    }

    #[test]
    fn detect_with_no_points_defaults_to_eight_bit() {
        let colors: Vec<(u16, u16, u16)> = Vec::new();
        assert_eq!(detect(colors), ColorBitDepth::Eight);
    }

    #[test]
    fn to_u8_eight_bit_passes_the_low_byte_through_unchanged() {
        assert_eq!(ColorBitDepth::Eight.to_u8(200), 200);
    }

    #[test]
    fn to_u8_sixteen_bit_takes_the_upper_byte() {
        assert_eq!(ColorBitDepth::Sixteen.to_u8(0xAB_CD), 0xAB);
    }
}
