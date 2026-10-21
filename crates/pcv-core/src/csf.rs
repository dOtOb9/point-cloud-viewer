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

// Constants below were checked against the reference source (jianboqi/CSF master, src/CSF.cpp,
// Particle.h, Particle.cpp, Cloth.cpp, Rasterization.cpp) on 2026-10-21.

/// Gravity and Verlet damping (paper section 2.2, Eq. 1-2). In the reference the acceleration is
/// `-GRAVITY * time_step^2` (CSF.cpp `addForce`) and Verlet multiplies it by `time_step^2` again
/// (Particle.cpp), so one step falls `GRAVITY * time_step^4`. We do the same.
const GRAVITY: f32 = 0.2;
const DAMPING: f32 = 0.01;
/// Particles of margin added around the point extent on every side (reference `clothbuffer_d`).
const MARGIN_CELLS: usize = 2;
/// The cloth starts this far above the highest inverted point (reference `cloth_y_height`).
const START_ABOVE_TOP: f32 = 0.05;
/// Slope post-processing only looks at groups of connected movable particles larger than this
/// (reference `MAX_PARTICLE_FOR_POSTPROCESSIN`).
const MIN_GROUP_FOR_POST: usize = 50;
/// `active` is rebuilt at most once per this many steps, and only if some particle was fixed.
const REBUILD_INTERVAL: u32 = 8;
/// The reference passes 9999 as `heightThreshold` to the slope post-processing (CSF.cpp), so that
/// check never rejects anything. Kept as a constant to stay faithful; `hdiff` is the reference's
/// `smoothThreshold` (0.3).
const SLOPE_HEIGHT_THRESHOLD: f32 = 9999.0;

/// Constraint neighbours as (dx, dy), in the order of the reference neighbour lists. The reference
/// builds constraints in loops with x outer and y inner, immediate ones (distance 1) first and the
/// secondary ones (distance 2) after; each constraint goes into both particles' lists. For a
/// particle the resulting order is this fixed table (neighbours outside the grid are skipped).
const NEIGHBOURS: [(i32, i32); 16] = [
    (-1, -1),
    (-1, 0),
    (-1, 1),
    (0, -1),
    (1, -1),
    (1, 0),
    (0, 1),
    (1, 1),
    (-2, -2),
    (-2, 0),
    (-2, 2),
    (0, -2),
    (2, -2),
    (2, 0),
    (0, 2),
    (2, 2),
];

/// Reference `singleMove1` / `doubleMove1` (Particle.h), indexed by `rigidness`; from index 15 the
/// values are 1 and 0.5. They are the closed form of applying the 0.3 move `rigidness` times.
const SINGLE_MOVE: [f32; 15] = [
    0.0, 0.3, 0.51, 0.657, 0.7599, 0.83193, 0.88235, 0.91765, 0.94235, 0.95965, 0.97175, 0.98023,
    0.98616, 0.99031, 0.99322,
];
const DOUBLE_MOVE: [f32; 15] = [
    0.0, 0.3, 0.42, 0.468, 0.4872, 0.4949, 0.498, 0.4992, 0.4997, 0.4999, 0.4999, 0.5, 0.5, 0.5,
    0.5,
];

/// Parameters of the filter. Distances are in the units of the point coordinates (metres).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CsfParams {
    /// Grid spacing of the cloth particles.
    pub cloth_resolution: f64,
    /// How stiff the cloth is (1, 2, 3, ...; larger = stiffer). In the paper (section 2.2) this is
    /// the number of constraint relaxations; in the reference implementation it selects the
    /// strength of one relaxation per step (`SINGLE_MOVE` / `DOUBLE_MOVE`).
    pub rigidness: u32,
    /// Verlet time step. One step of gravity falls `0.2 * time_step^4` (as in the reference).
    pub time_step: f32,
    /// A point at most this far above the cloth is ground (decided Q20: asymmetric).
    pub class_threshold_upper: f32,
    /// A point at most this far below the cloth is ground.
    pub class_threshold_lower: f32,
    /// Maximum number of simulation steps.
    pub iterations: u32,
    /// Enable the slope post-processing (paper section 2.4).
    pub slope_smooth: bool,
    /// Slope post-processing (reference `smoothThreshold`): a movable particle next to a fixed one
    /// is snapped to its own IHV only if the IHV difference to that neighbour is below this value.
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

    /// Owner's "steep terrain" preset: finer, softer cloth and more iterations (plan 2.2, 8.6).
    pub fn steep() -> Self {
        Self {
            cloth_resolution: 0.25,
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
    /// Indices (ascending) of the particles the simulation must visit: movable ones and fixed ones
    /// next to a movable one. May hold a few extra fixed particles between rebuilds.
    active: Vec<u32>,
    /// Particles fixed, and steps run, since `active` was last rebuilt.
    fixed_since_rebuild: usize,
    steps_since_rebuild: u32,
    /// Highest inverted height of all points seen (the cloth starts above it).
    max_inverted: f32,
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
        // Same size as the reference: floor(extent / resolution) + 2 * margin.
        let cells_x = ((extent.max_x - extent.min_x) / res).floor();
        let cells_y = ((extent.max_y - extent.min_y) / res).floor();
        // Compare in f64 first so a huge extent cannot overflow usize.
        let nx_f = cells_x + 2.0 * MARGIN_CELLS as f64;
        let ny_f = cells_y + 2.0 * MARGIN_CELLS as f64;
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
        if n > u32::MAX as usize {
            return Err("布の粒子数が多すぎます".to_string());
        }
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
            active: Vec::new(),
            fixed_since_rebuild: 0,
            steps_since_rebuild: 0,
            max_inverted: f32::NEG_INFINITY,
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
            + self.active.capacity() * 4
    }

    // ---- Pass 1: IHV ------------------------------------------------------------------------

    /// Feeds one point of the first pass. Non-finite points and calls after `finish_ihv` are ignored.
    ///
    /// As in the reference (Rasterization.cpp `RasterTerrian`), the point belongs to the particle
    /// nearest to it (`int(d / step + 0.5)`, clamped to the grid, so a point outside the cloth goes
    /// to the edge) and a particle keeps the nearest of its points in XY. The reference keeps the
    /// first point on an exact distance tie; we keep the higher inverted height instead, so the
    /// result does not depend on the order of the points (difference from the reference).
    pub fn add_point_for_ihv(&mut self, x: f64, y: f64, z: f64) {
        if self.phase != Phase::Collecting || !(x.is_finite() && y.is_finite() && z.is_finite()) {
            return;
        }
        self.points_seen += 1;
        let res = self.params.cloth_resolution;
        let fx = (x - self.origin_x) / res;
        let fy = (y - self.origin_y) / res;
        let i = ((fx + 0.5).max(0.0) as usize).min(self.nx - 1);
        let j = ((fy + 0.5).max(0.0) as usize).min(self.ny - 1);
        let inv = -(z as f32);
        self.max_inverted = self.max_inverted.max(inv);
        let ddx = (fx - i as f64) as f32;
        let ddy = (fy - j as f64) as f32;
        let d = ddx * ddx + ddy * ddy;
        let idx = j * self.nx + i;
        if d < self.ihv_dist[idx] || (d == self.ihv_dist[idx] && inv > self.ihv[idx]) {
            self.ihv_dist[idx] = d;
            self.ihv[idx] = inv;
        }
    }

    /// Ends pass 1: fills particles that have no point and puts the cloth at its start height.
    ///
    /// Fill (reference `findHeightValByScanline`): an empty particle takes the value of the first
    /// particle with a point found by scanning to the right along its row, then to the left, then
    /// towards smaller rows in its column, then towards larger rows. Note this is the first one
    /// found in that direction order, not the nearest. If the whole row and column are empty, a
    /// breadth-first search over the 16 constraint neighbours finds the closest one
    /// (`findHeightValByNeighbor`).
    pub fn finish_ihv(&mut self) -> Result<(), String> {
        if self.phase != Phase::Collecting {
            return Err("IHV はすでに確定しています".to_string());
        }
        if self.points_seen == 0 {
            return Err("布の範囲に点が 1 つもありません".to_string());
        }
        let (nx, ny) = (self.nx, self.ny);
        // `ihv_dist` stays finite only where a point exists, so it is the "has a point" flag even
        // after `ihv` of empty particles has been filled in below.
        let has_point = |dist: &[f32], idx: usize| dist[idx].is_finite();
        let mut bfs_seen: Vec<bool> = Vec::new(); // allocated only if a BFS is needed
        for j in 0..ny {
            for i in 0..nx {
                let p = j * nx + i;
                if has_point(&self.ihv_dist, p) {
                    continue;
                }
                let mut found = None;
                for ii in i + 1..nx {
                    if has_point(&self.ihv_dist, j * nx + ii) {
                        found = Some(j * nx + ii);
                        break;
                    }
                }
                if found.is_none() {
                    for ii in (0..i).rev() {
                        if has_point(&self.ihv_dist, j * nx + ii) {
                            found = Some(j * nx + ii);
                            break;
                        }
                    }
                }
                if found.is_none() {
                    for jj in (0..j).rev() {
                        if has_point(&self.ihv_dist, jj * nx + i) {
                            found = Some(jj * nx + i);
                            break;
                        }
                    }
                }
                if found.is_none() {
                    for jj in j + 1..ny {
                        if has_point(&self.ihv_dist, jj * nx + i) {
                            found = Some(jj * nx + i);
                            break;
                        }
                    }
                }
                if found.is_none() {
                    if bfs_seen.is_empty() {
                        bfs_seen = vec![false; nx * ny];
                    }
                    found = self.nearest_point_by_neighbours(p, &mut bfs_seen);
                }
                let Some(src) = found else {
                    return Err("布の範囲に点が 1 つもありません".to_string());
                };
                self.ihv[p] = self.ihv[src];
            }
        }
        self.ihv_dist = Vec::new();
        // The cloth starts a little above the highest inverted point (reference CSF.cpp).
        let start = self.max_inverted + START_ABOVE_TOP;
        self.h.iter_mut().for_each(|v| *v = start);
        self.prev.copy_from_slice(&self.h);
        self.active = (0..nx * ny).map(|p| p as u32).collect();
        self.phase = Phase::Simulating;
        Ok(())
    }

    /// Breadth-first search from `start` over the 16 constraint neighbours for the first particle
    /// that has a point (reference `findHeightValByNeighbor`). `seen` is all-false on entry and is
    /// cleaned again before returning.
    fn nearest_point_by_neighbours(&self, start: usize, seen: &mut [bool]) -> Option<usize> {
        let mut queue = vec![start];
        seen[start] = true;
        let mut head = 0;
        let mut result = None;
        while head < queue.len() {
            let c = queue[head];
            head += 1;
            if c != start && self.ihv_dist[c].is_finite() {
                result = Some(c);
                break;
            }
            for q in self.neighbours(c) {
                if !seen[q] {
                    seen[q] = true;
                    queue.push(q);
                }
            }
        }
        for &c in &queue {
            seen[c] = false;
        }
        result
    }

    /// The constraint neighbours of particle `p` that lie inside the grid, in reference order.
    fn neighbours(&self, p: usize) -> impl Iterator<Item = usize> + '_ {
        let (nx, ny) = (self.nx as i64, self.ny as i64);
        let (i, j) = ((p % self.nx) as i64, (p / self.nx) as i64);
        NEIGHBOURS.iter().filter_map(move |&(dx, dy)| {
            let (a, b) = (i + dx as i64, j + dy as i64);
            (a >= 0 && a < nx && b >= 0 && b < ny).then(|| (b * nx + a) as usize)
        })
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
    ///
    /// Only particles in `active` are visited; the others are fixed and have only fixed
    /// neighbours, so the original full pass would not have changed anything for them.
    fn one_step(&mut self) -> f32 {
        let dt2 = self.params.time_step * self.params.time_step;
        // Inverted coordinates: gravity pulls the cloth towards smaller values. The reference's
        // acceleration is already scaled by dt^2 and Verlet scales it by dt^2 again.
        let fall = -GRAVITY * dt2 * dt2;
        for &k in &self.active {
            let k = k as usize;
            if self.movable[k] {
                let cur = self.h[k];
                self.h[k] = cur + (cur - self.prev[k]) * (1.0 - DAMPING) + fall;
                self.prev[k] = cur;
            }
        }
        self.satisfy_constraints();
        // Largest move of a movable particle, then collision: a particle that went below the
        // terrain is put on it and fixed. One loop is enough because the collision of a particle
        // only changes that particle.
        let mut max_diff = 0.0f32;
        let mut newly_fixed = 0usize;
        for &k in &self.active {
            let k = k as usize;
            if self.movable[k] {
                max_diff = max_diff.max((self.h[k] - self.prev[k]).abs());
                if self.h[k] < self.ihv[k] {
                    self.h[k] = self.ihv[k];
                    self.movable[k] = false;
                    newly_fixed += 1;
                }
            }
        }
        // A stale list is still correct (it only holds extra particles), so shrink it only when
        // something changed and a few steps have passed, so rebuilds stay cheap.
        self.fixed_since_rebuild += newly_fixed;
        self.steps_since_rebuild += 1;
        if self.fixed_since_rebuild > 0 && self.steps_since_rebuild >= REBUILD_INTERVAL {
            self.rebuild_active();
        }
        max_diff
    }

    /// Drops from `active` the particles that are fixed and have no movable neighbour. Keeps the
    /// index order, which the constraint pass depends on.
    fn rebuild_active(&mut self) {
        let mut active = std::mem::take(&mut self.active);
        active.retain(|&p| {
            let p = p as usize;
            self.movable[p] || self.neighbours(p).any(|q| self.movable[q])
        });
        self.active = active;
        self.fixed_since_rebuild = 0;
        self.steps_since_rebuild = 0;
    }

    /// Internal force (paper section 2.2, Eq. 3; reference `satisfyConstraintSelf`): each particle
    /// is pulled towards the height of its up to 16 neighbours, once per step. Two movable
    /// particles move `DOUBLE_MOVE[rigidness]` of the height difference each; if only one is
    /// movable it moves `SINGLE_MOVE[rigidness]` of it. Particles are visited in index order and
    /// updated in place, each pair from both sides, as in the reference (single-threaded).
    /// A pair of two fixed particles changes nothing, so particles that are fixed and have only
    /// fixed neighbours are not in `active` and are skipped.
    fn satisfy_constraints(&mut self) {
        let r = self.params.rigidness as usize;
        let single = SINGLE_MOVE.get(r).copied().unwrap_or(1.0);
        let double = DOUBLE_MOVE.get(r).copied().unwrap_or(0.5);
        let (nx, ny) = (self.nx, self.ny);
        // Index offsets of the 16 neighbours, same order as `NEIGHBOURS`.
        let offsets: [isize; 16] =
            NEIGHBOURS.map(|(dx, dy)| dy as isize * nx as isize + dx as isize);
        let h = &mut self.h[..];
        let movable = &self.movable[..];
        for &p in &self.active {
            let p = p as usize;
            let (i, j) = (p % nx, p / nx);
            let p_movable = movable[p];
            let mut hp = h[p];
            let interior = i >= 2 && i + 2 < nx && j >= 2 && j + 2 < ny;
            for (k, &(dx, dy)) in NEIGHBOURS.iter().enumerate() {
                let q = if interior {
                    (p as isize + offsets[k]) as usize
                } else {
                    let (a, b) = (i as i64 + dx as i64, j as i64 + dy as i64);
                    if a < 0 || a >= nx as i64 || b < 0 || b >= ny as i64 {
                        continue;
                    }
                    b as usize * nx + a as usize
                };
                // Written as selects so the compiler can avoid unpredictable branches. A fixed
                // particle's value is kept as it is (adding 0.0 could turn -0.0 into +0.0).
                let q_movable = movable[q];
                let hq = h[q];
                let diff = hq - hp;
                let amount = diff
                    * if p_movable && q_movable {
                        double
                    } else {
                        single
                    };
                if p_movable {
                    hp += amount;
                }
                if q_movable {
                    h[q] = hq - amount;
                }
            }
            h[p] = hp;
        }
    }

    /// Slope post-processing (paper section 2.4; reference `movableFilter`, `findUnmovablePoint`,
    /// `handle_slop_connected`). Groups of 4-connected movable particles with more than
    /// `MIN_GROUP_FOR_POST` members are processed: a member next to a fixed particle whose IHV
    /// differs by less than `hdiff` is snapped to its IHV and fixed, and that spreads breadth-first
    /// to the movable neighbours with a similar IHV. Groups are found scanning columns first
    /// (x outer, y inner) and neighbours are visited in the order left, right, y-1, y+1, because
    /// the result depends on that order.
    fn slope_post_process(&mut self) {
        let (nx, ny) = (self.nx, self.ny);
        let hdiff = self.params.hdiff;
        // `visited`: movable particles already put in a group. A neighbour that is visited is in
        // the same group as the particle next to it, so it also serves as the group membership test
        // that the reference keeps in its `neibors` lists.
        let mut visited = vec![false; nx * ny];
        let mut queued = vec![false; nx * ny];
        for x in 0..nx {
            for y in 0..ny {
                let start = y * nx + x;
                if !self.movable[start] || visited[start] {
                    continue;
                }
                // Group search; `group` is also the BFS queue.
                let mut group = vec![start];
                visited[start] = true;
                let mut head = 0;
                while head < group.len() {
                    let c = group[head];
                    head += 1;
                    for q in self.axis_neighbours(c).into_iter().flatten() {
                        if self.movable[q] && !visited[q] {
                            visited[q] = true;
                            group.push(q);
                        }
                    }
                }
                if group.len() <= MIN_GROUP_FOR_POST {
                    continue;
                }
                // findUnmovablePoint: seeds, in group order. Particles snapped earlier in this loop
                // already count as fixed for the later ones.
                let mut seeds: Vec<usize> = Vec::new();
                for &c in &group {
                    let hit = self.axis_neighbours(c).into_iter().flatten().any(|q| {
                        !self.movable[q]
                            && (self.ihv[c] - self.ihv[q]).abs() < hdiff
                            && self.h[c] - self.ihv[c] < SLOPE_HEIGHT_THRESHOLD
                    });
                    if hit {
                        self.h[c] = self.ihv[c];
                        self.movable[c] = false;
                        seeds.push(c);
                    }
                }
                // handle_slop_connected: spread from the seeds through the group.
                let mut queue = seeds;
                for &c in &queue {
                    queued[c] = true;
                }
                let mut head = 0;
                while head < queue.len() {
                    let c = queue[head];
                    head += 1;
                    for q in self.axis_neighbours(c).into_iter().flatten() {
                        if visited[q]
                            && (self.ihv[c] - self.ihv[q]).abs() < hdiff
                            && (self.h[q] - self.ihv[q]).abs() < SLOPE_HEIGHT_THRESHOLD
                        {
                            self.h[q] = self.ihv[q];
                            self.movable[q] = false;
                            if !queued[q] {
                                queued[q] = true;
                                queue.push(q);
                            }
                        }
                    }
                }
                for &c in &queue {
                    queued[c] = false;
                }
            }
        }
    }

    /// The 4-neighbours of `p` in the reference order: left, right, y-1, y+1 (None outside).
    fn axis_neighbours(&self, p: usize) -> [Option<usize>; 4] {
        let (i, j) = (p % self.nx, p / self.nx);
        [
            (i > 0).then(|| p - 1),
            (i + 1 < self.nx).then(|| p + 1),
            (j > 0).then(|| p - self.nx),
            (j + 1 < self.ny).then(|| p + self.nx),
        ]
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
            (30.0, 0.3),
            (45.0, 0.3),
        ] {
            let (pts, truth) = scene_ramp(angle, frac);
            let std = classify(&run_cloth(&pts, CsfParams::standard()), &pts);
            let steep = classify(&run_cloth(&pts, CsfParams::steep()), &pts);
            let (r_std, p_std) = recall_precision(&std, &truth);
            let (r_steep, p_steep) = recall_precision(&steep, &truth);
            eprintln!(
                "ramp {angle} deg, ground fraction {frac}: standard recall {r_std:.4} prec {p_std:.4}; steep recall {r_steep:.4} prec {p_steep:.4}"
            );
            // Measured with the reference-matching implementation (see
            // TaskSheets/G1-T3-csf-core.md): with a heavy canopy (10 % ground returns) on a 30/45
            // degree slope the steep preset finds clearly more of the ground (recall +0.19 / +0.20)
            // at the same precision. At other settings the difference is not consistent, so only
            // this case is asserted (margins: recall at least +0.1, precision not worse by 0.05).
            if angle >= 30.0 && frac == 0.1 {
                assert!(
                    r_steep > r_std + 0.1,
                    "{angle}: steep {r_steep} std {r_std}"
                );
                assert!(
                    p_steep > p_std - 0.05,
                    "{angle}: steep {p_steep} std {p_std}"
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
        // Just under the cap is accepted: (2000 + 4)^2 particles.
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

    /// The step function before the `active` list was added: every particle is visited, bounds
    /// are checked per neighbour. Kept only to prove the faster version gives the same bits.
    fn old_one_step(c: &mut Cloth) -> f32 {
        let dt2 = c.params.time_step * c.params.time_step;
        let fall = -GRAVITY * dt2 * dt2;
        for k in 0..c.h.len() {
            if c.movable[k] {
                let cur = c.h[k];
                c.h[k] = cur + (cur - c.prev[k]) * (1.0 - DAMPING) + fall;
                c.prev[k] = cur;
            }
        }
        let r = c.params.rigidness as usize;
        let single = SINGLE_MOVE.get(r).copied().unwrap_or(1.0);
        let double = DOUBLE_MOVE.get(r).copied().unwrap_or(0.5);
        let (nx, ny) = (c.nx as i64, c.ny as i64);
        for j in 0..ny {
            for i in 0..nx {
                let p = (j * nx + i) as usize;
                for &(dx, dy) in &NEIGHBOURS {
                    let (a, b) = (i + dx as i64, j + dy as i64);
                    if a < 0 || a >= nx || b < 0 || b >= ny {
                        continue;
                    }
                    let q = (b * nx + a) as usize;
                    let diff = c.h[q] - c.h[p];
                    match (c.movable[p], c.movable[q]) {
                        (true, true) => {
                            c.h[p] += diff * double;
                            c.h[q] -= diff * double;
                        }
                        (true, false) => c.h[p] += diff * single,
                        (false, true) => c.h[q] -= diff * single,
                        (false, false) => {}
                    }
                }
            }
        }
        let mut max_diff = 0.0f32;
        for k in 0..c.h.len() {
            if c.movable[k] {
                max_diff = max_diff.max((c.h[k] - c.prev[k]).abs());
            }
        }
        for k in 0..c.h.len() {
            if c.movable[k] && c.h[k] < c.ihv[k] {
                c.h[k] = c.ihv[k];
                c.movable[k] = false;
            }
        }
        max_diff
    }

    /// Same loop as `Cloth::step(u32::MAX)` but with `old_one_step`.
    fn old_run(c: &mut Cloth) -> u32 {
        while c.iterations_done < c.params.iterations {
            let max_diff = old_one_step(c);
            c.iterations_done += 1;
            if max_diff < c.params.convergence_threshold {
                break;
            }
        }
        if c.params.slope_smooth {
            c.slope_post_process();
        }
        c.iterations_done
    }

    fn assert_same_as_old(points: &[P], params: CsfParams) {
        let build = || {
            let mut c = Cloth::new(extent_of(points), params, 10_000_000).unwrap();
            for &(x, y, z) in points {
                c.add_point_for_ihv(x, y, z);
            }
            c.finish_ihv().unwrap();
            c
        };
        let mut old = build();
        let iterations = old_run(&mut old);
        let mut new = build();
        let progress = new.step(u32::MAX).unwrap();
        assert!(progress.finished);
        assert_eq!(progress.iterations_done, iterations);
        assert_eq!(old.movable, new.movable);
        let old_bits: Vec<u32> = old.h.iter().map(|v| v.to_bits()).collect();
        let new_bits: Vec<u32> = new.h.iter().map(|v| v.to_bits()).collect();
        assert!(old_bits == new_bits, "cloth heights differ");
        for &(x, y, z) in points.iter().step_by(7) {
            assert_eq!(old.is_ground(x, y, z), new.is_ground(x, y, z));
        }
    }

    #[test]
    fn same_bits_as_full_pass() {
        let (a, _, _) = scene_a();
        let (ramp30, _) = scene_ramp(30.0, 0.3);
        let (ramp45, _) = scene_ramp(45.0, 0.1);
        // Rough scene: random heights, so particles are fixed in a scattered order.
        let mut rng = Lcg(99);
        let rough: Vec<P> = (0..6000)
            .map(|_| {
                let (x, y) = (rng.next_f64() * 40.0, rng.next_f64() * 25.0);
                (x, y, rng.next_f64() * 6.0 - 3.0)
            })
            .collect();
        for points in [&a, &ramp30, &ramp45, &rough] {
            for params in [CsfParams::standard(), CsfParams::steep()] {
                assert_same_as_old(points, params);
                // Forced run to the iteration cap, other rigidness values and no slope smoothing.
                for rigidness in [1, 3, 15] {
                    assert_same_as_old(
                        points,
                        CsfParams {
                            convergence_threshold: 0.0,
                            iterations: 150,
                            rigidness,
                            slope_smooth: rigidness != 3,
                            ..params
                        },
                    );
                }
            }
        }
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
            max_x: 498.0,
            max_y: 498.0,
        }; // floor(498 / 0.5) = 996 cells + 4 margin = 1000 per side
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
                    cloth.add_point_for_ihv(ix as f64 * 0.498, iy as f64 * 0.498, z);
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
