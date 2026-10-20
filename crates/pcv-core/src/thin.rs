//! G3-2: grid (2D) and voxel (3D) thinning. Keeps ORIGINAL points, one per cell.
//!
//! Nothing is averaged: the kept point is an existing point of the cloud, so its
//! attributes (RGB, intensity, classification, ...) are carried over unchanged.
//!
//! # Cells are global, not per tile
//!
//! A cell is `floor(x / size)`, `floor(y / size)` (and `floor(z / size)` for voxels),
//! measured from the coordinate origin (0, 0, 0), never from a tile corner. So a cell
//! has the same bounds whatever the tiling is.
//!
//! # Who outputs a cell (the ownership rule)
//!
//! Tile borders are arbitrary (`tiles.rs`), so a cell can straddle a border. The rule:
//! **the tile that owns the XY of the cell's centre outputs the cell.** The tile reads a
//! margin of `size / 2` (plus a little slack) around its core. Every point of a cell
//! whose centre lies in the core is then inside core + margin, because the cell reaches
//! at most `size / 2` from its centre. The tile picks the best point among ALL points
//! of that cell (core and margin points alike) and outputs it. That point may be a
//! margin point; it is still output exactly once, by the owner of the cell.
//!
//! Because the owner depends only on the cell centre (a function of the cell, not of
//! the tiling) and the winner is chosen among all points of the cell, **the result does
//! not depend on the tiling**. Rejected: choosing tile borders at multiples of the cell
//! size. It would tie the tiling (which is chosen by point counts) to the cell size and
//! fail for large cells or odd extents.
//!
//! Edge case: a cell whose centre lies outside the file's extent (cells at the max
//! edge) is owned by the tile that owns the centre moved into the extent
//! (clamped). The clamped centre is within `size / 2` of every point of the cell
//! inside the extent, so the margin still suffices.
//!
//! # Which point wins
//!
//! The point with the smallest score. Ties are broken by z, x, y (total order on the
//! coordinates), so two different points never compete on equal terms. Two points with
//! identical coordinates but different attributes are a real tie; the one read first
//! wins, and the read order can depend on the tiling. That is the only case where the
//! tiling can change the result.
//!
//! # Memory
//!
//! A tile holds a hash map from occupied owned cells to the best point index. It is
//! bounded by the number of points of the tile (+ margin), never by the whole cloud.

use std::collections::HashMap;

use crate::tiles::{TileData, TilePoint, TileRect};

/// Which point of a grid cell is kept.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GridKeep {
    /// The point nearest to the cell centre in XY.
    NearestCentre,
    /// The point with the lowest z.
    Lowest,
    /// The point with the highest z.
    Highest,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThinKind {
    /// 2D cells in XY; one point per cell.
    Grid(GridKeep),
    /// 3D cubes; keeps the point nearest to the cube centre.
    Voxel,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ThinSettings {
    /// Cell / voxel edge length in the file's units.
    pub size: f64,
    pub kind: ThinKind,
}

impl ThinSettings {
    pub fn validate(&self) -> Result<(), String> {
        if !self.size.is_finite() || self.size <= 0.0 {
            return Err("セル・ボクセルの大きさは0より大きい数にしてください".to_string());
        }
        Ok(())
    }

    /// The margin a tile must read around its core (see the module comment).
    pub fn margin(&self) -> f64 {
        // Half a cell, plus 1 % slack so float rounding can never lose a point.
        self.size * 0.51
    }

    /// Checks that the cell index of the farthest coordinate fits easily in an `i64`.
    /// With a size that is tiny compared with the coordinates, all points would
    /// saturate into one cell and silently produce a wrong result.
    pub fn check_coordinates(&self, max_abs_coordinate: f64) -> Result<(), String> {
        if max_abs_coordinate / self.size > 1.0e15 {
            return Err("大きさが座標に比べて小さすぎます".to_string());
        }
        Ok(())
    }
}

/// Indices (ascending) into `data.points` of the points to keep for this tile.
/// `extent` is the XY extent of the whole file (`TileReader::extent`).
pub fn thin_tile(data: &TileData, extent: &TileRect, settings: &ThinSettings) -> Vec<usize> {
    let tile = data.tile;
    let owns_centre = |cx: f64, cy: f64| {
        // Centres outside the extent are moved onto it (see the module comment).
        let cx = cx.clamp(extent.min[0], extent.max[0]);
        let cy = cy.clamp(extent.min[1], extent.max[1]);
        tile.owns(cx, cy)
    };
    thin_points(&data.points, &owns_centre, settings)
}

/// The same as [`thin_tile`] on a plain slice. `owns_centre(cx, cy)` tells whether the
/// caller's tile outputs cells with that centre. Core flags are not used: a cell is
/// decided by its centre, and all of its points are in `points`.
pub fn thin_points(
    points: &[TilePoint],
    owns_centre: &dyn Fn(f64, f64) -> bool,
    settings: &ThinSettings,
) -> Vec<usize> {
    let size = settings.size;
    let voxel = settings.kind == ThinKind::Voxel;
    // Cell key -> (score of the best point so far, its index).
    let mut best: HashMap<(i64, i64, i64), ([f64; 4], usize)> = HashMap::new();
    for (index, p) in points.iter().enumerate() {
        let (x, y, z) = (p.record.x, p.record.y, p.record.z);
        let ix = (x / size).floor();
        let iy = (y / size).floor();
        let iz = if voxel { (z / size).floor() } else { 0.0 };
        let cx = (ix + 0.5) * size;
        let cy = (iy + 0.5) * size;
        if !owns_centre(cx, cy) {
            continue;
        }
        let dxy2 = (x - cx) * (x - cx) + (y - cy) * (y - cy);
        let score = match settings.kind {
            ThinKind::Voxel => {
                let cz = (iz + 0.5) * size;
                [dxy2 + (z - cz) * (z - cz), z, x, y]
            }
            ThinKind::Grid(GridKeep::NearestCentre) => [dxy2, z, x, y],
            ThinKind::Grid(GridKeep::Lowest) => [z, dxy2, x, y],
            ThinKind::Grid(GridKeep::Highest) => [-z, dxy2, x, y],
        };
        let key = (ix as i64, iy as i64, iz as i64);
        match best.get_mut(&key) {
            Some(entry) => {
                if score_less(&score, &entry.0) {
                    *entry = (score, index);
                }
            }
            None => {
                best.insert(key, (score, index));
            }
        }
    }
    let mut kept: Vec<usize> = best.values().map(|&(_, index)| index).collect();
    kept.sort_unstable();
    kept
}

/// Lexicographic "less than" on the score with a total order on floats.
fn score_less(a: &[f64; 4], b: &[f64; 4]) -> bool {
    for i in 0..4 {
        match a[i].total_cmp(&b[i]) {
            std::cmp::Ordering::Less => return true,
            std::cmp::Ordering::Greater => return false,
            std::cmp::Ordering::Equal => {}
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{field, open_fn, write_copc};
    use crate::tiles::TileReader;
    use copc_core::LasPointRecord;
    use copc_writer::CopcPointFields;
    use std::collections::BTreeSet;

    fn point(x: f64, y: f64, z: f64, id: f64) -> TilePoint {
        TilePoint {
            record: LasPointRecord {
                x,
                y,
                z,
                gps_time: id,
                ..Default::default()
            },
            is_core: true,
        }
    }

    fn all(_: f64, _: f64) -> bool {
        true
    }

    fn ids(points: &[TilePoint], kept: &[usize]) -> Vec<f64> {
        kept.iter().map(|&i| points[i].record.gps_time).collect()
    }

    fn grid(size: f64, keep: GridKeep) -> ThinSettings {
        ThinSettings {
            size,
            kind: ThinKind::Grid(keep),
        }
    }

    #[test]
    fn grid_keeps_one_point_nearest_to_the_centre() {
        // Cell [0,2) x [0,2) has centre (1, 1); cell [2,4) x [0,2) has centre (3, 1).
        let pts = [
            point(0.1, 0.1, 0.0, 1.0),
            point(1.2, 0.9, 5.0, 2.0), // nearest to (1, 1)
            point(1.9, 1.9, 0.0, 3.0),
            point(3.0, 1.0, 9.0, 4.0), // alone in the second cell, exactly at its centre
        ];
        let kept = thin_points(&pts, &all, &grid(2.0, GridKeep::NearestCentre));
        assert_eq!(ids(&pts, &kept), vec![2.0, 4.0]);
    }

    #[test]
    fn grid_lowest_and_highest() {
        let pts = [
            point(0.5, 0.5, 3.0, 1.0),
            point(0.6, 0.6, 1.0, 2.0),
            point(0.7, 0.7, 2.0, 3.0),
        ];
        let low = thin_points(&pts, &all, &grid(2.0, GridKeep::Lowest));
        assert_eq!(ids(&pts, &low), vec![2.0]);
        let high = thin_points(&pts, &all, &grid(2.0, GridKeep::Highest));
        assert_eq!(ids(&pts, &high), vec![1.0]);
    }

    #[test]
    fn voxel_splits_by_z_and_keeps_nearest_to_the_centre() {
        let settings = ThinSettings {
            size: 2.0,
            kind: ThinKind::Voxel,
        };
        let pts = [
            point(1.0, 1.0, 0.2, 1.0),  // voxel z [0,2), centre z = 1
            point(1.0, 1.0, 1.1, 2.0),  // nearest to (1, 1, 1)
            point(1.0, 1.0, 2.5, 3.0),  // voxel z [2,4), alone
            point(-0.5, 1.0, 1.0, 4.0), // negative x: voxel [-2,0)
        ];
        let kept = thin_points(&pts, &all, &settings);
        assert_eq!(ids(&pts, &kept), vec![2.0, 3.0, 4.0]);
    }

    #[test]
    fn negative_coordinates_use_floor() {
        // -0.1 belongs to cell [-2, 0), not to cell [0, 2).
        let pts = [point(-0.1, 0.5, 0.0, 1.0), point(0.1, 0.5, 0.0, 2.0)];
        let kept = thin_points(&pts, &all, &grid(2.0, GridKeep::NearestCentre));
        assert_eq!(kept.len(), 2);
    }

    #[test]
    fn attributes_are_preserved() {
        let mut p = point(0.5, 0.5, 0.0, 7.0);
        p.record.intensity = 1234;
        p.record.classification = 6;
        p.record.red = 11;
        p.record.green = 22;
        p.record.blue = 33;
        let pts = [p.clone()];
        let kept = thin_points(&pts, &all, &grid(1.0, GridKeep::NearestCentre));
        assert_eq!(pts[kept[0]].record, p.record);
    }

    #[test]
    fn cells_not_owned_by_the_tile_are_skipped() {
        let pts = [point(0.5, 0.5, 0.0, 1.0), point(5.5, 0.5, 0.0, 2.0)];
        let owns = |cx: f64, _cy: f64| cx < 3.0;
        let kept = thin_points(&pts, &owns, &grid(1.0, GridKeep::NearestCentre));
        assert_eq!(ids(&pts, &kept), vec![1.0]);
    }

    #[test]
    fn settings_are_validated() {
        assert!(grid(0.0, GridKeep::Lowest).validate().is_err());
        assert!(grid(f64::NAN, GridKeep::Lowest).validate().is_err());
        assert!(grid(-1.0, GridKeep::Lowest).validate().is_err());
        assert!(grid(1.0, GridKeep::Lowest).validate().is_ok());
        assert!(grid(1.0e-9, GridKeep::Lowest)
            .check_coordinates(1.0e7)
            .is_err());
    }

    // ---- tiling independence on a synthetic COPC file ----

    /// Pseudo-random but deterministic points with unique coordinates and ids; the
    /// points are not on a lattice so the cell choice is not a tie.
    fn scattered_points() -> Vec<CopcPointFields> {
        let mut state: u64 = 0x9E37_79B9_7F4A_7C15;
        let mut next = move || {
            state = state
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            ((state >> 33) as f64) / f64::from(1u32 << 31)
        };
        let mut v = Vec::new();
        for id in 0..3000 {
            v.push(field(
                1000.0 + next() * 80.0,
                2000.0 + next() * 50.0,
                next() * 20.0,
                f64::from(id),
            ));
        }
        v
    }

    /// Runs the thinning over all tiles of the file and returns the kept ids.
    fn thin_file(
        path: &std::path::Path,
        cap: u64,
        settings: &ThinSettings,
    ) -> (BTreeSet<u64>, usize) {
        let reader = TileReader::new(
            open_fn(path),
            cap,
            if cap >= 1_000_000 { 1.0e6 } else { 0.0 },
            settings.margin(),
        )
        .expect("tile reader");
        let extent = reader.extent();
        let tile_count = reader.tiles().len();
        let mut kept = BTreeSet::new();
        for tile in reader {
            let tile = tile.expect("tile");
            for i in thin_tile(&tile, &extent, settings) {
                let id = tile.points[i].record.gps_time.to_bits();
                assert!(kept.insert(id), "a point was output twice");
            }
        }
        (kept, tile_count)
    }

    #[test]
    fn result_does_not_depend_on_the_tiling() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = write_copc(dir.path(), scattered_points(), 150);
        let settings = [
            grid(3.7, GridKeep::NearestCentre),
            grid(3.7, GridKeep::Lowest),
            grid(3.7, GridKeep::Highest),
            ThinSettings {
                size: 2.9,
                kind: ThinKind::Voxel,
            },
        ];
        for s in settings {
            // One tile (cap larger than the file) is the reference.
            let (reference, one) = thin_file(&path, 1_000_000, &s);
            assert_eq!(one, 1);
            assert!(reference.len() > 20 && reference.len() < 3000);
            for cap in [900, 300, 100] {
                let (kept, tiles) = thin_file(&path, cap, &s);
                assert!(tiles > 4, "cap {cap} gave {tiles} tiles");
                assert_eq!(kept, reference, "{s:?} cap {cap}");
            }
        }
    }

    #[test]
    fn exactly_one_point_per_cell_over_all_tiles() {
        let dir = tempfile::tempdir().expect("tempdir");
        let source = scattered_points();
        let path = write_copc(dir.path(), source.clone(), 150);
        let s = grid(4.0, GridKeep::NearestCentre);
        let (kept, _) = thin_file(&path, 300, &s);
        let by_id: HashMap<u64, &CopcPointFields> =
            source.iter().map(|p| (p.gps_time.to_bits(), p)).collect();
        let mut cells = BTreeSet::new();
        for id in &kept {
            let p = by_id[id];
            let cell = ((p.x / 4.0).floor() as i64, (p.y / 4.0).floor() as i64);
            assert!(cells.insert(cell), "two points in one cell");
        }
        // Every occupied cell has an output.
        let occupied: BTreeSet<(i64, i64)> = source
            .iter()
            .map(|p| ((p.x / 4.0).floor() as i64, (p.y / 4.0).floor() as i64))
            .collect();
        assert_eq!(cells, occupied);
    }

    #[test]
    fn cells_straddling_tile_borders_and_the_extent_edge_are_kept() {
        // A lattice with a point exactly on the max edge of the extent, and on borders.
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
        // Cell size 5 does not divide the extent (64 x 32) evenly.
        let s = grid(5.0, GridKeep::Lowest);
        let (reference, _) = thin_file(&path, 1_000_000, &s);
        let (kept, tiles) = thin_file(&path, 300, &s);
        assert!(tiles > 4);
        assert_eq!(kept, reference);
        // 500..=564 spans cells 100..=112 (13), 700..=732 spans 140..=146 (7).
        assert_eq!(kept.len(), 13 * 7);
    }
}
