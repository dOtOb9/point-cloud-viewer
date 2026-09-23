//! 範囲読みのバイト位置計算。Worker(JS)にもwasmランタイムにも依存しない、
//! 純粋な整数演算だけの関数を集めた。ネイティブターゲットで`cargo test`できる
//! (`FileRangeReader`/`HttpRangeReader`のようにWeb APIを直接呼ぶコードは
//! wasm32上でしか実行できないため、ここに切り出してテスト可能にした。
//! TaskSheets/ADR-0012-web-worker-sync-io.md の受け入れ条件を参照)。

/// `Read::read(buf)`が呼ばれたときに実際に要求すべきバイト範囲を計算する。
///
/// `pos`: 現在のシーク位置（ファイル/URL先頭からのオフセット）。
/// `want`: 呼び出し側が欲しがっているバイト数（`buf.len()`）。
/// `total`: ファイル全体の既知のサイズ（ローカルファイルなら`File::size()`、
/// URLならRangeプローブで得たContent-Length）。
///
/// 返り値は `[start, end)` の半開区間（`end - start`が実際に読めるバイト数）。
/// `pos`が`total`以上なら空区間（`start == end`）を返し、`read`はそこで
/// `Ok(0)`（EOF）を返せばよい。
pub fn clamp_range(pos: u64, want: u64, total: u64) -> (u64, u64) {
    let start = pos.min(total);
    let end = start.saturating_add(want).min(total);
    (start, end)
}

/// `Seek`の3種類の起点(`SeekFrom`相当)を絶対位置に変換する。
/// `std::io::SeekFrom`をここに持ち込まない(このモジュールを`std::io`非依存に保ち、
/// 将来テストだけを別クレートに切り出す余地を残すため)ため、呼び出し側が
/// `SeekFrom`を分解してこの3引数のどれかに詰め替える。
///
/// 負のオフセットで0未満になる場合は`None`を返す（`std::io::Error`に変換するのは
/// 呼び出し側の責務）。
pub fn resolve_seek_from_start(pos: i64) -> Option<u64> {
    u64::try_from(pos).ok()
}

pub fn resolve_seek_from_end(total: u64, offset: i64) -> Option<u64> {
    let total = i64::try_from(total).ok()?;
    let resolved = total.checked_add(offset)?;
    u64::try_from(resolved).ok()
}

pub fn resolve_seek_from_current(current: u64, offset: i64) -> Option<u64> {
    let current = i64::try_from(current).ok()?;
    let resolved = current.checked_add(offset)?;
    u64::try_from(resolved).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clamp_range_within_bounds_returns_requested_span() {
        assert_eq!(clamp_range(10, 20, 1_000), (10, 30));
    }

    #[test]
    fn clamp_range_clips_to_total_size() {
        // ファイル末尾を跨ぐ読み出し要求は、ファイルサイズで打ち切る
        // (ファイル全体を読まずに済ませるための境界処理の要)。
        assert_eq!(clamp_range(990, 100, 1_000), (990, 1_000));
    }

    #[test]
    fn clamp_range_position_past_end_yields_empty_span() {
        assert_eq!(clamp_range(1_000, 50, 1_000), (1_000, 1_000));
        assert_eq!(clamp_range(2_000, 50, 1_000), (1_000, 1_000));
    }

    #[test]
    fn clamp_range_does_not_overflow_on_huge_want() {
        // want に u64::MAX 近い値が来ても(呼び出し側のバグ等で)オーバーフローしない。
        assert_eq!(clamp_range(0, u64::MAX, 1_000), (0, 1_000));
    }

    #[test]
    fn seek_from_start_rejects_negative() {
        assert_eq!(resolve_seek_from_start(5), Some(5));
        assert_eq!(resolve_seek_from_start(-1), None);
    }

    #[test]
    fn seek_from_end_computes_from_total_size() {
        // 2.03GB(sofiクラス)相当のサイズでもオーバーフローしないことを確認する。
        let total: u64 = 2_180_000_000;
        assert_eq!(resolve_seek_from_end(total, -100), Some(total - 100));
        assert_eq!(resolve_seek_from_end(total, 0), Some(total));
        assert_eq!(resolve_seek_from_end(100, -200), None, "0未満はNone");
    }

    #[test]
    fn seek_from_current_moves_relative_to_position() {
        assert_eq!(resolve_seek_from_current(500, 10), Some(510));
        assert_eq!(resolve_seek_from_current(500, -600), None, "0未満はNone");
        assert_eq!(resolve_seek_from_current(500, -500), Some(0));
    }
}
