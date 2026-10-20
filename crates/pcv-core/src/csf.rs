//! Cloth Simulation Filtering (CSF) core: separates ground points from non-ground points.
//!
//! References:
//! - Zhang et al. 2016, "An Easy-to-Use Airborne LiDAR Data Filtering Method Based on Cloth
//!   Simulation", Remote Sensing 8(6):501 (called "the paper" below).
//! - The authors' reference implementation (jianboqi/CSF, Apache-2.0) was read for behaviour only;
//!   no code was copied. Places where this file follows the reference rather than the paper, and
//!   places where it differs, are listed in `TaskSheets/G1-T3-csf-core.md`.
//!
//! Streaming design: points are never stored. The caller streams the points twice:
//! 1. `add_point_for_ihv` for every point, then `finish_ihv`;
//! 2. `step` repeatedly (in batches, so a Web Worker can cancel between batches);
//! 3. `is_ground` for every point (second stream), or `height_at` for rasterising the cloth.
//!
//! The cloth is simulated on the inverted point cloud (`z' = -z`, paper section 2.1), so the ground
//! becomes the upper surface and the cloth falls onto it. Particles move vertically only.
//! No randomness and no hash maps are used: the result depends only on the input values (and, for
//! `add_point_for_ihv`, not on the point order, see the tie-break there).

/// Gravity acceleration per step, and Verlet damping (paper section 2.2, Eq. 1-2). The values are
/// the reference implementation's constants, recalled from memory (unverified): 0.2 and 0.01.
const GRAVITY: f32 = 0.2;
const DAMPING: f32 = 0.01;
/// Particles of margin added around the point extent on every side.
const MARGIN_CELLS: usize = 2;

/// Parameters of the filter. Distances are in the units of the point coordinates (metres).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CsfParams {
    /// Grid spacing of the cloth particles.
    pub cloth_resolution: f64,
    /// How stiff the cloth is (1, 2, 3, ...; larger = stiffer). In the paper (section 2.2) this is
    /// the number of constraint relaxations; in the reference implementation it selects the
    /// strength of one relaxation per step (see `single_move_factor`).
    pub rigidness: u32,
    /// Verlet time step. The displacement per step is proportional to `time_step^2`.
    pub time_step: f32,
    /// A point at most this far above the cloth is ground (decided Q20: asymmetric).
    pub class_threshold_upper: f32,
    /// A point at most this far below the cloth is ground.
    pub class_threshold_lower: f32,
    /// Maximum number of simulation steps.
    pub iterations: u32,
    /// Enable the slope post-processing (paper section 2.4).
    pub slope_smooth: bool,
    /// Slope post-processing: a movable particle next to a fixed one is snapped to its own IHV
    /// only if the IHV difference to that neighbour is below this value.
    pub hdiff: f32,
    /// Stop early when the largest vertical move of a movable particle in one step is below this.
    /// The reference implementation uses `class_threshold / 100` (0.005 for 0.5).
    pub convergence_threshold: f32,
}

impl CsfParams {
    /// Owner's "standard" preset (plan 2.2).
    pub fn standard() -> Self {
        Self {
            cloth_resolution: 0.5,
            rigidness: 3,
            time_step: 0.65,
            class_threshold_upper: 0.1,
            class_threshold_lower: 1.0,
            iterations: 500,
            slope_smooth: true,
            hdiff: 0.3,
            convergence_threshold: 0.005,
        }
    }

    /// Owner's "steep terrain" preset: softer cloth, more iterations.
    pub fn steep() -> Self {
        Self {
            rigidness: 1,
            iterations: 1500,
            ..Self::standard()
        }
    }

    /// Checks the values; the message is meant for the user.
    pub fn validate(&self) -> Result<(), String> {
        if !(self.cloth_resolution.is_finite() && self.cloth_resolution > 0.0) {
            return Err("布の解像度は 0 より大きい数にしてください".to_string());
        }
        if self.rigidness == 0 {
            return Err("布の硬さ（rigidness）は 1 以上にしてください".to_string());
        }
        if !(self.time_step.is_finite() && self.time_step > 0.0) {
            return Err("時間刻みは 0 より大きい数にしてください".to_string());
        }
        if !(self.class_threshold_upper.is_finite() && self.class_threshold_upper >= 0.0)
            || !(self.class_threshold_lower.is_finite() && self.class_threshold_lower >= 0.0)
        {
            return Err("分類のしきい値（上・下）は 0 以上の数にしてください".to_string());
        }
        if self.iterations == 0 {
            return Err("反復回数は 1 以上にしてください".to_string());
        }
        if !(self.hdiff.is_finite() && self.hdiff >= 0.0) {
            return Err("斜面処理の高さの差は 0 以上の数にしてください".to_string());
        }
        if !(self.convergence_threshold.is_finite() && self.convergence_threshold >= 0.0) {
            return Err("収束のしきい値は 0 以上の数にしてください".to_string());
        }
        Ok(())
    }
}

/// XY bounding box of the points (not including the margin; the cloth adds it).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct XyExtent {
    pub min_x: f64,
    pub min_y: f64,
    pub max_x: f64,
    pub max_y: f64,
}

/// Result of one `step` call.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CsfProgress {
    /// Simulation steps done so far (over all calls).
    pub iterations_done: u32,
    /// True when the simulation stopped because the cloth settled (not because of the cap).
    pub converged: bool,
    /// True when the cloth is final (post-processing done). `is_ground` is meaningful after this.
    pub finished: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    /// Accepting `add_point_for_ihv`.
    Collecting,
    /// IHV is final; `step` runs the simulation.
    Simulating,
    Done,
}

/// The cloth. Memory: `h`, `prev`, `ihv` (4 B each) + `movable` (1 B) = 13 B per particle, plus
/// `ihv_dist` (4 B) until `finish_ihv`.
pub struct Cloth {
    params: CsfParams,
    nx: usize,
    ny: usize,
    origin_x: f64,
    origin_y: f64,
    /// Heights in inverted coordinates (`-z`).
    h: Vec<f32>,
    prev: Vec<f32>,
    /// Intersection height value: inverted height of the nearest point (paper section 2.3).
    ihv: Vec<f32>,
    /// Squared XY distance (in cell units) of the point that set `ihv`; INFINITY = no point yet.
    ihv_dist: Vec<f32>,
    movable: Vec<bool>,
    phase: Phase,
    iterations_done: u32,
    converged: bool,
    points_seen: u64,
}

impl Cloth {
    /// Creates the cloth. `max_particles` is the cap decided by the caller (desktop and Web differ).
    pub fn new(extent: XyExtent, params: CsfParams, max_particles: u64) -> Result<Self, String> {
        params.validate()?;
        let finite = extent.min_x.is_finite()
            && extent.min_y.is_finite()
            && extent.max_x.is_finite()
            && extent.max_y.is_finite();
        if !finite || extent.max_x < extent.min_x || extent.max_y < extent.min_y {
            return Err("点群の範囲が正しくありません".to_string());
        }
        let res = params.cloth_resolution;
        let cells_x = ((extent.max_x - extent.min_x) / res).ceil();
        let cells_y = ((extent.max_y - extent.min_y) / res).ceil();
        // Compare in f64 first so a huge extent cannot overflow usize.
        let nx_f = cells_x + 1.0 + 2.0 * MARGIN_CELLS as f64;
        let ny_f = cells_y + 1.0 + 2.0 * MARGIN_CELLS as f64;
        let total_f = nx_f * ny_f;
        if total_f > max_particles as f64 {
            return Err(format!(
                "布の粒子が {:.1} 百万個必要で、上限の {:.1} 百万個を超えます。\
                 布の解像度を粗くするか、先に範囲を切り出してください",
                total_f / 1.0e6,
                max_particles as f64 / 1.0e6
            ));
        }
        let nx = nx_f as usize;
        let ny = ny_f as usize;
        let n = nx * ny;
        Ok(Self {
            params,
            nx,
            ny,
            origin_x: extent.min_x - MARGIN_CELLS as f64 * res,
            origin_y: extent.min_y - MARGIN_CELLS as f64 * res,
            h: vec![0.0; n],
            prev: vec![0.0; n],
            ihv: vec![f32::NEG_INFINITY; n],
            ihv_dist: vec![f32::INFINITY; n],
            movable: vec![true; n],
            phase: Phase::Collecting,
            iterations_done: 0,
            converged: false,
            points_seen: 0,
        })
    }

    pub fn particle_count(&self) -> usize {
        self.nx * self.ny
    }

    /// Grid size (columns, rows).
    pub fn grid_size(&self) -> (usize, usize) {
        (self.nx, self.ny)
    }

    /// Bytes held by the particle arrays right now (no points are held).
    pub fn memory_bytes(&self) -> usize {
        self.h.len() * 4
            + self.prev.len() * 4
            + self.ihv.len() * 4
            + self.ihv_dist.len() * 4
            + self.movable.len()
    }

    // ---- Pass 1: IHV ------------------------------------------------------------------------

    /// Feeds one point of the first pass. Points outside the cloth, non-finite points, and calls
    /// after `finish_ihv` are ignored.
    ///
    /// Each point offers its inverted height to the 4 particles around its cell; a particle keeps
    /// the offer from the nearest point in XY. On an exact distance tie the higher inverted height
    /// wins, so the result does not depend on the order of the points.
    pub fn add_point_for_ihv(&mut self, x: f64, y: f64, z: f64) {
        if self.phase != Phase::Collecting || !(x.is_finite() && y.is_finite() && z.is_finite()) {
            return;
        }
        let res = self.params.cloth_resolution;
        let fx = (x - self.origin_x) / res;
        let fy = (y - self.origin_y) / res;
        if fx < 0.0 || fy < 0.0 || fx > (self.nx - 1) as f64 || fy > (self.ny - 1) as f64 {
            return;
        }
        self.points_seen += 1;
        let i0 = (fx.floor() as usize).min(self.nx.saturating_sub(2));
        let j0 = (fy.floor() as usize).min(self.ny.saturating_sub(2));
        let inv = -(z as f32);
        for dj in 0..2usize {
            for di in 0..2usize {
                let i = (i0 + di).min(self.nx - 1);
                let j = (j0 + dj).min(self.ny - 1);
                let ddx = (fx - i as f64) as f32;
                let ddy = (fy - j as f64) as f32;
                let d = ddx * ddx + ddy * ddy;
                let idx = j * self.nx + i;
                if d < self.ihv_dist[idx] || (d == self.ihv_dist[idx] && inv > self.ihv[idx]) {
                    self.ihv_dist[idx] = d;
                    self.ihv[idx] = inv;
                }
            }
        }
    }

    /// Ends pass 1: fills particles that have no point and puts the cloth at its start height.
    ///
    /// Fill (reference implementation's scan-line fill): an empty particle takes the value of the
    /// nearest filled particle in its row (left wins a tie). A row with no filled particle at all
    /// takes the value from the nearest row (up wins a tie) that has one, in the same column.
    pub fn finish_ihv(&mut self) -> Result<(), String> {
        if self.phase != Phase::Collecting {
            return Err("IHV はすでに確定しています".to_string());
        }
        if self.points_seen == 0 {
            return Err("布の範囲に点が 1 つもありません".to_string());
        }
        let (nx, ny) = (self.nx, self.ny);
        let mut row_has_value = vec![false; ny];
        let mut filled = self.ihv.clone();
        for (j, has_value) in row_has_value.iter_mut().enumerate() {
            let row = j * nx;
            let known: Vec<usize> = (0..nx)
                .filter(|&i| self.ihv_dist[row + i].is_finite())
                .collect();
            if known.is_empty() {
                continue;
            }
            *has_value = true;
            for i in 0..nx {
                if self.ihv_dist[row + i].is_finite() {
                    continue;
                }
                // Nearest known index on each side; `known` is sorted.
                let pos = known.partition_point(|&k| k < i);
                let left = pos.checked_sub(1).map(|p| known[p]);
                let right = known.get(pos).copied();
                let pick = match (left, right) {
                    (Some(l), Some(r)) => {
                        if i - l <= r - i {
                            l
                        } else {
                            r
                        }
                    }
                    (Some(l), None) => l,
                    (None, Some(r)) => r,
                    (None, None) => continue,
                };
                filled[row + i] = self.ihv[row + pick];
            }
        }
        for j in 0..ny {
            if row_has_value[j] {
                continue;
            }
            // Nearest row that has values; search outward, up first on a tie.
            let mut src = None;
            for d in 1..ny {
                if j >= d && row_has_value[j - d] {
                    src = Some(j - d);
                    break;
                }
                if j + d < ny && row_has_value[j + d] {
                    src = Some(j + d);
                    break;
                }
            }
            let Some(s) = src else {
                return Err("布の範囲に点が 1 つもありません".to_string());
            };
            for i in 0..nx {
                filled[j * nx + i] = filled[s * nx + i];
            }
        }
        self.ihv = filled;
        self.ihv_dist = Vec::new();
        // Start above the highest inverted height (paper section 2.1; the reference starts the
        // cloth at the top of the inverted points). Known only now because points are not stored.
        let top = self.ihv.iter().copied().fold(f32::NEG_INFINITY, f32::max);
        self.h.iter_mut().for_each(|v| *v = top);
        self.prev.copy_from_slice(&self.h);
        self.phase = Phase::Simulating;
        Ok(())
    }

    // ---- Simulation -------------------------------------------------------------------------

    /// Runs up to `max_iterations` more steps. Stops early when the cloth has settled or the total
    /// step cap (`params.iterations`) is reached; then the slope post-processing runs once and the
    /// cloth is final. Splitting the steps into batches gives exactly the same result.
    pub fn step(&mut self, max_iterations: u32) -> Result<CsfProgress, String> {
        match self.phase {
            Phase::Collecting => return Err("先に finish_ihv を呼んでください".to_string()),
            Phase::Done => return Ok(self.progress()),
            Phase::Simulating => {}
        }
        let mut done_in_batch = 0;
        while done_in_batch < max_iterations && self.iterations_done < self.params.iterations {
            let max_diff = self.one_step();
            self.iterations_done += 1;
            done_in_batch += 1;
            // The reference stops when 0 < max_diff < threshold; with max_diff == 0 (nothing can
            // move any more) there is nothing left to do either, so we stop there too.
            if max_diff < self.params.convergence_threshold {
                self.converged = true;
                break;
            }
        }
        if self.converged || self.iterations_done >= self.params.iterations {
            if self.params.slope_smooth {
                self.slope_post_process();
            }
            self.phase = Phase::Done;
        }
        Ok(self.progress())
    }

    fn progress(&self) -> CsfProgress {
        CsfProgress {
            iterations_done: self.iterations_done,
            converged: self.converged,
            finished: self.phase == Phase::Done,
        }
    }

    /// One step: Verlet move under gravity, one constraint pass, then terrain collision
    /// (paper sections 2.2 and 2.3). Returns the largest vertical move of a movable particle.
    fn one_step(&mut self) -> f32 {
        let dt2 = self.params.time_step * self.params.time_step;
        // Inverted coordinates: gravity pulls the cloth towards smaller values.
        let fall = -GRAVITY * dt2;
        for k in 0..self.h.len() {
            if self.movable[k] {
                let cur = self.h[k];
                self.h[k] = cur + (cur - self.prev[k]) * (1.0 - DAMPING) + fall;
                self.prev[k] = cur;
            }
        }
        self.satisfy_constraints();
        let mut max_diff = 0.0f32;
        for k in 0..self.h.len() {
            if self.movable[k] {
                max_diff = max_diff.max((self.h[k] - self.prev[k]).abs());
            }
        }
        // Collision: a particle that went below the terrain is put on it and fixed.
        for k in 0..self.h.len() {
            if self.movable[k] && self.h[k] <= self.ihv[k] {
                self.h[k] = self.ihv[k];
                self.movable[k] = false;
            }
        }
        max_diff
    }

    /// Internal force (paper section 2.2, Eq. 3): each particle is pulled towards the height of its
    /// 4 neighbours. Two movable particles move a fraction of the difference each; if only one is
    /// movable it takes a (larger) fraction. The factors depend on `rigidness`.
    /// Particles are visited in row-major order and updated in place (Gauss-Seidel), which is
    /// deterministic.
    fn satisfy_constraints(&mut self) {
        let single = single_move_factor(self.params.rigidness);
        let double = double_move_factor(self.params.rigidness);
        let (nx, ny) = (self.nx, self.ny);
        for j in 0..ny {
            for i in 0..nx {
                let p = j * nx + i;
                let neighbours = [
                    (i > 0).then(|| p - 1),
                    (i + 1 < nx).then(|| p + 1),
                    (j > 0).then(|| p - nx),
                    (j + 1 < ny).then(|| p + nx),
                ];
                for q in neighbours.into_iter().flatten() {
                    let diff = self.h[q] - self.h[p];
                    match (self.movable[p], self.movable[q]) {
                        (true, true) => {
                            self.h[p] += diff * double;
                            self.h[q] -= diff * double;
                        }
                        (true, false) => self.h[p] += diff * single,
                        (false, true) => self.h[q] -= diff * single,
                        (false, false) => {}
                    }
                }
            }
        }
    }

    /// Slope post-processing (paper section 2.4): movable particles that are almost on the terrain
    /// next to a fixed particle are snapped to the terrain, and this spreads to their neighbours.
    /// A particle is snapped if its cloth height is within `class_threshold_upper` of its IHV and
    /// the IHV differs from the fixed neighbour's by less than `hdiff`.
    fn slope_post_process(&mut self) {
        let (nx, ny) = (self.nx, self.ny);
        let near = self.params.class_threshold_upper;
        let hdiff = self.params.hdiff;
        let mut queue: Vec<usize> = Vec::new();
        // Seeds: movable particles next to a fixed one.
        for p in 0..self.h.len() {
            if !self.movable[p] {
                continue;
            }
            let (i, j) = (p % nx, p / nx);
            let nb = [
                (i > 0).then(|| p - 1),
                (i + 1 < nx).then(|| p + 1),
                (j > 0).then(|| p - nx),
                (j + 1 < ny).then(|| p + nx),
            ];
            let hit = nb.into_iter().flatten().any(|q| {
                !self.movable[q]
                    && (self.ihv[q] - self.ihv[p]).abs() < hdiff
                    && self.h[p] - self.ihv[p] < near
            });
            if hit {
                self.h[p] = self.ihv[p];
                self.movable[p] = false;
                queue.push(p);
            }
        }
        // Spread (breadth-first; FIFO order keeps it deterministic).
        let mut head = 0;
        while head < queue.len() {
            let c = queue[head];
            head += 1;
            let (i, j) = (c % nx, c / nx);
            let nb = [
                (i > 0).then(|| c - 1),
                (i + 1 < nx).then(|| c + 1),
                (j > 0).then(|| c - nx),
                (j + 1 < ny).then(|| c + nx),
            ];
            for q in nb.into_iter().flatten() {
                if self.movable[q]
                    && (self.ihv[q] - self.ihv[c]).abs() < hdiff
                    && self.h[q] - self.ihv[q] < near
                {
                    self.h[q] = self.ihv[q];
                    self.movable[q] = false;
                    queue.push(q);
                }
            }
        }
    }

    // ---- Output -----------------------------------------------------------------------------

    /// Cloth height at (x, y) in the original (non-inverted) coordinates, bilinear between the 4
    /// particles around it. Positions outside the cloth are clamped to its edge.
    pub fn height_at(&self, x: f64, y: f64) -> f32 {
        let res = self.params.cloth_resolution;
        let fx = ((x - self.origin_x) / res).clamp(0.0, (self.nx - 1) as f64);
        let fy = ((y - self.origin_y) / res).clamp(0.0, (self.ny - 1) as f64);
        let i0 = (fx.floor() as usize).min(self.nx.saturating_sub(2));
        let j0 = (fy.floor() as usize).min(self.ny.saturating_sub(2));
        let i1 = (i0 + 1).min(self.nx - 1);
        let j1 = (j0 + 1).min(self.ny - 1);
        let tx = (fx - i0 as f64) as f32;
        let ty = (fy - j0 as f64) as f32;
        let at = |i: usize, j: usize| self.h[j * self.nx + i];
        let a = at(i0, j0) * (1.0 - tx) + at(i1, j0) * tx;
        let b = at(i0, j1) * (1.0 - tx) + at(i1, j1) * tx;
        -(a * (1.0 - ty) + b * ty)
    }

    /// Owner's asymmetric rule (decided Q20): ground iff
    /// `-class_threshold_lower <= z - cloth_height <= class_threshold_upper`.
    /// The paper and the reference use one symmetric threshold; this is the owner's change.
    pub fn is_ground(&self, x: f64, y: f64, z: f64) -> bool {
        let d = z as f32 - self.height_at(x, y);
        d >= -self.params.class_threshold_lower && d <= self.params.class_threshold_upper
    }
}

/// Strength of one constraint pass when only one of two particles can move, by `rigidness`.
/// The reference implementation has a table indexed by rigidness (up to 14); its values could not
/// be read, so this is an approximation with the same shape: weak for 1, full from 3.
fn single_move_factor(rigidness: u32) -> f32 {
    match rigidness {
        0 => 0.0,
        1 => 0.3,
        2 => 0.6,
        _ => 1.0,
    }
}

/// Same, when both particles can move: each moves this fraction of the height difference
/// (at most 0.5, which makes them meet in the middle).
fn double_move_factor(rigidness: u32) -> f32 {
    match rigidness {
        0 => 0.0,
        1 => 0.3,
        2 => 0.45,
        _ => 0.5,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    type P = (f64, f64, f64);

    /// Small deterministic generator (LCG) so the scatter is the same on every run.
    struct Lcg(u64);
    impl Lcg {
        fn next_f64(&mut self) -> f64 {
            self.0 = self
                .0
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            ((self.0 >> 11) as f64) / ((1u64 << 53) as f64)
        }
    }

    fn extent_of(points: &[P]) -> XyExtent {
        let mut e = XyExtent {
            min_x: f64::MAX,
            min_y: f64::MAX,
            max_x: f64::MIN,
            max_y: f64::MIN,
        };
        for &(x, y, _) in points {
            e.min_x = e.min_x.min(x);
            e.max_x = e.max_x.max(x);
            e.min_y = e.min_y.min(y);
            e.max_y = e.max_y.max(y);
        }
        e
    }

    fn run_cloth(points: &[P], params: CsfParams) -> Cloth {
        let mut cloth = Cloth::new(extent_of(points), params, 10_000_000).unwrap();
        for &(x, y, z) in points {
            cloth.add_point_for_ihv(x, y, z);
        }
        cloth.finish_ihv().unwrap();
        let progress = cloth.step(u32::MAX).unwrap();
        assert!(progress.finished);
        cloth
    }

    /// Flat ground, a building, vegetation and an outlier. Returns points, truth (true = ground)
    /// and a tag per point: 0 ground, 1 roof, 2 wall, 3 vegetation, 4 outlier.
    fn scene_a() -> (Vec<P>, Vec<bool>, Vec<u8>) {
        let mut pts = Vec::new();
        let mut truth = Vec::new();
        let mut tag = Vec::new();
        let step = 0.25;
        let n = (60.0 / step) as usize;
        for iy in 0..=n {
            for ix in 0..=n {
                let (x, y) = (ix as f64 * step, iy as f64 * step);
                let in_building = (20.0..=30.0).contains(&x) && (20.0..=30.0).contains(&y);
                if in_building {
                    pts.push((x, y, 8.0)); // roof; the ground below is not seen
                    truth.push(false);
                    tag.push(1);
                } else {
                    pts.push((x, y, 0.0));
                    truth.push(true);
                    tag.push(0);
                }
            }
        }
        // Walls on the four sides, z from 0.25 to 7.75.
        for k in 0..=40 {
            let t = 20.0 + k as f64 * 0.25;
            for iz in 1..32 {
                let z = iz as f64 * 0.25;
                for &(x, y) in &[(20.0, t), (30.0, t), (t, 20.0), (t, 30.0)] {
                    pts.push((x, y, z));
                    truth.push(false);
                    tag.push(2);
                }
            }
        }
        // Vegetation-like scatter 1.5-6 m above the ground (the ground below it is also present).
        let mut rng = Lcg(12345);
        for _ in 0..600 {
            let x = 35.0 + rng.next_f64() * 20.0;
            let y = 5.0 + rng.next_f64() * 20.0;
            let z = 1.5 + rng.next_f64() * 4.5;
            pts.push((x, y, z));
            truth.push(false);
            tag.push(3);
        }
        // One low outlier below the ground (not on a particle position).
        pts.push((10.13, 40.07, -5.0));
        truth.push(false);
        tag.push(4);
        (pts, truth, tag)
    }

    /// A ramp of `angle_deg` degrees (15 m of run) followed by a flat plateau, with a canopy:
    /// each sample (0.25 m grid) is a ground point with probability `ground_fraction`, otherwise a
    /// canopy point 3 m above the ground. Returns points and truth (true = ground).
    fn scene_ramp(angle_deg: f64, ground_fraction: f64) -> (Vec<P>, Vec<bool>) {
        let slope = angle_deg.to_radians().tan();
        let mut rng = Lcg(99);
        let mut pts = Vec::new();
        let mut truth = Vec::new();
        let step = 0.25;
        for iy in 0..=80 {
            for ix in 0..=160 {
                let x = ix as f64 * step;
                let z = if x < 15.0 { slope * x } else { slope * 15.0 };
                let ground = rng.next_f64() < ground_fraction;
                pts.push((x, iy as f64 * step, if ground { z } else { z + 3.0 }));
                truth.push(ground);
            }
        }
        (pts, truth)
    }

    fn classify(cloth: &Cloth, pts: &[P]) -> Vec<bool> {
        pts.iter()
            .map(|&(x, y, z)| cloth.is_ground(x, y, z))
            .collect()
    }

    /// (recall, precision) of the ground class.
    fn recall_precision(pred: &[bool], truth: &[bool]) -> (f64, f64) {
        let tp = pred.iter().zip(truth).filter(|(p, t)| **p && **t).count() as f64;
        let fp = pred.iter().zip(truth).filter(|(p, t)| **p && !**t).count() as f64;
        let fneg = pred.iter().zip(truth).filter(|(p, t)| !**p && **t).count() as f64;
        (tp / (tp + fneg), tp / (tp + fp))
    }

    #[test]
    fn scene_a_standard() {
        let (pts, truth, tag) = scene_a();
        let cloth = run_cloth(&pts, CsfParams::standard());
        let pred = classify(&cloth, &pts);
        let (recall, precision) = recall_precision(&pred, &truth);
        eprintln!("scene A standard: recall {recall:.4} precision {precision:.4}");
        // Thresholds: the scene is clean (noise-free flat ground), so a correct filter should be
        // nearly perfect; we allow 2 % loss for the cloth edge effects around the building and the
        // outlier, which the paper also reports as the typical error places.
        assert!(recall >= 0.98, "recall {recall}");
        assert!(precision >= 0.98, "precision {precision}");
        for (k, t) in tag.iter().enumerate() {
            let (x, y, _) = pts[k];
            match t {
                // Roof points are non-ground, all of them.
                1 => assert!(!pred[k], "roof point {:?} classified as ground", pts[k]),
                // Vegetation points are non-ground (the scatter is >= 1.5 m above the ground).
                3 => assert!(!pred[k], "vegetation {:?} classified as ground", pts[k]),
                // Ground far from the building and the outlier is ground.
                0 if x < 10.0 && y < 10.0 => assert!(pred[k], "ground {:?} lost", pts[k]),
                _ => {}
            }
        }
    }

    #[test]
    fn asymmetric_thresholds() {
        let (pts, _, _) = scene_a();
        let cloth = run_cloth(&pts, CsfParams::standard());
        // Flat ground at x=5,y=5 -> cloth height is 0.
        let c = cloth.height_at(5.0, 5.0) as f64;
        assert!(c.abs() < 0.05, "cloth height {c}");
        // Up to 0.1 above the cloth is ground, 0.2 above is not.
        assert!(cloth.is_ground(5.0, 5.0, c + 0.05));
        assert!(!cloth.is_ground(5.0, 5.0, c + 0.2));
        // Down to 1.0 below the cloth is ground, 1.5 below is not.
        assert!(cloth.is_ground(5.0, 5.0, c - 0.9));
        assert!(!cloth.is_ground(5.0, 5.0, c - 1.5));
    }

    #[test]
    fn outlier_damage_is_local() {
        let (pts, truth, _) = scene_a();
        let cloth = run_cloth(&pts, CsfParams::standard());
        let pred = classify(&cloth, &pts);
        let mut near = 0;
        let mut far = 0;
        for (k, &(x, y, _)) in pts.iter().enumerate() {
            if truth[k] && !pred[k] {
                if (x - 10.13).hypot(y - 40.07) < 6.0 {
                    near += 1;
                } else {
                    far += 1;
                }
            }
        }
        eprintln!("lost ground points: near outlier {near}, elsewhere {far}");
        assert!(far < 300, "far {far}");
    }

    #[test]
    fn steep_preset_on_slopes() {
        for (angle, frac) in [
            (0.0, 0.1),
            (30.0, 0.1),
            (45.0, 0.1),
            (30.0, 0.02),
            (45.0, 0.02),
            (45.0, 0.005),
        ] {
            let (pts, truth) = scene_ramp(angle, frac);
            let std = classify(&run_cloth(&pts, CsfParams::standard()), &pts);
            let steep = classify(&run_cloth(&pts, CsfParams::steep()), &pts);
            let (r_std, p_std) = recall_precision(&std, &truth);
            let (r_steep, p_steep) = recall_precision(&steep, &truth);
            eprintln!(
                "ramp {angle} deg, ground fraction {frac}: standard recall {r_std:.4} prec {p_std:.4}; steep recall {r_steep:.4} prec {p_steep:.4}"
            );
            // Measured on these synthetic scenes (see TaskSheets/G1-T3-csf-core.md): with a heavy
            // canopy (10 % ground returns) on a 30/45 degree slope the steep preset is clearly
            // more precise (0.29 vs 0.14 and 0.18 vs 0.11) with about the same recall. With a
            // light canopy (30 %) it is NOT better (the standard preset wins), so this is the only
            // advantage asserted.
            if angle >= 30.0 && frac == 0.1 {
                assert!(
                    p_steep > p_std + 0.03,
                    "{angle}: steep {p_steep} std {p_std}"
                );
                assert!(
                    r_steep > r_std - 0.05,
                    "{angle}: steep {r_steep} std {r_std}"
                );
            }
        }
    }

    #[test]
    fn deterministic() {
        let (pts, _, _) = scene_a();
        let a = classify(&run_cloth(&pts, CsfParams::standard()), &pts);
        let b = classify(&run_cloth(&pts, CsfParams::standard()), &pts);
        assert_eq!(a, b);
        // Point order must not matter either.
        let mut rev = pts.clone();
        rev.reverse();
        let c = classify(&run_cloth(&rev, CsfParams::standard()), &pts);
        assert_eq!(a, c);
    }

    #[test]
    fn batches_equal_one_call() {
        let (pts, _, _) = scene_a();
        let one = run_cloth(&pts, CsfParams::standard());
        let mut cloth = Cloth::new(extent_of(&pts), CsfParams::standard(), 10_000_000).unwrap();
        for &(x, y, z) in &pts {
            cloth.add_point_for_ihv(x, y, z);
        }
        cloth.finish_ihv().unwrap();
        let mut calls = 0;
        loop {
            let p = cloth.step(7).unwrap();
            calls += 1;
            if p.finished {
                assert_eq!(p.iterations_done, one.iterations_done);
                break;
            }
            assert!(calls < 1000);
        }
        assert!(calls > 1);
        assert_eq!(cloth.h, one.h);
        assert_eq!(cloth.movable, one.movable);
    }

    #[test]
    fn cap_refusal() {
        let e = XyExtent {
            min_x: 0.0,
            min_y: 0.0,
            max_x: 1000.0,
            max_y: 1000.0,
        };
        let err = Cloth::new(e, CsfParams::standard(), 1_000_000)
            .err()
            .unwrap();
        assert!(err.contains("解像度"), "{err}");
        assert!(err.contains("範囲"), "{err}");
        // Just under the cap is accepted: (2000 + 1 + 4)^2 particles.
        assert!(Cloth::new(e, CsfParams::standard(), 4_100_000).is_ok());
    }

    #[test]
    fn validation_and_phase_errors() {
        let mut p = CsfParams::standard();
        p.rigidness = 0;
        assert!(p.validate().is_err());
        let mut p = CsfParams::standard();
        p.cloth_resolution = f64::NAN;
        assert!(p.validate().is_err());
        assert!(CsfParams::standard().validate().is_ok());
        assert!(CsfParams::steep().validate().is_ok());
        let e = XyExtent {
            min_x: 0.0,
            min_y: 0.0,
            max_x: 10.0,
            max_y: 10.0,
        };
        let mut cloth = Cloth::new(e, CsfParams::standard(), 1_000_000).unwrap();
        assert!(cloth.step(1).is_err());
        assert!(cloth.finish_ihv().is_err()); // no points
    }

    #[test]
    fn memory_is_proportional_to_particles_not_points() {
        let e = XyExtent {
            min_x: 0.0,
            min_y: 0.0,
            max_x: 100.0,
            max_y: 100.0,
        };
        let mut cloth = Cloth::new(e, CsfParams::standard(), 10_000_000).unwrap();
        let before = cloth.memory_bytes();
        for k in 0..200_000 {
            cloth.add_point_for_ihv((k % 100) as f64, (k / 2000) as f64, 1.0);
        }
        assert_eq!(cloth.memory_bytes(), before);
        assert_eq!(before, cloth.particle_count() * 17);
    }

    /// Timing on a synthetic 1000x1000-particle cloth. Run with
    /// `cargo test -p pcv-core --release csf::tests::timing -- --ignored --nocapture`.
    /// `Instant` is used only in this test (not compiled into the library).
    #[test]
    #[ignore]
    #[allow(clippy::disallowed_methods)] // native-only test; never compiled into the library
    fn timing() {
        let e = XyExtent {
            min_x: 0.0,
            min_y: 0.0,
            max_x: 497.5,
            max_y: 497.5,
        }; // 497.5 / 0.5 = 995 cells + 1 + 4 margin = 1000 per side
        for threshold in [0.005f32, 0.0] {
            let params = CsfParams {
                convergence_threshold: threshold,
                ..CsfParams::standard()
            };
            let mut cloth = Cloth::new(e, params, 10_000_000).unwrap();
            let (nx, ny) = cloth.grid_size();
            eprintln!("grid {nx} x {ny}");
            let mut rng = Lcg(7);
            let t0 = std::time::Instant::now();
            for iy in 0..1000 {
                for ix in 0..1000 {
                    let z = 5.0 * ((ix as f64) * 0.02).sin() + rng.next_f64() * 0.1;
                    cloth.add_point_for_ihv(ix as f64 * 0.4975, iy as f64 * 0.4975, z);
                }
            }
            cloth.finish_ihv().unwrap();
            let t1 = t0.elapsed();
            let p = cloth.step(u32::MAX).unwrap();
            let t2 = t0.elapsed();
            eprintln!(
            "timing (convergence threshold {threshold}): ihv {t1:?}, simulation {:?} for {} iterations (converged {})",
            t2 - t1,
            p.iterations_done,
            p.converged
        );
        }
    }
}
