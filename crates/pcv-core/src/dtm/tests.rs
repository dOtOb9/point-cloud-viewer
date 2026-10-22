//! Tests of the DTM job on small synthetic COPC files written on the spot (same approach as
//! `section_line/tests.rs`). Distances are in metres. The cloth resolution is 0.5 and the DTM cell 1.0.

use std::io::Cursor;

use super::*;
use crate::test_support::{field, write_copc};
use copc_writer::CopcPointFields;
use tiff::decoder::{Decoder, DecodingResult};

fn params(max_particles: u64, max_cells: u64) -> DtmParams {
    DtmParams {
        csf: CsfParams::standard(),
        cell_size: 1.0,
        max_particles,
        max_cells,
        display_unit: None,
    }
}

fn open_reader(
    points: Vec<CopcPointFields>,
    max_per_node: u32,
) -> (
    tempfile::TempDir,
    CopcReader<std::io::BufReader<std::fs::File>>,
) {
    let dir = tempfile::tempdir().expect("temp dir");
    let path = write_copc(dir.path(), points, max_per_node);
    let reader = CopcReader::from_path(&path).expect("open test copc");
    (dir, reader)
}

/// A point with a class, the id in `gps_time`.
fn point(x: f64, y: f64, z: f64, class: u8, id: usize) -> CopcPointFields {
    let mut p = field(x, y, z, id as f64);
    p.classification = class;
    p
}

/// A lattice at `height(x, y)` with the given class and spacing, over the box `[0, size]`.
fn lattice(
    size: f64,
    step: f64,
    class: u8,
    height: impl Fn(f64, f64) -> f64,
    points: &mut Vec<CopcPointFields>,
) {
    let n = (size / step).round() as i64;
    for i in 0..=n {
        for j in 0..=n {
            let (x, y) = (i as f64 * step, j as f64 * step);
            let id = points.len();
            points.push(point(x, y, height(x, y), class, id));
        }
    }
}

fn inside_building(x: f64, y: f64) -> bool {
    (20.0..=30.0).contains(&x) && (20.0..=30.0).contains(&y)
}

/// Ground (class 2) with no ground under a 10 m building whose roof (class 6) is 8 m up, and a clump of
/// vegetation (class 5) between 2 and 6 m up. Returns the points and the ids of the roof and the vegetation.
fn town(height: impl Fn(f64, f64) -> f64 + Copy) -> (Vec<CopcPointFields>, Vec<usize>, Vec<usize>) {
    let mut points = Vec::new();
    lattice(60.0, 0.5, 2, height, &mut points);
    points.retain(|p| !inside_building(p.x, p.y));
    let mut roof = Vec::new();
    let mut x = 20.0;
    while x <= 30.0 {
        let mut y = 20.0;
        while y <= 30.0 {
            roof.push(points.len());
            let id = points.len();
            points.push(point(x, y, height(x, y) + 8.0, 6, id));
            y += 0.5;
        }
        x += 0.5;
    }
    let mut vegetation = Vec::new();
    let mut x = 40.0;
    while x <= 45.0 {
        let mut y = 40.0;
        while y <= 45.0 {
            for dz in [2.0, 3.5, 5.0, 6.0] {
                vegetation.push(points.len());
                let id = points.len();
                points.push(point(x, y, height(x, y) + dz, 5, id));
            }
            y += 0.5;
        }
        x += 0.5;
    }
    // The lattice lost the points under the building, so renumber: the id of every point is its index.
    for (i, p) in points.iter_mut().enumerate() {
        p.gps_time = i as f64;
    }
    (points, roof, vegetation)
}

struct Run {
    surface: DtmSurface,
    /// Class written for each point id (`gps_time` of the record).
    classes: std::collections::HashMap<usize, u8>,
    written: u64,
    read_total: u64,
}

fn run(points: Vec<CopcPointFields>, max_per_node: u32) -> Run {
    let (_dir, mut reader) = open_reader(points, max_per_node);
    let read_total = reader.header().number_of_points();
    let mut classes = std::collections::HashMap::new();
    let mut written = 0u64;
    let surface = run_dtm(
        &mut reader,
        Some(6677),
        &params(2_000_000, 2_000_000),
        &mut |record| {
            classes.insert(record.gps_time as usize, record.classification);
            written += 1;
            Ok(())
        },
        &mut |_| true,
    )
    .expect("dtm");
    Run {
        surface,
        classes,
        written,
        read_total,
    }
}

/// Cell centres away from the outer ring (the TIN's hull does not reach the corners of the outer cells).
fn interior_cells(surface: &DtmSurface) -> Vec<(f64, f64)> {
    let g = surface.grid();
    (0..g.cell_count() as usize)
        .map(|i| (i, g.cell_center(i)))
        .filter(|(_, (x, y))| *x > 2.0 && *x < 58.0 && *y > 2.0 && *y < 58.0)
        .map(|(_, c)| c)
        .collect()
}

#[test]
fn flat_ground_with_a_building_and_vegetation() {
    let (points, roof, vegetation) = town(|_, _| 0.0);
    let r = run(points, 5_000);
    let cells = interior_cells(&r.surface);
    assert!(cells.len() > 3_000);
    for (x, y) in &cells {
        let z = r.surface.height_at(*x, *y).expect("inside the hull");
        assert!(z.abs() < 0.05, "z at ({x}, {y}) is {z}, expected 0");
    }
    // Under the building there is no ground point; the TIN bridges it.
    let under = r.surface.height_at(25.0, 25.0).expect("under the building");
    assert!(under.abs() < 0.05, "under the building: {under}");
    for id in roof {
        assert_ne!(r.classes[&id], 2, "a roof point became ground");
    }
    for id in vegetation {
        assert_ne!(r.classes[&id], 2, "a vegetation point became ground");
    }
}

#[test]
fn slope_is_followed() {
    // z = 0.2 x (about 11 degrees).
    let (points, _, _) = town(|x, _| 0.2 * x);
    let r = run(points, 5_000);
    for (x, y) in interior_cells(&r.surface) {
        let z = r.surface.height_at(x, y).expect("inside the hull");
        assert!(
            (z - 0.2 * x).abs() < 0.05,
            "z at ({x}, {y}) is {z}, expected {}",
            0.2 * x
        );
    }
}

#[test]
fn classification_follows_the_owners_rule() {
    // Q7: CSF ground -> 2; originally 2 but not ground -> 1; anything else keeps its class.
    let (mut points, roof, vegetation) = town(|_, _| 0.0);
    // A point the source called ground, floating 3 m above the ground.
    let floating = points.len();
    points.push(point(5.25, 5.25, 3.0, 2, floating));
    // A real ground point the source left unclassified (1).
    let unclassified = points.len();
    points.push(point(10.25, 10.25, 0.0, 1, unclassified));
    // A real ground point the source called "low point" (7): it is ground by CSF, so it becomes 2.
    let low = points.len();
    points.push(point(12.25, 12.25, 0.0, 7, low));
    let r = run(points, 5_000);
    assert_eq!(r.classes[&floating], 1, "originally 2, not ground -> 1");
    assert_eq!(r.classes[&unclassified], 2, "ground -> 2");
    assert_eq!(r.classes[&low], 2, "ground -> 2");
    for id in roof {
        assert_eq!(r.classes[&id], 6, "a roof point keeps class 6");
    }
    for id in vegetation {
        assert_eq!(r.classes[&id], 5, "a vegetation point keeps class 5");
    }
}

#[test]
fn every_point_is_read_and_written() {
    // Small nodes make a deep tree, so there are coarse levels with points in them.
    let (points, _, _) = town(|_, _| 0.0);
    let expected = points.len() as u64;
    let r = run(points, 300);
    assert_eq!(r.read_total, expected, "header count");
    assert_eq!(r.written, expected, "points written");
    assert_eq!(r.classes.len() as u64, expected, "every id appears once");
}

#[test]
fn memory_does_not_grow_with_the_point_count() {
    let mut sparse = Vec::new();
    lattice(60.0, 1.0, 2, |_, _| 0.0, &mut sparse);
    // 16 times the points, same extent.
    let mut dense = Vec::new();
    lattice(60.0, 0.25, 2, |_, _| 0.0, &mut dense);
    assert!(dense.len() > 15 * sparse.len());

    let measure = |points: Vec<CopcPointFields>| {
        let (_dir, mut reader) = open_reader(points, 500);
        let mut job = DtmJob::new(&reader, None, &params(2_000_000, 2_000_000)).expect("job");
        job.points_per_advance = 2_000;
        let before = job.memory_bytes();
        let mut records = 0usize;
        loop {
            let p = job.advance(&mut reader).expect("advance");
            records += job.take_records().len();
            if p.done {
                break;
            }
        }
        assert_eq!(job.memory_bytes(), before, "the held bytes changed");
        (before, job.max_buffered_points(), records)
    };
    let (sparse_bytes, sparse_buffered, _) = measure(sparse);
    let (dense_bytes, dense_buffered, dense_records) = measure(dense);
    assert_eq!(
        sparse_bytes, dense_bytes,
        "memory follows the area, not the points"
    );
    // The buffer holds one `advance` call's worth (2000 points plus the last node), not the cloud.
    assert!(dense_buffered <= 2_000 + 500, "buffered {dense_buffered}");
    assert!(dense_buffered < dense_records / 10);
    assert!(sparse_buffered <= 2_000 + 500);
}

#[test]
fn caps_refuse_before_any_point_is_read() {
    let (points, _, _) = town(|_, _| 0.0);
    let (_dir, reader) = open_reader(points, 5_000);
    // Cloth: 60 m at 0.5 m is about 124 x 124 = 15 thousand particles.
    let err = DtmJob::new(&reader, None, &params(1_000, 2_000_000)).err();
    let message = err.expect("refused").to_string();
    assert!(message.contains("DTM"), "{message}");
    assert!(message.contains("布"), "{message}");
    assert!(message.contains("CSF の解像度"), "{message}");
    assert!(!message.contains("ラスタ"), "{message}");
    // DTM cells: 61 x 61 = 3721 at 1 m.
    let err = DtmJob::new(&reader, None, &params(2_000_000, 100)).err();
    let message = err.expect("refused").to_string();
    assert!(message.contains("DTM"), "{message}");
    assert!(message.contains("セルの大きさ"), "{message}");
    assert!(!message.contains("ラスタ"), "{message}");
}

/// The number written just before 「（点群ファイルの単位）」 in a cap message.
fn suggested_size(message: &str) -> f64 {
    let head = message
        .split("（点群ファイルの単位）")
        .next()
        .expect("split");
    let digits: String = head
        .chars()
        .rev()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    digits.parse().expect("a size in the message")
}

#[test]
fn suggested_dtm_cell_size_fits_the_cap() {
    let (points, _, _) = town(|_, _| 0.0);
    let (_dir, reader) = open_reader(points, 5_000);
    let message = DtmJob::new(&reader, None, &params(2_000_000, 100))
        .err()
        .expect("refused")
        .to_string();
    let size = suggested_size(&message);
    assert!(size > 1.0, "{message}");
    let mut p = params(2_000_000, 100);
    p.cell_size = size;
    assert!(DtmJob::new(&reader, None, &p).is_ok(), "{message}");
}

#[test]
fn suggested_cloth_resolution_fits_the_cap() {
    let (points, _, _) = town(|_, _| 0.0);
    let (_dir, reader) = open_reader(points, 5_000);
    let message = DtmJob::new(&reader, None, &params(1_000, 2_000_000))
        .err()
        .expect("refused")
        .to_string();
    let size = suggested_size(&message);
    assert!(size > 0.5, "{message}");
    let mut p = params(1_000, 2_000_000);
    p.csf.cloth_resolution = size;
    assert!(DtmJob::new(&reader, None, &p).is_ok(), "{message}");
}

/// Parameters whose sizes the user typed in `symbol`, `k` file units per shown unit.
fn params_shown_in(
    max_particles: u64,
    max_cells: u64,
    symbol: DisplaySymbol,
    k: Option<f64>,
) -> DtmParams {
    let mut p = params(max_particles, max_cells);
    p.display_unit = Some(DisplayUnit {
        symbol,
        file_units_per_display_unit: k,
    });
    p
}

/// The number written just before `marker` in a message.
fn number_before(message: &str, marker: &str) -> f64 {
    let head = message.split(marker).next().expect("split");
    let digits: String = head
        .trim_end()
        .chars()
        .rev()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    digits.parse().expect("a size in the message")
}

#[test]
fn cell_message_in_feet_fits_when_converted_back() {
    const FT: f64 = 0.3048; // the file is in metres, the screen in feet
    let (points, _, _) = town(|_, _| 0.0);
    let (_dir, reader) = open_reader(points, 5_000);
    let p = params_shown_in(2_000_000, 100, DisplaySymbol::Foot, Some(FT));
    let message = DtmJob::new(&reader, None, &p)
        .err()
        .expect("refused")
        .to_string();
    println!("{message}");
    assert!(message.contains(" ft 以上"), "{message}");
    assert!(!message.contains("点群ファイルの単位"), "{message}");
    let shown = number_before(&message, " ft 以上");
    // 60 m cannot be 10 x 10 cells of 1 m, so the answer is in feet and larger than 1 m = 3.28 ft.
    assert!(shown > 3.2, "{message}");
    let mut fits = p;
    fits.cell_size = shown * FT;
    assert!(DtmJob::new(&reader, None, &fits).is_ok(), "{message}");
}

#[test]
fn cloth_message_in_feet_fits_when_converted_back() {
    const FT: f64 = 0.3048;
    let (points, _, _) = town(|_, _| 0.0);
    let (_dir, reader) = open_reader(points, 5_000);
    let p = params_shown_in(1_000, 2_000_000, DisplaySymbol::Foot, Some(FT));
    let message = DtmJob::new(&reader, None, &p)
        .err()
        .expect("refused")
        .to_string();
    println!("{message}");
    assert!(message.contains(" ft 以上"), "{message}");
    // The setting is shown as typed: 0.5 m of CSF resolution is about 1.64 ft.
    assert!(message.contains("CSF の解像度 1.64 ft"), "{message}");
    let shown = number_before(&message, " ft 以上");
    let mut fits = p;
    fits.csf.cloth_resolution = shown * FT;
    assert!(DtmJob::new(&reader, None, &fits).is_ok(), "{message}");
}

#[test]
fn same_unit_gives_the_same_number_as_before() {
    let (points, _, _) = town(|_, _| 0.0);
    let (_dir, reader) = open_reader(points, 5_000);
    let plain = DtmJob::new(&reader, None, &params(2_000_000, 100))
        .err()
        .expect("refused")
        .to_string();
    let metres = params_shown_in(2_000_000, 100, DisplaySymbol::Meter, Some(1.0));
    let shown = DtmJob::new(&reader, None, &metres)
        .err()
        .expect("refused")
        .to_string();
    println!("{shown}");
    assert!(shown.contains(" m 以上"), "{shown}");
    assert_eq!(
        number_before(&shown, " m 以上"),
        number_before(&plain, "（点群ファイルの単位）")
    );
    // The cloth message keeps the number too.
    let plain = DtmJob::new(&reader, None, &params(1_000, 2_000_000))
        .err()
        .expect("refused")
        .to_string();
    let metres = params_shown_in(1_000, 2_000_000, DisplaySymbol::Meter, Some(1.0));
    let shown = DtmJob::new(&reader, None, &metres)
        .err()
        .expect("refused")
        .to_string();
    println!("{shown}");
    assert_eq!(
        number_before(&shown, " m 以上"),
        number_before(&plain, "（点群ファイルの単位）")
    );
}

#[test]
fn unknown_file_unit_keeps_the_old_wording() {
    let (points, _, _) = town(|_, _| 0.0);
    let (_dir, reader) = open_reader(points, 5_000);
    let old = DtmJob::new(&reader, None, &params(2_000_000, 100))
        .err()
        .expect("refused")
        .to_string();
    assert!(old.contains("（点群ファイルの単位）以上"), "{old}");
    let unknown = params_shown_in(2_000_000, 100, DisplaySymbol::Foot, None);
    let message = DtmJob::new(&reader, None, &unknown)
        .err()
        .expect("refused")
        .to_string();
    assert_eq!(message, old);
    let old = DtmJob::new(&reader, None, &params(1_000, 2_000_000))
        .err()
        .expect("refused")
        .to_string();
    let unknown = params_shown_in(1_000, 2_000_000, DisplaySymbol::Foot, None);
    let message = DtmJob::new(&reader, None, &unknown)
        .err()
        .expect("refused")
        .to_string();
    assert_eq!(message, old);
    assert!(old.contains("CSF の解像度 0.5）"), "{old}");
}

#[test]
fn a_request_without_a_display_unit_still_parses() {
    let json = r#"{"csf":{"clothResolution":0.5,"rigidness":3,"timeStep":0.65,"classThresholdUpper":0.1,
        "classThresholdLower":1.0,"iterations":500,"slopeSmooth":true,"hdiff":0.3,"convergenceThreshold":0.005},
        "cellSize":1.0,"output":{"geotiff":true,"landxml":false}}"#;
    let old: DtmRequest = serde_json::from_str(json).expect("old request");
    assert_eq!(old.display_unit, None);
    let with = json.replace(
        r#""cellSize":1.0,"#,
        r#""cellSize":1.0,"displayUnit":{"symbol":"ft","fileUnitsPerDisplayUnit":0.3048},"#,
    );
    let new: DtmRequest = serde_json::from_str(&with).expect("new request");
    assert_eq!(
        new.display_unit,
        Some(DisplayUnit {
            symbol: DisplaySymbol::Foot,
            file_units_per_display_unit: Some(0.3048)
        })
    );
    let unknown = json.replace(
        r#""cellSize":1.0,"#,
        r#""cellSize":1.0,"displayUnit":{"symbol":"m","fileUnitsPerDisplayUnit":null},"#,
    );
    let r: DtmRequest = serde_json::from_str(&unknown).expect("unknown unit");
    assert_eq!(
        r.display_unit.map(|d| d.file_units_per_display_unit),
        Some(None)
    );
}

#[test]
fn round_up_keeps_two_digits() {
    assert_eq!(round_up_2_digits(0.137), 0.14);
    assert_eq!(round_up_2_digits(12.01), 13.0);
    assert_eq!(round_up_2_digits(0.3), 0.3);
}

#[test]
fn values_geotiff_reads_back() {
    let (points, _, _) = town(|x, _| 0.2 * x);
    let r = run(points, 5_000);
    let mut bytes = Vec::new();
    r.surface
        .write_geotiff(&mut bytes, TiffKind::Values)
        .expect("write");
    let mut d = Decoder::new(Cursor::new(bytes)).expect("decoder");
    let g = *r.surface.grid();
    assert_eq!(d.dimensions().expect("dims"), (g.width, g.height));
    let DecodingResult::F32(v) = d.read_image().expect("image") else {
        panic!("not float32");
    };
    assert_eq!(v.len() as u64, g.cell_count());
    // A cell in the middle: the height at its centre (row 0 is the north row).
    let (col, row) = (g.width as usize / 2, g.height as usize / 2);
    let (x, _) = g.cell_center(row * g.width as usize + col);
    assert!((f64::from(v[row * g.width as usize + col]) - 0.2 * x).abs() < 0.05);
    // The corner cell is outside the hull or not; either way NODATA is the documented value.
    assert!(v.iter().all(|&h| h == NODATA || h.is_finite()));
}

#[test]
fn colored_geotiff_reads_back() {
    let (points, _, _) = town(|x, _| 0.2 * x);
    let r = run(points, 5_000);
    let mut bytes = Vec::new();
    r.surface
        .write_geotiff(&mut bytes, TiffKind::Colored)
        .expect("write");
    let mut d = Decoder::new(Cursor::new(bytes)).expect("decoder");
    let g = *r.surface.grid();
    assert_eq!(d.dimensions().expect("dims"), (g.width, g.height));
    let DecodingResult::U8(v) = d.read_image().expect("image") else {
        panic!("not 8 bit");
    };
    assert_eq!(v.len() as u64, g.cell_count() * 4);
    // Low x (west) is blue, high x (east) is red, in the middle row.
    let row = g.height as usize / 2;
    let px = |col: usize| &v[(row * g.width as usize + col) * 4..][..4];
    let west = px(3);
    let east = px(g.width as usize - 4);
    assert_eq!(west[3], 255);
    assert!(west[2] > 150 && west[0] < 100, "west {west:?}");
    assert!(east[0] > 150 && east[2] < 100, "east {east:?}");
}

#[test]
fn landxml_points_are_north_east_elevation() {
    // A small cloud with a known point: (x, y, z) = (10.25, 20.75, 3.5) on a plane z = 3.5.
    let mut points = Vec::new();
    lattice(30.0, 0.5, 2, |_, _| 3.5, &mut points);
    let r = run(points, 5_000);
    let mut bytes = Vec::new();
    r.surface
        .write_landxml(
            &mut bytes,
            &LandXmlOptions {
                name: "DTM <test> & \"co\"",
                unit: LandXmlUnit::Meter,
                unix_seconds: 0,
            },
        )
        .expect("write");
    let text = String::from_utf8(bytes).expect("utf-8");
    assert!(text.contains("date=\"1970-01-01\" time=\"00:00:00\""));
    assert!(text.contains("<CoordinateSystem epsgCode=\"6677\"/>"));
    assert!(text.contains("name=\"DTM &lt;test&gt; &amp; &quot;co&quot;\""));
    assert!(text.contains("linearUnit=\"meter\""));

    let points: Vec<[f64; 3]> = text
        .lines()
        .filter_map(|l| l.trim().strip_prefix("<P id=\""))
        .map(|l| {
            let body = l.split('>').nth(1).expect("body");
            let body = body.split('<').next().expect("text");
            let n: Vec<f64> = body
                .split_whitespace()
                .map(|t| t.parse().expect("number"))
                .collect();
            [n[0], n[1], n[2]]
        })
        .collect();
    let faces: Vec<[usize; 3]> = text
        .lines()
        .filter_map(|l| l.trim().strip_prefix("<F>"))
        .map(|l| {
            let n: Vec<usize> = l
                .trim_end_matches("</F>")
                .split_whitespace()
                .map(|t| t.parse().expect("index"))
                .collect();
            [n[0], n[1], n[2]]
        })
        .collect();
    assert_eq!(points.len(), r.surface.ground_cells());
    assert_eq!(faces.len(), r.surface.triangle_count());
    assert!(!faces.is_empty());
    assert!(faces.iter().flatten().all(|&i| i >= 1 && i <= points.len()));
    for [_, _, z] in &points {
        assert!((z - 3.5).abs() < 1e-3);
    }
    // The grid is 30 wide in x and 30 high in y: make the extents different to tell N from E. Here both are 0..30,
    // so check order with the point ids instead: every kept point lies in 0..=30 and, per cell, the first number
    // (northing) is the y of the cell. Rebuild one cell from the surface and compare.
    let first_vertex = r.surface.tin.vertices().next().expect("vertex");
    let d = first_vertex.data();
    let [n, e, z] = points[0];
    assert!((n - d.y).abs() < 1e-3 && (e - d.x).abs() < 1e-3 && (z - d.z).abs() < 1e-3);
}

#[test]
fn landxml_order_differs_from_xy_when_x_and_y_differ() {
    // A cloud 40 m in x and 10 m in y: northing (the first number) is at most 10, easting at most 40.
    let mut points = Vec::new();
    for i in 0..=80 {
        for j in 0..=20 {
            let id = points.len();
            points.push(point(f64::from(i) * 0.5, f64::from(j) * 0.5, 1.0, 2, id));
        }
    }
    let r = run(points, 5_000);
    let mut bytes = Vec::new();
    r.surface
        .write_landxml(
            &mut bytes,
            &LandXmlOptions {
                name: "DTM",
                unit: LandXmlUnit::Unknown,
                unix_seconds: 0,
            },
        )
        .expect("write");
    let text = String::from_utf8(bytes).expect("utf-8");
    assert!(!text.contains("<Units>"), "unknown unit: no Units element");
    let mut max_first = 0.0f64;
    let mut max_second = 0.0f64;
    for l in text.lines().filter(|l| l.trim().starts_with("<P id=")) {
        let body = l.split('>').nth(1).expect("body");
        let body = body.split('<').next().expect("text");
        let n: Vec<f64> = body
            .split_whitespace()
            .map(|t| t.parse().expect("number"))
            .collect();
        max_first = max_first.max(n[0]);
        max_second = max_second.max(n[1]);
    }
    assert!(
        max_first <= 10.001,
        "first number is northing (y): {max_first}"
    );
    assert!(
        max_second > 30.0,
        "second number is easting (x): {max_second}"
    );
}

#[test]
fn utc_date_time_of_known_instants() {
    assert_eq!(
        utc_date_time(0),
        ("1970-01-01".to_string(), "00:00:00".to_string())
    );
    // 2026-10-22 12:34:56 UTC.
    assert_eq!(
        utc_date_time(1_792_672_496),
        ("2026-10-22".to_string(), "12:34:56".to_string())
    );
    // A leap day.
    assert_eq!(
        utc_date_time(951_782_400),
        ("2000-02-29".to_string(), "00:00:00".to_string())
    );
}

#[test]
fn a_request_without_an_output_is_refused() {
    let request: DtmRequest = serde_json::from_str(
        r#"{"csf":{"clothResolution":0.5,"rigidness":3,"timeStep":0.65,"classThresholdUpper":0.1,
        "classThresholdLower":1.0,"iterations":500,"slopeSmooth":true,"hdiff":0.3,"convergenceThreshold":0.005},
        "cellSize":0.5,"output":{"geotiff":false,"landxml":false}}"#,
    )
    .expect("json");
    assert!(request.validate().is_err());
    assert_eq!(request.output.unit, LandXmlUnit::Unknown);
    assert_eq!(request.output.tiff, TiffKind::Colored);
}

#[test]
fn ground_agreement_precision_and_recall() {
    let mut a = GroundAgreement::default();
    assert_eq!((a.precision(), a.recall()), (None, None));
    for _ in 0..8 {
        a.add(true, true);
    }
    a.add(false, true);
    a.add(false, true);
    a.add(true, false);
    a.add(false, false);
    // CSF ground: 10, of which 8 agree. Source ground: 9, of which 8 are found.
    assert_eq!(a.precision(), Some(0.8));
    assert_eq!(a.recall(), Some(8.0 / 9.0));
}
