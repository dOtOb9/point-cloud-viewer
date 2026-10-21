//! G2-1: the points of a cross-section layer as 2D `(s, z)` points, for the section panel.
//!
//! A cross section (the tool "断面") is a COPC layer that holds a thin vertical slab of a bigger cloud.
//! The panel draws that slab seen from the side: the horizontal axis `s` is the distance from the
//! section's point A along A->B (measured in the horizontal plane), the vertical axis `z` is the height
//! along the view's `up` axis. Both are in the file's unit.
//!
//! # What is returned
//!
//! One byte buffer (little endian), built for direct use by the browser:
//!
//! ```text
//! header, 24 bytes   u32 count | u32 flags | f32 s_min | f32 s_max | f32 z_min | f32 z_max
//! then count * 12    f32 s | f32 z | u8 r | u8 g | u8 b | u8 classification
//! ```
//!
//! `flags` bit 0 = the points were thinned (the layer has more points than were returned),
//! bit 1 = the cloud has colour (r, g, b are real; otherwise they are 0 and the caller colours by the
//! classification byte). The ranges are those of the returned points. The header is 24 bytes so the
//! records start 4-byte aligned and the browser can view them as `Float32Array` / `Uint32Array`.
//!
//! # Memory does not grow with the point count
//!
//! The result never has more than `cap` points (default 2,000,000, i.e. 24 MB). Nodes are read one at a
//! time (`CopcFile::read_node_points`), so only one node plus the result is in memory.
//!
//! - If the layer has at most `cap` points, every point is kept.
//! - Otherwise points go into a fixed `(s, z)` grid of at most `cap` cells and each cell keeps the
//!   FIRST point that fell into it. The grid is sized from the layer's bounding box, so it is as fine as
//!   `cap` cells allow. The number of kept points is at most the number of cells, so it can never exceed
//!   `cap`: a second "stride" pass is not needed (the plan's "then stride if still over" cannot happen with
//!   this grid). Dense areas lose points, sparse areas keep all of theirs.
//!
//! This file does not use `std::time` (it is used from the browser build too).

use std::io::{Read, Seek};

use crate::{CopcError, CopcFile, NodeKey};

/// Default maximum number of returned points.
pub const DEFAULT_PROFILE_CAP: usize = 2_000_000;
/// Size of the header in bytes.
pub const PROFILE_HEADER_BYTES: usize = 24;
/// Size of one record in bytes.
pub const PROFILE_RECORD_BYTES: usize = 12;
/// `flags` bit: the points were thinned.
pub const PROFILE_FLAG_THINNED: u32 = 1;
/// `flags` bit: r, g, b are real colours.
pub const PROFILE_FLAG_COLOR: u32 = 2;

#[derive(Debug, thiserror::Error)]
pub enum ProfileError {
    #[error("断面の向きを決められません: {0}")]
    InvalidSection(String),
    #[error("断面の点を読めませんでした: {0}")]
    Read(#[from] CopcError),
}

/// The section line as the section tool defines it (file coordinates). Comes from the frontend as JSON.
#[derive(Debug, Clone, Copy, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SectionLine {
    pub a: [f64; 3],
    pub b: [f64; 3],
    /// Direction of "up" in the view that picked the points (need not be unit length).
    pub up: [f64; 3],
}

/// The two axes of the section: `along` (horizontal unit vector from A towards B) and `up` (unit).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SectionAxes {
    origin: [f64; 3],
    along: [f64; 3],
    up: [f64; 3],
}

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

impl SectionAxes {
    /// Same construction as `sectionBox` in `src/state/tool-math.ts`: `along` is A->B with its `up` part removed.
    pub fn new(line: &SectionLine) -> Result<Self, ProfileError> {
        let mut all = line.a.iter().chain(&line.b).chain(&line.up);
        if all.any(|v| !v.is_finite()) {
            return Err(ProfileError::InvalidSection(
                "有限でない値があります".to_string(),
            ));
        }
        let up_len = dot(line.up, line.up).sqrt();
        if up_len <= 1e-12 {
            return Err(ProfileError::InvalidSection(
                "上方向の長さが0です".to_string(),
            ));
        }
        let up = [
            line.up[0] / up_len,
            line.up[1] / up_len,
            line.up[2] / up_len,
        ];
        let ab = [
            line.b[0] - line.a[0],
            line.b[1] - line.a[1],
            line.b[2] - line.a[2],
        ];
        let ab_up = dot(ab, up);
        let horizontal = [
            ab[0] - up[0] * ab_up,
            ab[1] - up[1] * ab_up,
            ab[2] - up[2] * ab_up,
        ];
        let length = dot(horizontal, horizontal).sqrt();
        if length <= 1e-9 {
            return Err(ProfileError::InvalidSection(
                "2点が同じ鉛直線上にあります".to_string(),
            ));
        }
        let along = [
            horizontal[0] / length,
            horizontal[1] / length,
            horizontal[2] / length,
        ];
        Ok(Self {
            origin: line.a,
            along,
            up,
        })
    }

    /// Horizontal unit vector from A towards B.
    pub(crate) fn along(&self) -> [f64; 3] {
        self.along
    }

    /// Unit vector of the height axis.
    pub(crate) fn up(&self) -> [f64; 3] {
        self.up
    }

    /// `(s, z)` of a point: `s` = horizontal distance from A along A->B (negative behind A), `z` = height along `up`.
    pub fn project(&self, p: [f64; 3]) -> (f64, f64) {
        let d = [
            p[0] - self.origin[0],
            p[1] - self.origin[1],
            p[2] - self.origin[2],
        ];
        (dot(d, self.along), dot(p, self.up))
    }

    /// Ranges of `s` and `z` over the 8 corners of an axis-aligned box.
    pub(crate) fn ranges_of_box(&self, min: [f64; 3], max: [f64; 3]) -> ((f64, f64), (f64, f64)) {
        let mut s_range = (f64::INFINITY, f64::NEG_INFINITY);
        let mut z_range = (f64::INFINITY, f64::NEG_INFINITY);
        for i in 0..8 {
            let corner = [
                if i & 1 == 0 { min[0] } else { max[0] },
                if i & 2 == 0 { min[1] } else { max[1] },
                if i & 4 == 0 { min[2] } else { max[2] },
            ];
            let (s, z) = self.project(corner);
            s_range = (s_range.0.min(s), s_range.1.max(s));
            z_range = (z_range.0.min(z), z_range.1.max(z));
        }
        (s_range, z_range)
    }
}

/// One output point.
#[derive(Debug, Clone, Copy)]
struct ProfilePoint {
    s: f32,
    z: f32,
    rgbc: [u8; 4],
}

/// An empty grid cell has a NaN `s`.
const EMPTY_CELL: ProfilePoint = ProfilePoint {
    s: f32::NAN,
    z: 0.0,
    rgbc: [0; 4],
};

/// Grid size `(width, height)` with `width * height <= cells`, cells roughly square in `(s, z)` units.
fn grid_dims(s_span: f64, z_span: f64, cells: usize) -> (usize, usize) {
    let s_span = s_span.max(1e-9);
    let z_span = z_span.max(1e-9);
    let side = (s_span * z_span / cells as f64).sqrt();
    let clamp = |n: f64| (n.floor().max(1.0) as usize).min(cells);
    let height = clamp(z_span / side);
    // The width is limited by what is left, so that the product never exceeds `cells` even when
    // `height` was raised to 1 or one span is tiny.
    let width = clamp(s_span / side).min((cells / height).max(1));
    (width, height)
}

/// Where the kept points go: a plain list, or the fixed grid.
enum Sink {
    All(Vec<ProfilePoint>),
    Grid {
        cells: Vec<ProfilePoint>,
        width: usize,
        height: usize,
        s_min: f64,
        z_min: f64,
        s_span: f64,
        z_span: f64,
    },
}

impl Sink {
    fn add(&mut self, s: f64, z: f64, rgbc: [u8; 4]) {
        let point = ProfilePoint {
            s: s as f32,
            z: z as f32,
            rgbc,
        };
        match self {
            Sink::All(points) => points.push(point),
            Sink::Grid {
                cells,
                width,
                height,
                s_min,
                z_min,
                s_span,
                z_span,
            } => {
                let fx = ((s - *s_min) / *s_span * *width as f64).floor();
                let fy = ((z - *z_min) / *z_span * *height as f64).floor();
                // Clamp: the last edge belongs to the last cell, and rounding may push slightly outside.
                let ix = (fx.max(0.0) as usize).min(*width - 1);
                let iy = (fy.max(0.0) as usize).min(*height - 1);
                let cell = &mut cells[iy * *width + ix];
                if cell.s.is_nan() {
                    *cell = point;
                }
            }
        }
    }

    fn into_points(self) -> Vec<ProfilePoint> {
        match self {
            Sink::All(points) => points,
            Sink::Grid { cells, .. } => cells.into_iter().filter(|c| !c.s.is_nan()).collect(),
        }
    }
}

/// Read every node of `file` and return the section buffer described in the module docs.
/// `cap` is the largest number of points returned (0 means `DEFAULT_PROFILE_CAP`).
pub fn read_section_profile<R: Read + Seek + Send>(
    file: &mut CopcFile<R>,
    line: &SectionLine,
    cap: usize,
) -> Result<Vec<u8>, ProfileError> {
    let cap = if cap == 0 { DEFAULT_PROFILE_CAP } else { cap };
    let axes = SectionAxes::new(line)?;
    let info = file.info();
    let has_color = info.has_color;
    let (min, max) = (info.min, info.max);
    let keys: Vec<NodeKey> = file.hierarchy().nodes().map(|n| n.key).collect();
    let total: u64 = file
        .hierarchy()
        .nodes()
        .map(|n| u64::from(n.point_count))
        .sum();

    let thinned = total > cap as u64;
    let mut sink = if thinned {
        let ((s_lo, s_hi), (z_lo, z_hi)) = axes.ranges_of_box(min, max);
        let (s_span, z_span) = ((s_hi - s_lo).max(1e-9), (z_hi - z_lo).max(1e-9));
        let (width, height) = grid_dims(s_span, z_span, cap);
        Sink::Grid {
            cells: vec![EMPTY_CELL; width * height],
            width,
            height,
            s_min: s_lo,
            z_min: z_lo,
            s_span,
            z_span,
        }
    } else {
        Sink::All(Vec::with_capacity(total as usize))
    };

    for key in keys {
        // The node's points are dropped at the end of each iteration.
        for p in file.read_node_points(key)? {
            let (s, z) = axes.project([p.x, p.y, p.z]);
            if !s.is_finite() || !z.is_finite() {
                continue;
            }
            let rgb = p.color.unwrap_or([0, 0, 0, 255]);
            sink.add(s, z, [rgb[0], rgb[1], rgb[2], p.classification]);
        }
    }
    Ok(encode(&sink.into_points(), thinned, has_color))
}

fn encode(points: &[ProfilePoint], thinned: bool, has_color: bool) -> Vec<u8> {
    let mut s_range = (f32::INFINITY, f32::NEG_INFINITY);
    let mut z_range = (f32::INFINITY, f32::NEG_INFINITY);
    for p in points {
        s_range = (s_range.0.min(p.s), s_range.1.max(p.s));
        z_range = (z_range.0.min(p.z), z_range.1.max(p.z));
    }
    if points.is_empty() {
        s_range = (0.0, 0.0);
        z_range = (0.0, 0.0);
    }
    let mut flags = 0u32;
    if thinned {
        flags |= PROFILE_FLAG_THINNED;
    }
    if has_color {
        flags |= PROFILE_FLAG_COLOR;
    }
    let mut out = Vec::with_capacity(PROFILE_HEADER_BYTES + points.len() * PROFILE_RECORD_BYTES);
    out.extend_from_slice(&(points.len() as u32).to_le_bytes());
    out.extend_from_slice(&flags.to_le_bytes());
    for v in [s_range.0, s_range.1, z_range.0, z_range.1] {
        out.extend_from_slice(&v.to_le_bytes());
    }
    for p in points {
        out.extend_from_slice(&p.s.to_le_bytes());
        out.extend_from_slice(&p.z.to_le_bytes());
        out.extend_from_slice(&p.rgbc);
    }
    out
}

#[cfg(test)]
mod tests;
