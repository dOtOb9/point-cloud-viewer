//! G3-1: splitting a COPC cloud into XY tiles and reading it tile by tile.
//!
//! The thinning and outlier filters (G3) look at "nearby points". To keep memory
//! independent of the point count, they work on one XY tile at a time: the points of
//! the tile plus a margin around it are read, the filter decides which points to keep,
//! and only the points inside the tile (the core) are written out. The margin points
//! belong to the neighbouring tile and are written there. This file is the shared
//! "plan the tiles" and "read one tile" part (CSF tiling in G1-9 can reuse it).
//!
//! # Ownership rule
//!
//! A point is a core point of the tile whose core rectangle contains it with
//! half-open intervals `[min, max)` in both X and Y. The one exception is the outer
//! max edge of the whole extent, which is closed (`[min, max]`), so the points on the
//! far edge are not lost. Neighbouring tiles share the exact same `f64` boundary
//! value (it is computed once), so every point is core in exactly one tile.
//! Points outside the extent (the header bounds) are core nowhere; a valid COPC header
//! always contains its points.
//!
//! # Estimating a tile's point count
//!
//! Only the hierarchy is known before reading (every node's point count and cube).
//! The estimate for a tile is the sum over nodes of
//! `node.point_count * (XY overlap area of node and tile) / (XY area of node)`,
//! i.e. each node is assumed to be spread evenly over its XY footprint. It is an
//! estimate, not a bound: a node that is dense in one corner can put more points in a
//! tile than estimated. The reader reports the real count of every tile.
//!
//! # Planning
//!
//! 1. Start from a uniform grid whose cells hold about `cap / 2` points on average
//!    (average density = header point count / extent area).
//! 2. Any tile whose estimate exceeds `cap` is split in four (a quadtree), down to
//!    `min_tile_size`. A tile that cannot be split any more is kept as it is, so
//!    `cap` can be exceeded there (for example a very dense spot or a tiny size).
//!
//! # Reading and memory
//!
//! `TileReader` reads one tile (+ margin) at a time with `ExtractPoints` and an
//! axis-aligned box, and drops it before the next. `ExtractPoints` consumes its
//! reader, so the caller passes a function that opens a fresh `CopcReader` per tile
//! (re-reading the header and hierarchy, which is small). Coarse-level nodes cover a
//! wide area and are read again by every tile they overlap; the measured cost of this
//! is in `TaskSheets/G3-T4-tiles.md`.

use std::io::{Read, Seek};

use copc_core::LasPointRecord;
use copc_reader::CopcReader;

use crate::copc::voxel_bounds;
use crate::extract::{ExtractFilter, ExtractPoints, OrientedBox};

/// An axis-aligned rectangle in the XY plane (the file's real coordinates).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TileRect {
    pub min: [f64; 2],
    pub max: [f64; 2],
}

impl TileRect {
    fn area(&self) -> f64 {
        (self.max[0] - self.min[0]).max(0.0) * (self.max[1] - self.min[1]).max(0.0)
    }
}

/// The XY footprint of one hierarchy node and how many points it holds.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct NodeFootprint {
    pub rect: TileRect,
    pub point_count: u64,
}

/// One planned tile.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Tile {
    /// The core rectangle (the points this tile is responsible for).
    pub core: TileRect,
    /// Estimated number of points inside `core` (see the module comment).
    pub estimated_points: f64,
    /// The max X edge is the outer edge of the whole extent, so it is closed.
    closed_max_x: bool,
    /// Same for the max Y edge.
    closed_max_y: bool,
}

impl Tile {
    /// Whether the point belongs to this tile (the ownership rule in the module comment).
    pub fn owns(&self, x: f64, y: f64) -> bool {
        x >= self.core.min[0]
            && (x < self.core.max[0] || (self.closed_max_x && x == self.core.max[0]))
            && y >= self.core.min[1]
            && (y < self.core.max[1] || (self.closed_max_y && y == self.core.max[1]))
    }
}

/// Estimated number of points of `nodes` inside `rect`.
pub fn estimate_points(rect: &TileRect, nodes: &[NodeFootprint]) -> f64 {
    let mut sum = 0.0;
    for node in nodes {
        let w = node.rect.max[0].min(rect.max[0]) - node.rect.min[0].max(rect.min[0]);
        let h = node.rect.max[1].min(rect.max[1]) - node.rect.min[1].max(rect.min[1]);
        if w < 0.0 || h < 0.0 {
            continue;
        }
        let node_area = node.rect.area();
        let fraction = if node_area > 0.0 {
            (w * h / node_area).min(1.0)
        } else {
            // A node with no XY area sits on a line or a point that touches the tile.
            1.0
        };
        sum += node.point_count as f64 * fraction;
    }
    sum
}

/// Splits `extent` into tiles. Pure function (no files). `cap` is the target maximum
/// of estimated points per tile; `min_tile_size` is the smallest side a tile may be
/// split down to (in the file's units).
pub fn plan_tiles(
    extent: TileRect,
    nodes: &[NodeFootprint],
    total_points: u64,
    cap: u64,
    min_tile_size: f64,
) -> Result<Vec<Tile>, String> {
    let finite = extent
        .min
        .iter()
        .chain(extent.max.iter())
        .all(|v| v.is_finite());
    if !finite || extent.max[0] < extent.min[0] || extent.max[1] < extent.min[1] {
        return Err("タイルの範囲が不正です".to_string());
    }
    if cap == 0 {
        return Err("タイル1枚の点数の上限は1以上にしてください".to_string());
    }
    if !min_tile_size.is_finite() || min_tile_size < 0.0 {
        return Err("タイルの最小の大きさが不正です".to_string());
    }

    // Uniform grid: about cap / 2 points per cell on average.
    let width = extent.max[0] - extent.min[0];
    let height = extent.max[1] - extent.min[1];
    let wanted = ((total_points as f64) * 2.0 / cap as f64).ceil().max(1.0);
    let (nx, ny) = if width > 0.0 && height > 0.0 {
        let nx = (wanted * width / height).sqrt().ceil().max(1.0);
        let ny = (wanted / nx).ceil().max(1.0);
        (nx.min(4096.0) as usize, ny.min(4096.0) as usize)
    } else if width > 0.0 {
        (wanted.min(4096.0) as usize, 1)
    } else if height > 0.0 {
        (1, wanted.min(4096.0) as usize)
    } else {
        (1, 1)
    };

    // The minimum size also limits the starting grid.
    let cells_for = |len: f64, n: usize| -> usize {
        if min_tile_size > 0.0 && len > 0.0 {
            n.min(((len / min_tile_size).floor() as usize).max(1))
        } else {
            n
        }
    };
    let (nx, ny) = (cells_for(width, nx), cells_for(height, ny));

    // The same boundary value is used by both neighbours of an edge.
    let boundary = |lo: f64, hi: f64, i: usize, n: usize| -> f64 {
        if i == 0 {
            lo
        } else if i == n {
            hi
        } else {
            lo + (hi - lo) * (i as f64 / n as f64)
        }
    };

    // Work list; cells are pushed in reverse so that tiles come out in row-major order.
    let mut stack: Vec<(Tile, u32)> = Vec::new();
    for iy in (0..ny).rev() {
        for ix in (0..nx).rev() {
            let core = TileRect {
                min: [
                    boundary(extent.min[0], extent.max[0], ix, nx),
                    boundary(extent.min[1], extent.max[1], iy, ny),
                ],
                max: [
                    boundary(extent.min[0], extent.max[0], ix + 1, nx),
                    boundary(extent.min[1], extent.max[1], iy + 1, ny),
                ],
            };
            stack.push((
                Tile {
                    core,
                    estimated_points: 0.0,
                    closed_max_x: ix + 1 == nx,
                    closed_max_y: iy + 1 == ny,
                },
                0,
            ));
        }
    }

    // Quadtree splitting. Depth is limited so that float rounding can never loop forever.
    const MAX_DEPTH: u32 = 24;
    let mut tiles = Vec::new();
    while let Some((mut tile, depth)) = stack.pop() {
        tile.estimated_points = estimate_points(&tile.core, nodes);
        let w = tile.core.max[0] - tile.core.min[0];
        let h = tile.core.max[1] - tile.core.min[1];
        let split_x = w > 0.0 && w / 2.0 >= min_tile_size;
        let split_y = h > 0.0 && h / 2.0 >= min_tile_size;
        if tile.estimated_points <= cap as f64 || depth >= MAX_DEPTH || !(split_x || split_y) {
            tiles.push(tile);
            continue;
        }
        let mid_x = tile.core.min[0] + w / 2.0;
        let mid_y = tile.core.min[1] + h / 2.0;
        // Child ranges per axis: (min, max, closed max edge).
        let xs: Vec<(f64, f64, bool)> = if split_x {
            vec![
                (tile.core.min[0], mid_x, false),
                (mid_x, tile.core.max[0], tile.closed_max_x),
            ]
        } else {
            vec![(tile.core.min[0], tile.core.max[0], tile.closed_max_x)]
        };
        let ys: Vec<(f64, f64, bool)> = if split_y {
            vec![
                (tile.core.min[1], mid_y, false),
                (mid_y, tile.core.max[1], tile.closed_max_y),
            ]
        } else {
            vec![(tile.core.min[1], tile.core.max[1], tile.closed_max_y)]
        };
        for y in ys.iter().rev() {
            for x in xs.iter().rev() {
                stack.push((
                    Tile {
                        core: TileRect {
                            min: [x.0, y.0],
                            max: [x.1, y.1],
                        },
                        estimated_points: 0.0,
                        closed_max_x: x.2,
                        closed_max_y: y.2,
                    },
                    depth + 1,
                ));
            }
        }
    }
    Ok(tiles)
}

/// The XY extent the tiles cover: the header bounds, widened by one scale unit on every
/// side. A writer may compute the bounds from unrounded coordinates while the stored
/// coordinates are rounded to the scale, so a point can land just outside the header
/// bounds; without the padding it would be core in no tile and silently dropped.
fn header_extent(header: &copc_reader::LasHeader) -> TileRect {
    TileRect {
        min: [
            header.min_x - header.x_scale_factor.abs(),
            header.min_y - header.y_scale_factor.abs(),
        ],
        max: [
            header.max_x + header.x_scale_factor.abs(),
            header.max_y + header.y_scale_factor.abs(),
        ],
    }
}

/// Plans tiles for an opened COPC file (header bounds + hierarchy).
pub fn plan_tiles_for_reader<R: Read + Seek + Send>(
    reader: &CopcReader<R>,
    cap: u64,
    min_tile_size: f64,
) -> Result<Vec<Tile>, copc_core::Error> {
    let extent = header_extent(reader.header());
    let info = *reader.copc_info();
    let mut nodes = Vec::new();
    for entry in reader.file().hierarchy_entries() {
        if !entry.has_point_data() {
            continue;
        }
        let (min, max) = voxel_bounds(entry.key, &info);
        nodes.push(NodeFootprint {
            rect: TileRect {
                min: [min[0], min[1]],
                max: [max[0], max[1]],
            },
            point_count: u64::try_from(entry.point_count).unwrap_or(0),
        });
    }
    plan_tiles(
        extent,
        &nodes,
        reader.header().number_of_points(),
        cap,
        min_tile_size,
    )
    .map_err(copc_core::Error::InvalidInput)
}

/// A point of a tile read with its margin.
#[derive(Debug, Clone)]
pub struct TilePoint {
    pub record: LasPointRecord,
    /// `true` if the point belongs to this tile (the core); `false` for margin points
    /// that belong to a neighbour.
    pub is_core: bool,
}

/// The points of one tile + margin.
#[derive(Debug, Clone)]
pub struct TileData {
    pub core: TileRect,
    /// The planned tile itself, for `owns()` (callers that decide ownership of things
    /// other than points, such as thinning cells, need it).
    pub tile: Tile,
    pub points: Vec<TilePoint>,
    /// Points decompressed for this tile (all points of the nodes read, including the
    /// ones outside the tile). Summing this over tiles gives the total work, which
    /// shows the re-reading of coarse-level nodes.
    pub scanned_points: u64,
    pub estimated_points: f64,
}

/// Iterator over the tiles of a COPC file. Holds one tile (+ margin) at a time.
pub struct TileReader<R, F>
where
    R: Read + Seek + Send,
    F: FnMut() -> copc_core::Result<CopcReader<R>>,
{
    open: F,
    tiles: Vec<Tile>,
    next: usize,
    margin: f64,
    z_min: f64,
    z_max: f64,
    extent: TileRect,
}

impl<R, F> TileReader<R, F>
where
    R: Read + Seek + Send,
    F: FnMut() -> copc_core::Result<CopcReader<R>>,
{
    /// `open` is called once here (to plan) and once per tile. `margin` is the width of
    /// the band around each tile that is read as well (0 or more, file units).
    pub fn new(mut open: F, cap: u64, min_tile_size: f64, margin: f64) -> copc_core::Result<Self> {
        if !margin.is_finite() || margin < 0.0 {
            return Err(copc_core::Error::InvalidInput(
                "タイルの余白は0以上にしてください".to_string(),
            ));
        }
        let reader = open()?;
        let tiles = plan_tiles_for_reader(&reader, cap, min_tile_size)?;
        let header = reader.header();
        let (z_min, z_max) = (header.min_z, header.max_z);
        let extent = header_extent(header);
        Ok(Self {
            open,
            tiles,
            next: 0,
            margin,
            z_min,
            z_max,
            extent,
        })
    }

    /// The XY extent of the whole file (the header bounds) that the tiles cover.
    pub fn extent(&self) -> TileRect {
        self.extent
    }

    pub fn tiles(&self) -> &[Tile] {
        &self.tiles
    }

    fn read_tile(&mut self, tile: Tile) -> copc_core::Result<TileData> {
        let m = self.margin;
        let lo = [tile.core.min[0] - m, tile.core.min[1] - m];
        let hi = [tile.core.max[0] + m, tile.core.max[1] + m];
        // Pad the box a little so rounding in the centre/half-extent form cannot drop
        // a point on the edge; the exact test below decides.
        let pad = |c: f64| (1.0 + c.abs()) * 1e-9;
        let center = [
            (lo[0] + hi[0]) / 2.0,
            (lo[1] + hi[1]) / 2.0,
            (self.z_min + self.z_max) / 2.0,
        ];
        let half = [
            (hi[0] - lo[0]) / 2.0 + pad(center[0]),
            (hi[1] - lo[1]) / 2.0 + pad(center[1]),
            (self.z_max - self.z_min) / 2.0 + 1.0 + pad(center[2]),
        ];
        let filter = ExtractFilter::OrientedBox(OrientedBox {
            center,
            axes: [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]],
            half_extents: half,
        });
        let mut extract = ExtractPoints::new((self.open)()?, filter)?;
        let mut points = Vec::new();
        for record in extract.by_ref() {
            let record = record?;
            let is_core = tile.owns(record.x, record.y);
            // With margin 0 only core points are kept; otherwise a closed band.
            let keep = is_core
                || (m > 0.0
                    && record.x >= lo[0]
                    && record.x <= hi[0]
                    && record.y >= lo[1]
                    && record.y <= hi[1]);
            if keep {
                points.push(TilePoint { record, is_core });
            }
        }
        Ok(TileData {
            core: tile.core,
            points,
            scanned_points: extract.stats().points_scanned,
            estimated_points: tile.estimated_points,
            tile,
        })
    }
}

impl<R, F> Iterator for TileReader<R, F>
where
    R: Read + Seek + Send,
    F: FnMut() -> copc_core::Result<CopcReader<R>>,
{
    type Item = copc_core::Result<TileData>;

    fn next(&mut self) -> Option<Self::Item> {
        let tile = *self.tiles.get(self.next)?;
        self.next += 1;
        let result = self.read_tile(tile);
        if result.is_err() {
            // Do not continue after a failure.
            self.next = self.tiles.len();
        }
        Some(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{field, open_fn, write_copc};
    use copc_reader::CopcReader;
    use copc_writer::CopcPointFields;
    use std::collections::HashSet;

    fn rect(x0: f64, y0: f64, x1: f64, y1: f64) -> TileRect {
        TileRect {
            min: [x0, y0],
            max: [x1, y1],
        }
    }

    // ---- planning (no files) ----

    #[test]
    fn plan_covers_extent_without_overlap() {
        let extent = rect(0.0, 0.0, 100.0, 60.0);
        let nodes = [NodeFootprint {
            rect: extent,
            point_count: 10_000,
        }];
        let tiles = plan_tiles(extent, &nodes, 10_000, 1_000, 1.0).expect("plan");
        let area: f64 = tiles.iter().map(|t| t.core.area()).sum();
        assert!((area - 6000.0).abs() < 1e-6, "area {area}");
        // Every sample position is owned by exactly one tile (incl. edges).
        for xi in 0..=20 {
            for yi in 0..=12 {
                let (x, y) = (f64::from(xi) * 5.0, f64::from(yi) * 5.0);
                let owners = tiles.iter().filter(|t| t.owns(x, y)).count();
                assert_eq!(owners, 1, "({x}, {y})");
            }
        }
    }

    #[test]
    fn plan_splits_dense_areas_and_respects_cap() {
        let extent = rect(0.0, 0.0, 100.0, 100.0);
        // One dense corner node and a sparse background node.
        let nodes = [
            NodeFootprint {
                rect: extent,
                point_count: 1_000,
            },
            NodeFootprint {
                rect: rect(0.0, 0.0, 10.0, 10.0),
                point_count: 90_000,
            },
        ];
        let cap = 5_000;
        let tiles = plan_tiles(extent, &nodes, 91_000, cap, 0.5).expect("plan");
        for t in &tiles {
            assert!(t.estimated_points <= cap as f64, "{t:?}");
        }
        let small = tiles.iter().map(|t| t.core.area()).fold(f64::MAX, f64::min);
        let large = tiles.iter().map(|t| t.core.area()).fold(0.0, f64::max);
        assert!(small < large / 4.0, "dense area gets smaller tiles");
    }

    #[test]
    fn plan_keeps_tiles_the_minimum_size_cannot_split() {
        let extent = rect(0.0, 0.0, 10.0, 10.0);
        let nodes = [NodeFootprint {
            rect: extent,
            point_count: 1_000_000,
        }];
        let tiles = plan_tiles(extent, &nodes, 1_000_000, 10, 5.0).expect("plan");
        assert!(tiles
            .iter()
            .all(|t| t.core.max[0] - t.core.min[0] >= 5.0 - 1e-9));
        assert!(tiles.iter().any(|t| t.estimated_points > 10.0));
    }

    #[test]
    fn plan_handles_degenerate_extent_and_bad_input() {
        let line = rect(0.0, 5.0, 10.0, 5.0);
        let tiles = plan_tiles(line, &[], 100, 10, 0.0).expect("plan");
        assert!(tiles.iter().filter(|t| t.owns(10.0, 5.0)).count() == 1);
        assert!(tiles.iter().filter(|t| t.owns(3.0, 5.0)).count() == 1);
        assert!(plan_tiles(line, &[], 100, 0, 0.0).is_err());
        assert!(plan_tiles(rect(1.0, 0.0, 0.0, 0.0), &[], 1, 1, 0.0).is_err());
        assert!(plan_tiles(line, &[], 1, 1, -1.0).is_err());
    }

    // ---- reading (synthetic COPC) ----

    /// A 60 x 40 grid of points at 1 m spacing (coordinates are exact in the LAS scale),
    /// so many points sit exactly on tile boundaries. `gps_time` = running number.
    fn grid_points() -> Vec<CopcPointFields> {
        let mut v = Vec::new();
        let mut id = 0.0;
        for ix in 0..60 {
            for iy in 0..40 {
                v.push(field(
                    1000.0 + f64::from(ix),
                    2000.0 + f64::from(iy),
                    f64::from((ix + iy) % 7),
                    id,
                ));
                id += 1.0;
            }
        }
        v
    }

    #[test]
    fn every_point_is_core_in_exactly_one_tile() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = write_copc(dir.path(), grid_points(), 200);
        let total = CopcReader::from_path(&path)
            .expect("open")
            .header()
            .number_of_points();
        assert_eq!(total, 2400);

        for margin in [0.0, 3.0] {
            let reader = TileReader::new(open_fn(&path), 400, 1.0, margin).expect("reader");
            assert!(reader.tiles().len() > 4, "several tiles expected");
            let mut core_ids = HashSet::new();
            let mut core_count = 0u64;
            for tile in reader {
                let tile = tile.expect("tile");
                for p in &tile.points {
                    if p.is_core {
                        core_count += 1;
                        assert!(core_ids.insert(p.record.gps_time.to_bits()), "twice");
                        assert!(p.record.x >= tile.core.min[0] && p.record.y >= tile.core.min[1]);
                    }
                }
            }
            assert_eq!(core_count, total, "margin {margin}");
            assert_eq!(core_ids.len() as u64, total);
        }
    }

    #[test]
    fn boundary_and_outer_edge_points_are_owned_once() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = write_copc(dir.path(), grid_points(), 200);
        let reader = TileReader::new(open_fn(&path), 400, 1.0, 0.0).expect("reader");
        let tiles: Vec<Tile> = reader.tiles().to_vec();
        // The extent max corner (1059, 2039) must be owned by exactly one tile.
        assert_eq!(tiles.iter().filter(|t| t.owns(1059.0, 2039.0)).count(), 1);
        // A point on an internal vertical boundary belongs to the tile on the right.
        let mut checked = 0;
        for t in &tiles {
            let x = t.core.max[0];
            if x < 1059.0 {
                let y = t.core.min[1];
                assert!(!t.owns(x, y), "right edge is open");
                assert_eq!(tiles.iter().filter(|o| o.owns(x, y)).count(), 1);
                checked += 1;
            }
        }
        assert!(checked > 0, "no internal boundary was checked");
        // Outer max edge points are read as core.
        let mut edge = 0;
        for tile in reader {
            let tile = tile.expect("tile");
            edge += tile
                .points
                .iter()
                .filter(|p| p.is_core && (p.record.x == 1059.0 || p.record.y == 2039.0))
                .count();
        }
        assert_eq!(edge, 40 + 60 - 1);
    }

    #[test]
    fn points_exactly_on_internal_boundaries_are_core_once() {
        // 65 x 33 points at 1 m spacing: the extent is 64 x 32, so with power-of-two
        // splitting the tile boundaries fall on integer coordinates and points sit on them.
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
        let reader = TileReader::new(open_fn(&path), 300, 1.0, 0.0).expect("reader");
        let tiles = reader.tiles().to_vec();
        let mut ids = HashSet::new();
        let mut on_boundary = 0;
        for tile in reader {
            for p in tile.expect("tile").points {
                assert!(p.is_core, "margin 0 keeps core points only");
                assert!(ids.insert(p.record.gps_time.to_bits()), "twice");
                if tiles.iter().any(|t| t.core.max[0] == p.record.x) {
                    on_boundary += 1;
                }
            }
        }
        assert_eq!(ids.len(), 65 * 33);
        assert!(on_boundary > 0, "no point was on a tile boundary");
    }

    #[test]
    fn margin_points_are_non_core_and_within_margin() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = write_copc(dir.path(), grid_points(), 200);
        let margin = 2.0;
        let reader = TileReader::new(open_fn(&path), 400, 1.0, margin).expect("reader");
        let mut margin_points = 0;
        for tile in reader {
            let tile = tile.expect("tile");
            for p in &tile.points {
                let (x, y) = (p.record.x, p.record.y);
                assert!(x >= tile.core.min[0] - margin && x <= tile.core.max[0] + margin);
                assert!(y >= tile.core.min[1] - margin && y <= tile.core.max[1] + margin);
                if !p.is_core {
                    margin_points += 1;
                }
            }
        }
        assert!(margin_points > 0, "neighbours must see margin points");
    }

    #[test]
    fn largest_tile_batch_is_bounded() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = write_copc(dir.path(), grid_points(), 100);
        let total = 2400usize;
        let cap = 300u64;
        let margin = 1.0;
        let reader = TileReader::new(open_fn(&path), cap, 1.0, margin).expect("reader");
        let mut largest = 0usize;
        let mut tile_count = 0usize;
        for tile in reader {
            let tile = tile.expect("tile");
            largest = largest.max(tile.points.len());
            tile_count += 1;
        }
        // Density is 1 point per m^2. A tile with estimate <= cap and margin m holds about
        // cap + perimeter * m points; allow a factor 2 for the estimate error.
        let bound = 2 * (cap as usize + 4 * 40 * margin as usize);
        assert!(largest <= bound, "largest {largest} bound {bound}");
        assert!(largest < total / 2, "largest {largest} total {total}");
        assert!(tile_count > 4);
    }
}
