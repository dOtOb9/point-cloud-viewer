pub fn clamp_range(pos: u64, want: u64, total: u64) -> (u64, u64) {
    let start = pos.min(total);
    let end = start.saturating_add(want).min(total);
    (start, end)
}

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
        assert_eq!(clamp_range(990, 100, 1_000), (990, 1_000));
    }

    #[test]
    fn clamp_range_position_past_end_yields_empty_span() {
        assert_eq!(clamp_range(1_000, 50, 1_000), (1_000, 1_000));
        assert_eq!(clamp_range(2_000, 50, 1_000), (1_000, 1_000));
    }

    #[test]
    fn clamp_range_does_not_overflow_on_huge_want() {
        assert_eq!(clamp_range(0, u64::MAX, 1_000), (0, 1_000));
    }

    #[test]
    fn seek_from_start_rejects_negative() {
        assert_eq!(resolve_seek_from_start(5), Some(5));
        assert_eq!(resolve_seek_from_start(-1), None);
    }

    #[test]
    fn seek_from_end_computes_from_total_size() {
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
