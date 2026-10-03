//! COPC/LASの色属性が8bitか16bitかの判定。
//!
//! LASの仕様ではRGBは16bit(0-65535)だが、実際には0-255の8bit値をそのまま
//! 16bit欄に書き込んでいるエンコーダが存在する(仕様違反だが実在する。
//! `beer.laz`がこれに該当することをTaskSheets/M2-shading-and-ui.mdのM2-2で
//! 実データを読んで確認した)。そのようなファイルに対して無条件に`>> 8`で
//! 8bitへ落とすと、255 >> 8 == 0 となり全点の色が(0,0,0)、つまり真っ黒に
//! なる不具合が起きていた(所有者報告)。
//!
//! ## 判定方法
//!
//! `copc.rs`がファイルを開いたとき(`CopcFile::open`/`from_reader`)に**1回だけ**、
//! ルートノード(無ければhierarchy中最も粗いノード)の全点のR/G/Bを見て、
//! どれか1つでも255を超えていれば16bit、全チャンネルが255以下なら8bitと
//! 判定する。以降そのファイルを閉じるまでこの判定を使い回し、**ノードごとに
//! 判定はしない**(ノードごとに判定すると、たまたま暗い部分だけを含むノードが
//! 8bitと誤判定され、同じファイルの中でノードの境界を境に明るさが不連続に
//! 変わってしまう)。
//!
//! ## 誤判定しうる場合
//!
//! 本当に16bitで、かつ判定に使ったノードの点がたまたま全て暗い
//! (R/G/Bのいずれも255以下にしかならない)場合は8bitと誤判定される。
//! ただしこの場合、8bitとして素通しした結果(例: 128ならそのまま128)は、
//! 本来の16bit値を`>> 8`した結果(128 >> 8 == 0)よりもむしろ元の明るさに
//! 近い絵になる。「本当に暗いだけの16bitデータ」を真っ黒にしてしまう
//! (今回の不具合そのもの)よりは安全側に倒れる判定だと考えている。
//!
//! 逆方向の誤判定(本当は8bitなのに16bitと判定してしまう)は、判定に使った
//! ノードの点のどれか1つでもR/G/Bが256以上の値を持てば起こるが、8bit値は
//! 定義上0-255にしか収まらないため、256以上の値が1つでも観測された時点で
//! そのファイルは(少なくとも判定対象のノードでは)実際に16bitであることが
//! 確定しており、誤判定ではない。

/// 色の1チャンネルあたりのbit数。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ColorBitDepth {
    /// 0-255の8bit値がそのまま(16bit欄の下位バイトとして、あるいは生の
    /// 8bit値として)入っている。
    Eight,
    /// LAS仕様通りの0-65535の16bit値。
    Sixteen,
}

impl ColorBitDepth {
    /// この判定に従い、16bit幅の値を8bit(RGBA8)へ変換する。
    pub fn to_u8(self, value: u16) -> u8 {
        match self {
            ColorBitDepth::Eight => value as u8,
            ColorBitDepth::Sixteen => (value >> 8) as u8,
        }
    }
}

/// 与えた色(R, G, B)の列から、ファイル全体の色のbit深度を判定する。
///
/// 1つでも255を超えるチャンネルがあれば`Sixteen`、無ければ(列が空の場合も
/// 含め)`Eight`を返す。呼び出し側(`copc.rs`)は、ファイルを開いたときに
/// ルートノード相当の1ノード分の色をここへ渡し、結果をファイルを閉じるまで
/// 使い回す(モジュール冒頭のコメント参照)。
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
        // beer.lazの実データを模した値(255以下のみ)。
        let colors = vec![(10, 20, 30), (255, 0, 128), (0, 0, 0)];
        assert_eq!(detect(colors), ColorBitDepth::Eight);
    }

    #[test]
    fn detects_sixteen_bit_when_any_single_channel_exceeds_255() {
        // autzen-classified.copc.lazの実データを模した値。
        // 1点目は255以下だが、2点目のGが255を超えるので16bitと判定されるべき。
        let colors = vec![(10, 20, 30), (2048, 8704, 256)];
        assert_eq!(detect(colors), ColorBitDepth::Sixteen);
    }

    #[test]
    fn all_zero_colors_are_treated_as_eight_bit_and_shift_result_is_identical_either_way() {
        // 全点が(0,0,0)の場合はどちらの判定でも結果が変わらない
        // (0 as u8 == 0、0 >> 8 == 0)ことを確認する。
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
