use std::collections::HashMap;

use crate::tiles::TilePoint;

const MARGIN_SLACK: f64 = 1.000_001;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RorSettings {
    pub radius: f64,
    pub min_neighbors: u32,
}

impl RorSettings {
    pub fn validate(&self) -> Result<(), String> {
        if !self.radius.is_finite() || self.radius <= 0.0 {
            return Err("半径は0より大きい数にしてください".to_string());
        }
        Ok(())
    }

    pub fn margin(&self) -> f64 {
        self.radius * MARGIN_SLACK
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SorSettings {
    pub k: usize,
    pub n_sigma: f64,
    pub search_radius: f64,
}

impl SorSettings {
    pub fn validate(&self) -> Result<(), String> {
        if self.k == 0 {
            return Err("近傍の数 k は1以上にしてください".to_string());
        }
        if !self.n_sigma.is_finite() || self.n_sigma < 0.0 {
            return Err("n は0以上の数にしてください".to_string());
        }
        if !self.search_radius.is_finite() || self.search_radius <= 0.0 {
            return Err("探す範囲は0より大きい数にしてください".to_string());
        }
        Ok(())
    }

    pub fn margin(&self) -> f64 {
        self.search_radius * MARGIN_SLACK
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct RunningStats {
    count: u64,
    mean: f64,
    m2: f64,
}

impl RunningStats {
    pub fn push(&mut self, value: f64) {
        self.count += 1;
        let delta = value - self.mean;
        self.mean += delta / self.count as f64;
        self.m2 += delta * (value - self.mean);
    }

    pub fn count(&self) -> u64 {
        self.count
    }

    pub fn mean(&self) -> f64 {
        self.mean
    }

    pub fn std(&self) -> f64 {
        if self.count < 2 {
            0.0
        } else {
            (self.m2 / self.count as f64).max(0.0).sqrt()
        }
    }

    pub fn threshold(&self, n_sigma: f64) -> f64 {
        self.mean + n_sigma * self.std()
    }
}

struct PointGrid {
    cell: f64,
    origin: [f64; 3],
    positions: Vec<[f64; 3]>,
    order: Vec<u32>,
    cells: HashMap<[i64; 3], (u32, u32)>,
}

impl PointGrid {
    fn new(points: &[TilePoint], cell: f64) -> Self {
        let positions: Vec<[f64; 3]> = points
            .iter()
            .map(|p| [p.record.x, p.record.y, p.record.z])
            .collect();
        let mut origin = [f64::MAX; 3];
        for p in &positions {
            for a in 0..3 {
                origin[a] = origin[a].min(p[a]);
            }
        }
        let mut grid = Self {
            cell,
            origin,
            positions,
            order: Vec::new(),
            cells: HashMap::new(),
        };
        let mut keyed: Vec<([i64; 3], u32)> = (0..grid.positions.len())
            .map(|i| (grid.cell_of(&grid.positions[i]), i as u32))
            .collect();
        keyed.sort_unstable();
        grid.order = keyed.iter().map(|&(_, i)| i).collect();
        let mut start = 0usize;
        while start < keyed.len() {
            let key = keyed[start].0;
            let mut end = start;
            while end < keyed.len() && keyed[end].0 == key {
                end += 1;
            }
            grid.cells.insert(key, (start as u32, (end - start) as u32));
            start = end;
        }
        grid
    }

    fn cell_of(&self, p: &[f64; 3]) -> [i64; 3] {
        [
            ((p[0] - self.origin[0]) / self.cell).floor() as i64,
            ((p[1] - self.origin[1]) / self.cell).floor() as i64,
            ((p[2] - self.origin[2]) / self.cell).floor() as i64,
        ]
    }

    fn cell_points(&self, key: [i64; 3]) -> &[u32] {
        match self.cells.get(&key) {
            Some(&(start, len)) => &self.order[start as usize..(start + len) as usize],
            None => &[],
        }
    }

    fn dist2(&self, a: usize, b: usize) -> f64 {
        let (p, q) = (&self.positions[a], &self.positions[b]);
        let (dx, dy, dz) = (p[0] - q[0], p[1] - q[1], p[2] - q[2]);
        dx * dx + dy * dy + dz * dz
    }

    fn count_within(&self, i: usize, radius: f64, limit: u32) -> u32 {
        let r2 = radius * radius;
        let c = self.cell_of(&self.positions[i]);
        let mut count = 0u32;
        for dz in -1..=1 {
            for dy in -1..=1 {
                for dx in -1..=1 {
                    for &j in self.cell_points([c[0] + dx, c[1] + dy, c[2] + dz]) {
                        if j as usize != i && self.dist2(i, j as usize) <= r2 {
                            count += 1;
                            if count >= limit {
                                return count;
                            }
                        }
                    }
                }
            }
        }
        count
    }

    fn mean_knn_distance(&self, i: usize, k: usize, cap: f64, best: &mut Vec<f64>) -> f64 {
        let cap2 = cap * cap;
        let c = self.cell_of(&self.positions[i]);
        let max_ring = (cap / self.cell).floor() as i64 + 1;
        best.clear();
        for ring in 0..=max_ring {
            for dz in -ring..=ring {
                for dy in -ring..=ring {
                    for dx in -ring..=ring {
                        if dx.abs().max(dy.abs()).max(dz.abs()) != ring {
                            continue;
                        }
                        for &j in self.cell_points([c[0] + dx, c[1] + dy, c[2] + dz]) {
                            if j as usize == i {
                                continue;
                            }
                            let d2 = self.dist2(i, j as usize);
                            if d2 > cap2 {
                                continue;
                            }
                            if best.len() < k {
                                best.push(d2);
                                best.sort_unstable_by(f64::total_cmp);
                            } else if d2 < best[k - 1] {
                                best[k - 1] = d2;
                                best.sort_unstable_by(f64::total_cmp);
                            }
                        }
                    }
                }
            }
            let reach = ring as f64 * self.cell;
            if best.len() == k && best[k - 1] <= reach * reach {
                break;
            }
        }
        let mut sum = 0.0;
        for d2 in best.iter() {
            sum += d2.sqrt();
        }
        sum += (k - best.len()) as f64 * cap;
        sum / k as f64
    }
}

pub fn ror_keep(points: &[TilePoint], settings: &RorSettings) -> Vec<usize> {
    let grid = PointGrid::new(points, settings.radius);
    let mut kept = Vec::new();
    for (i, p) in points.iter().enumerate() {
        if !p.is_core {
            continue;
        }
        if grid.count_within(i, settings.radius, settings.min_neighbors) >= settings.min_neighbors {
            kept.push(i);
        }
    }
    kept
}

fn sor_cell_size(points: &[TilePoint], settings: &SorSettings) -> f64 {
    let cap = settings.search_radius;
    let (mut min, mut max) = ([f64::MAX; 2], [f64::MIN; 2]);
    for p in points {
        min[0] = min[0].min(p.record.x);
        min[1] = min[1].min(p.record.y);
        max[0] = max[0].max(p.record.x);
        max[1] = max[1].max(p.record.y);
    }
    let area = (max[0] - min[0]).max(0.0) * (max[1] - min[1]).max(0.0);
    let guess = if points.is_empty() || area <= 0.0 {
        cap
    } else {
        (2.0 * settings.k as f64 * area / points.len() as f64).sqrt()
    };
    guess.clamp(cap / 6.0, cap)
}

pub fn sor_scores(points: &[TilePoint], settings: &SorSettings, mut f: impl FnMut(usize, f64)) {
    let grid = PointGrid::new(points, sor_cell_size(points, settings));
    let mut scratch = Vec::with_capacity(settings.k + 1);
    for (i, p) in points.iter().enumerate() {
        if p.is_core {
            let score = grid.mean_knn_distance(i, settings.k, settings.search_radius, &mut scratch);
            f(i, score);
        }
    }
}

pub fn sor_accumulate(points: &[TilePoint], settings: &SorSettings, stats: &mut RunningStats) {
    sor_scores(points, settings, |_, score| stats.push(score));
}

pub fn sor_keep(points: &[TilePoint], settings: &SorSettings, threshold: f64) -> Vec<usize> {
    let mut kept = Vec::new();
    sor_scores(points, settings, |i, score| {
        if score <= threshold {
            kept.push(i);
        }
    });
    kept
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{field, open_fn, write_copc};
    use crate::tiles::TileReader;
    use copc_core::LasPointRecord;
    use copc_writer::CopcPointFields;
    use std::collections::BTreeSet;

    fn point(x: f64, y: f64, z: f64, core: bool) -> TilePoint {
        TilePoint {
            record: LasPointRecord {
                x,
                y,
                z,
                ..Default::default()
            },
            is_core: core,
        }
    }

    fn patch_and_loner() -> Vec<TilePoint> {
        let mut v = Vec::new();
        for ix in 0..5 {
            for iy in 0..5 {
                v.push(point(f64::from(ix) * 0.5, f64::from(iy) * 0.5, 0.0, true));
            }
        }
        v.push(point(50.0, 50.0, 0.0, true));
        v
    }

    #[test]
    fn ror_removes_isolated_and_keeps_clustered() {
        let pts = patch_and_loner();
        let kept = ror_keep(
            &pts,
            &RorSettings {
                radius: 1.0,
                min_neighbors: 4,
            },
        );
        assert!(!kept.contains(&25), "loner kept");
        assert_eq!(kept.len(), 25);
    }

    #[test]
    fn ror_counts_exactly_the_neighbours_within_the_radius() {
        let pts: Vec<TilePoint> = (0..6)
            .map(|i| point(f64::from(i), 0.0, 0.0, true))
            .collect();
        let two = ror_keep(
            &pts,
            &RorSettings {
                radius: 1.0,
                min_neighbors: 2,
            },
        );
        assert_eq!(two, vec![1, 2, 3, 4]);
        let one = ror_keep(
            &pts,
            &RorSettings {
                radius: 1.0,
                min_neighbors: 1,
            },
        );
        assert_eq!(one.len(), 6);
        let zero = ror_keep(
            &pts,
            &RorSettings {
                radius: 0.5,
                min_neighbors: 0,
            },
        );
        assert_eq!(zero.len(), 6);
    }

    #[test]
    fn ror_uses_margin_points_as_neighbours_but_does_not_keep_them() {
        let pts = vec![
            point(0.0, 0.0, 0.0, true),
            point(0.5, 0.0, 0.0, false),
            point(0.0, 0.5, 0.0, false),
        ];
        let kept = ror_keep(
            &pts,
            &RorSettings {
                radius: 1.0,
                min_neighbors: 2,
            },
        );
        assert_eq!(kept, vec![0]);
    }

    #[test]
    fn ror_settings_are_validated() {
        let bad = RorSettings {
            radius: 0.0,
            min_neighbors: 1,
        };
        assert!(bad.validate().is_err());
    }

    fn brute_score(pts: &[TilePoint], i: usize, k: usize, cap: f64) -> f64 {
        let mut d: Vec<f64> = (0..pts.len())
            .filter(|&j| j != i)
            .map(|j| {
                let (a, b) = (&pts[i].record, &pts[j].record);
                ((a.x - b.x).powi(2) + (a.y - b.y).powi(2) + (a.z - b.z).powi(2)).sqrt()
            })
            .filter(|&d| d <= cap)
            .collect();
        d.sort_by(f64::total_cmp);
        d.truncate(k);
        (d.iter().sum::<f64>() + (k - d.len()) as f64 * cap) / k as f64
    }

    #[test]
    fn sor_scores_match_brute_force() {
        let pts = scattered_tile_points(400);
        for (k, cap) in [(1, 3.0), (5, 6.0), (8, 20.0), (20, 4.0)] {
            let s = SorSettings {
                k,
                n_sigma: 1.0,
                search_radius: cap,
            };
            let mut count = 0;
            sor_scores(&pts, &s, |i, score| {
                let expected = brute_score(&pts, i, k, cap);
                assert!(
                    (score - expected).abs() <= 1e-12 * expected.max(1.0),
                    "k {k} cap {cap} point {i}: {score} vs {expected}"
                );
                count += 1;
            });
            assert_eq!(count, pts.len());
        }
    }

    #[test]
    fn sor_removes_the_loner_and_keeps_the_patch() {
        let pts = patch_and_loner();
        let s = SorSettings {
            k: 4,
            n_sigma: 2.0,
            search_radius: 100.0,
        };
        let mut stats = RunningStats::default();
        sor_accumulate(&pts, &s, &mut stats);
        assert_eq!(stats.count(), 26);
        let kept = sor_keep(&pts, &s, stats.threshold(s.n_sigma));
        assert_eq!(kept.len(), 25);
        assert!(!kept.contains(&25));
    }

    #[test]
    fn sor_missing_neighbours_count_as_the_search_radius() {
        let pts = vec![point(0.0, 0.0, 0.0, true), point(10.0, 0.0, 0.0, true)];
        let s = SorSettings {
            k: 3,
            n_sigma: 1.0,
            search_radius: 4.0,
        };
        let mut scores = Vec::new();
        sor_scores(&pts, &s, |_, score| scores.push(score));
        assert_eq!(scores, vec![4.0, 4.0]);
    }

    #[test]
    fn running_stats_match_the_direct_formula() {
        let values = [1.0, 4.0, 4.5, 9.0, 2.5, 7.0];
        let mut stats = RunningStats::default();
        for v in values {
            stats.push(v);
        }
        let mean = values.iter().sum::<f64>() / 6.0;
        let var = values.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / 6.0;
        assert!((stats.mean() - mean).abs() < 1e-12);
        assert!((stats.std() - var.sqrt()).abs() < 1e-12);
        assert!((stats.threshold(2.0) - (mean + 2.0 * var.sqrt())).abs() < 1e-12);
    }

    #[test]
    fn sor_settings_are_validated() {
        let ok = SorSettings {
            k: 8,
            n_sigma: 2.0,
            search_radius: 5.0,
        };
        assert!(ok.validate().is_ok());
        assert!(SorSettings { k: 0, ..ok }.validate().is_err());
        assert!(SorSettings {
            n_sigma: -1.0,
            ..ok
        }
        .validate()
        .is_err());
        assert!(SorSettings {
            search_radius: 0.0,
            ..ok
        }
        .validate()
        .is_err());
    }

    fn rng(seed: u64) -> impl FnMut() -> f64 {
        let mut state = seed;
        move || {
            state = state
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            ((state >> 33) as f64) / f64::from(1u32 << 31)
        }
    }

    fn scattered_fields(n: usize) -> Vec<CopcPointFields> {
        let mut next = rng(42);
        let mut v = Vec::new();
        for id in 0..n {
            let (x, y, z) = match id % 5 {
                0 | 1 => (1010.0 + next() * 8.0, 2010.0 + next() * 8.0, next() * 3.0),
                2 => (1050.0 + next() * 10.0, 2030.0 + next() * 6.0, next() * 3.0),
                3 => (1030.0 + next() * 5.0, 2005.0 + next() * 5.0, next() * 6.0),
                _ => (
                    1000.0 + next() * 80.0,
                    2000.0 + next() * 50.0,
                    next() * 20.0,
                ),
            };
            v.push(field(x, y, z, id as f64));
        }
        v
    }

    fn scattered_tile_points(n: usize) -> Vec<TilePoint> {
        scattered_fields(n)
            .iter()
            .map(|f| point(f.x, f.y, f.z, true))
            .collect()
    }

    fn reader(
        path: &std::path::Path,
        cap: u64,
        margin: f64,
    ) -> impl Iterator<Item = crate::tiles::TileData> + '_ {
        let min = if cap >= 1_000_000 { 1.0e6 } else { 0.0 };
        TileReader::new(open_fn(path), cap, min, margin)
            .expect("tile reader")
            .map(|t| t.expect("tile"))
    }

    fn ror_file(path: &std::path::Path, cap: u64, s: &RorSettings) -> BTreeSet<u64> {
        let mut kept = BTreeSet::new();
        let mut tiles = 0;
        for tile in reader(path, cap, s.margin()) {
            tiles += 1;
            for i in ror_keep(&tile.points, s) {
                assert!(
                    kept.insert(tile.points[i].record.gps_time.to_bits()),
                    "twice"
                );
            }
        }
        assert!(cap >= 1_000_000 || tiles > 4, "only {tiles} tiles");
        kept
    }

    #[test]
    fn ror_result_does_not_depend_on_the_tiling() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = write_copc(dir.path(), scattered_fields(3000), 150);
        let s = RorSettings {
            radius: 1.2,
            min_neighbors: 5,
        };
        let reference = ror_file(&path, 1_000_000, &s);
        assert!(
            reference.len() > 500 && reference.len() < 3000,
            "{}",
            reference.len()
        );
        for cap in [900, 300, 100] {
            assert_eq!(ror_file(&path, cap, &s), reference, "cap {cap}");
        }
    }

    #[test]
    fn ror_on_a_lattice_removes_only_the_corners() {
        let mut points = Vec::new();
        let mut id = 0.0;
        for ix in 0..65 {
            for iy in 0..33 {
                points.push(field(500.0 + f64::from(ix), 700.0 + f64::from(iy), 1.0, id));
                id += 1.0;
            }
        }
        let dir = tempfile::tempdir().expect("tempdir");
        let path = write_copc(dir.path(), points, 200);
        let s = RorSettings {
            radius: 1.5,
            min_neighbors: 4,
        };
        let kept = ror_file(&path, 300, &s);
        assert_eq!(kept.len(), 65 * 33 - 4);
        assert_eq!(ror_file(&path, 1_000_000, &s), kept);
    }

    fn sor_file(
        path: &std::path::Path,
        cap: u64,
        s: &SorSettings,
    ) -> (BTreeSet<u64>, RunningStats) {
        let mut stats = RunningStats::default();
        for tile in reader(path, cap, s.margin()) {
            sor_accumulate(&tile.points, s, &mut stats);
        }
        let threshold = stats.threshold(s.n_sigma);
        let mut kept = BTreeSet::new();
        for tile in reader(path, cap, s.margin()) {
            for i in sor_keep(&tile.points, s, threshold) {
                assert!(
                    kept.insert(tile.points[i].record.gps_time.to_bits()),
                    "twice"
                );
            }
        }
        (kept, stats)
    }

    #[test]
    fn sor_result_and_statistics_do_not_depend_on_the_tiling() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = write_copc(dir.path(), scattered_fields(3000), 150);
        let s = SorSettings {
            k: 6,
            n_sigma: 1.0,
            search_radius: 6.0,
        };
        let (reference, ref_stats) = sor_file(&path, 1_000_000, &s);
        assert_eq!(ref_stats.count(), 3000);
        assert!(
            reference.len() > 1000 && reference.len() < 3000,
            "{}",
            reference.len()
        );
        for cap in [900, 300, 100] {
            let (kept, stats) = sor_file(&path, cap, &s);
            assert_eq!(stats.count(), 3000, "every core point counted once");
            const ONLY_THE_SUMMATION_ORDER_DIFFERS: f64 = 1e-9;
            assert!(
                (stats.mean() - ref_stats.mean()).abs()
                    <= ONLY_THE_SUMMATION_ORDER_DIFFERS * ref_stats.mean()
            );
            assert!(
                (stats.std() - ref_stats.std()).abs()
                    <= ONLY_THE_SUMMATION_ORDER_DIFFERS * ref_stats.std()
            );
            assert_eq!(kept, reference, "cap {cap}");
        }
    }
}
