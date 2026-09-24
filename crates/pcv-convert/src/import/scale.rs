//! LASのscale/offsetの選び方(純粋関数)。
//!
//! LASは座標を32bit整数で持ち、実際の値は`integer * scale + offset`で復元する
//! (`crates/pcv-convert/src/writer.rs`が書き出すLAS/COPCと同じ仕組み)。
//! `scale`を小さくするほど精度は上がるが、範囲(最大値-最小値)を`scale`で割った値が
//! `i32`に収まらなければオーバーフローする。
//!
//! タスクシートM4-4の要求は「入力の座標の範囲から、mm以下の精度を保つ
//! スケール・オフセットを選ぶ」。「mm以下の精度」とは量子化誤差(最大でも
//! `scale/2`)が1mm(0.001m)を超えないことと解釈する。したがって
//! **範囲が許す限り`scale <= 0.001`を選び、それでも足りない極端な入力でだけ
//! 段階的に粗くする**、という単純な総当たりにした。

/// `i32`で表現できる絶対値の上限。LASの整数座標(`i32`)が取りうる範囲は
/// `[-2147483648, 2147483647]`だが、`min`側を`-i32::MAX`までに丸めても
/// 実務上失うものは無いので、対称な上限として扱う。
const I32_ABS_MAX: f64 = i32::MAX as f64;

/// 試すスケールの候補。昇順(細かい方から)に並べ、範囲が収まる最初のものを採る。
/// `0.001`(mm)が要求精度の境界で、`0.0001`(0.1mm)はそれに余裕を持たせた既定値。
/// それでも収まらない広域データ(数百km超)のために粗い候補まで用意する。
const SCALE_CANDIDATES: [f64; 8] = [0.0001, 0.001, 0.01, 0.1, 1.0, 10.0, 100.0, 1000.0];

/// 入力点群のAABB(`min`/`max`、各軸独立)から、LASのscale/offsetを選ぶ。
///
/// - `offset`は各軸の`min`をそのまま使う(整数座標0がちょうど最小値になる。
///   `crates/pcv-convert/src/point.rs`のLAS/LAZ読み込みとは違い、入力に元々
///   scale/offsetは無い=ここで初めて決めるため、素直な選び方でよい)
/// - `scale`は軸ごとに独立に選ぶ(軸によって範囲が大きく異なる入力
///   ―― 例えば水平方向は数百m、鉛直方向は数mのような地形データ ―― で、
///   全軸に同じscaleを強制すると鉛直方向の精度だけ無駄に犠牲になるため)
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
    // ここに来るのは範囲が「候補の最粗(1000m)」でも`i32`に収まらないとき
    // (=範囲が約21億×1000m=200万km超という、地球の点群データでは
    // 実質起こらない広さ)。オーバーフローだけは避ける最終手段として、
    // 範囲がちょうど収まるスケールを逆算する。
    range / I32_ABS_MAX
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 数十m程度の地上型スキャナのデータを想定。最も細かい候補(0.1mm)が
    /// 選ばれ、要求(mm以下)に大きな余裕があることを確認する。
    #[test]
    fn small_range_gets_finest_scale() {
        let (scale, offset) = choose_scale_offset((-10.0, -5.0, 0.0), (40.0, 55.0, 20.0));
        assert_eq!(scale, (0.0001, 0.0001, 0.0001));
        assert_eq!(offset, (-10.0, -5.0, 0.0));
    }

    /// 候補の境界(`0.0001`で表現できる最大範囲ちょうど)。
    /// `i32::MAX * 0.0001`をわずかに超えたら次の候補(`0.001`)に落ちることを確認する。
    #[test]
    fn boundary_between_finest_and_next_candidate() {
        let just_fits = i32::MAX as f64 * 0.0001;
        let scale_at_boundary = choose_axis_scale(0.0, just_fits);
        assert_eq!(scale_at_boundary, 0.0001);

        let just_over = just_fits + 1.0;
        let scale_over_boundary = choose_axis_scale(0.0, just_over);
        assert_eq!(scale_over_boundary, 0.001);
    }

    /// 0.1mmでは`i32`に収まらないが1mmでは収まる範囲(数百km規模)。
    /// 選ばれた`0.001`でも要求(mm以下の精度=誤差1mm以内)を満たすことを確認する
    /// (量子化誤差の上限は`scale/2` = 0.5mm)。
    #[test]
    fn large_range_falls_back_but_still_keeps_submillimeter_precision() {
        let scale = choose_axis_scale(0.0, 500_000.0);
        assert_eq!(scale, 0.001);
        let max_quantization_error = scale / 2.0;
        assert!(max_quantization_error <= 0.001);
    }

    /// 全軸の範囲が0(点が1個だけ、または1平面上に潰れている)退化データでも
    /// パニックせず、最も細かいスケールが選ばれることを確認する。
    #[test]
    fn degenerate_zero_range_does_not_panic() {
        let (scale, offset) = choose_scale_offset((1.0, 2.0, 3.0), (1.0, 2.0, 3.0));
        assert_eq!(scale, (0.0001, 0.0001, 0.0001));
        assert_eq!(offset, (1.0, 2.0, 3.0));
    }

    /// 軸ごとに範囲の桁が大きく違う入力(水平方向は広く、鉛直方向は狭い地形データ)で、
    /// 各軸が独立に最適なスケールを選ぶことを確認する。
    #[test]
    fn axes_choose_independent_scales() {
        let (scale, _offset) = choose_scale_offset((0.0, 0.0, 0.0), (600_000.0, 600_000.0, 8.0));
        assert_eq!(scale.0, 0.001); // 広域(600km)なので1mm止まり
        assert_eq!(scale.1, 0.001);
        assert_eq!(scale.2, 0.0001); // 鉛直方向は狭いので最も細かい0.1mmが選べる
    }

    /// 選んだscale/offsetで実際に量子化(丸めてi32化)して復元しても、
    /// 元の値との誤差が`scale/2`を超えないことを、複数点でランダムに近い
    /// パターンで確認する(往復テスト)。
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
            // i32に収まっていること(オーバーフローしていないこと)自体も確認する。
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

    /// 候補の最粗(1000m)でも収まらない、実務では起こらない極端な範囲でも
    /// パニック(0除算・オーバーフロー)しないことだけを確認する。
    #[test]
    fn extreme_range_does_not_panic() {
        let scale = choose_axis_scale(0.0, 1.0e13);
        assert!(scale.is_finite());
        assert!(scale > 0.0);
    }
}
