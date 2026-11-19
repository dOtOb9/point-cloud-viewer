use super::*;
use crate::test_support::{field, write_copc};
use copc_writer::CopcPointFields;

fn standard(max_cells: u64) -> SectionLineParams {
    SectionLineParams {
        corridor_half_width: 20.0,
        csf: CsfParams::standard(),
        max_cells,
    }
}

fn line_x(length: f64) -> SectionLine {
    SectionLine {
        a: [0.0, 0.0, 0.0],
        b: [length, 0.0, 0.0],
        up: [0.0, 0.0, 1.0],
    }
}

fn open(points: Vec<CopcPointFields>) -> (tempfile::TempDir, CopcFile) {
    let dir = tempfile::tempdir().expect("temp dir");
    let path = write_copc(dir.path(), points, 5_000);
    let file = CopcFile::open(&path).expect("open test copc");
    (dir, file)
}

fn ground(
    x_range: (f64, f64),
    y_range: (f64, f64),
    step: f64,
    height: impl Fn(f64) -> f64,
) -> Vec<CopcPointFields> {
    let mut points = Vec::new();
    let nx = ((x_range.1 - x_range.0) / step).round() as i64;
    let ny = ((y_range.1 - y_range.0) / step).round() as i64;
    for i in 0..=nx {
        for j in 0..=ny {
            let x = x_range.0 + i as f64 * step;
            let y = y_range.0 + j as f64 * step;
            points.push(field(x, y, height(x), points.len() as f64));
        }
    }
    points
}

fn roof(x_range: (f64, f64), y_range: (f64, f64), z: f64, first_id: usize) -> Vec<CopcPointFields> {
    let mut points = Vec::new();
    let mut x = x_range.0;
    while x <= x_range.1 + 1e-9 {
        let mut y = y_range.0;
        while y <= y_range.1 + 1e-9 {
            points.push(field(x, y, z, (first_id + points.len()) as f64));
            y += 0.5;
        }
        x += 0.5;
    }
    points
}

struct Decoded {
    ground_points: u32,
    cells: u32,
    samples: Vec<(f32, f32)>,
}

fn decode(bytes: &[u8]) -> Decoded {
    let u32_at =
        |o: usize| u32::from_le_bytes([bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]]);
    let f32_at = |o: usize| f32::from_bits(u32_at(o));
    let count = u32_at(0) as usize;
    assert_eq!(
        bytes.len(),
        SECTION_LINE_HEADER_BYTES + count * SECTION_LINE_RECORD_BYTES
    );
    let samples = (0..count)
        .map(|i| {
            let o = SECTION_LINE_HEADER_BYTES + i * SECTION_LINE_RECORD_BYTES;
            (f32_at(o), f32_at(o + 4))
        })
        .collect();
    Decoded {
        ground_points: u32_at(8),
        cells: u32_at(12),
        samples,
    }
}

fn run(file: &mut CopcFile, line: &SectionLine, params: &SectionLineParams) -> Decoded {
    let bytes = compute_section_line(file, line, params, &mut |_| true).expect("section line");
    decode(&bytes)
}

#[test]
fn flat_ground_with_a_building_is_bridged() {
    let mut points = ground((-30.0, 130.0), (-35.0, 35.0), 0.5, |_| 0.0);
    points.retain(|p| !(p.x >= 45.0 && p.x <= 55.0 && p.y >= -5.0 && p.y <= 5.0));
    let first_id = points.len();
    points.extend(roof((45.0, 55.0), (-5.0, 5.0), 8.0, first_id));
    let (_dir, mut file) = open(points);
    let d = run(&mut file, &line_x(100.0), &standard(2_000_000));

    assert!(d.samples.len() >= 190, "samples: {}", d.samples.len());
    for (s, z) in &d.samples {
        assert!(
            z.abs() < 0.05,
            "line at s={s} is {z}, expected the ground (0)"
        );
    }
    let under_building = d
        .samples
        .iter()
        .filter(|(s, _)| *s >= 46.0 && *s <= 54.0)
        .count();
    assert!(
        under_building >= 14,
        "samples under the building: {under_building}"
    );
    assert!(d.ground_points > 0 && d.ground_points <= d.cells);
}

#[test]
fn slope_is_followed() {
    let points = ground((-30.0, 130.0), (-35.0, 35.0), 0.5, |x| 0.2 * x);
    let (_dir, mut file) = open(points);
    let d = run(&mut file, &line_x(100.0), &standard(2_000_000));
    assert!(d.samples.len() >= 190);
    for (s, z) in &d.samples {
        let expected = 0.2 * f64::from(*s);
        assert!(
            (f64::from(*z) - expected).abs() < 0.05,
            "line at s={s} is {z}, expected {expected}"
        );
    }
}

#[test]
fn line_is_cut_where_the_ground_ends() {
    let points = ground((20.0, 80.0), (-30.0, 30.0), 0.5, |_| 3.0);
    let (_dir, mut file) = open(points);
    let d = run(&mut file, &line_x(100.0), &standard(2_000_000));
    let first = d.samples.first().expect("first").0;
    let last = d.samples.last().expect("last").0;
    assert!((19.9..=20.6).contains(&first), "first s = {first}");
    assert!((79.4..=80.1).contains(&last), "last s = {last}");
    assert!(d.samples.iter().all(|(_, z)| (z - 3.0).abs() < 0.05));
}

#[test]
fn bridges_a_gap_in_the_ground() {
    let mut points = ground((-30.0, 130.0), (-35.0, 35.0), 0.5, |_| 1.0);
    points.retain(|p| !(p.x > 40.0 && p.x < 60.0));
    let (_dir, mut file) = open(points);
    let d = run(&mut file, &line_x(100.0), &standard(2_000_000));
    assert!(d.samples.len() >= 190);
    assert!(d.samples.iter().all(|(_, z)| (z - 1.0).abs() < 0.05));
}

#[test]
fn works_for_a_line_that_is_not_along_x() {
    let mut points = Vec::new();
    for i in 0..=240 {
        for j in 0..=240 {
            let (x, y) = (-20.0 + f64::from(i) * 0.5, -20.0 + f64::from(j) * 0.5);
            points.push(field(x, y, 0.1 * y, points.len() as f64));
        }
    }
    let (_dir, mut file) = open(points);
    let line = SectionLine {
        a: [0.0, 0.0, 0.0],
        b: [60.0, 60.0, 0.0],
        up: [0.0, 0.0, 1.0],
    };
    let d = run(&mut file, &line, &standard(2_000_000));
    assert!(d.samples.len() > 100);
    for (s, z) in &d.samples {
        let expected = 0.1 * f64::from(*s) / 2f64.sqrt();
        assert!(
            (f64::from(*z) - expected).abs() < 0.06,
            "s={s}: {z} vs {expected}"
        );
    }
}

#[test]
fn ground_points_are_bounded_by_the_cells_not_by_the_points() {
    let params = SectionLineParams {
        corridor_half_width: 5.0,
        csf: CsfParams {
            cloth_resolution: 1.0,
            ..CsfParams::standard()
        },
        max_cells: 2_000_000,
    };
    let points = ground((-5.0, 15.0), (-5.0, 5.0), 0.0625, |_| 0.0);
    const MIN_POINTS: usize = 50_000;
    const CORRIDOR_LENGTH_CELLS: usize = 20;
    const CORRIDOR_WIDTH_CELLS: usize = 10;
    assert!(points.len() > MIN_POINTS);
    let (_dir, mut file) = open(points);
    let mut job = SectionLineJob::new(&file, &line_x(10.0), &params).expect("job");
    let cells = job.cell_count();
    assert_eq!(cells, CORRIDOR_LENGTH_CELLS * CORRIDOR_WIDTH_CELLS);
    loop {
        let p = job.advance(&mut file).expect("advance");
        assert!(job.ground_point_count() <= cells);
        if p.done {
            break;
        }
    }
    assert_eq!(job.ground_point_count(), cells);
    let d = decode(&job.finish().expect("finish"));
    assert!(d.ground_points <= d.cells);
}

#[test]
fn keeps_the_ground_point_nearest_the_cell_centre() {
    let mut points = ground((-30.0, 130.0), (-35.0, 35.0), 1.0, |_| 0.0);
    let corner = field(10.02, 0.02, 0.01, points.len() as f64);
    let centre = field(10.26, 0.24, 0.02, points.len() as f64 + 1.0);
    points.push(corner);
    points.push(centre);
    let (_dir, mut file) = open(points);
    let mut job = SectionLineJob::new(&file, &line_x(100.0), &standard(2_000_000)).expect("job");
    while !job.advance(&mut file).expect("advance").done {}
    let ix = ((10.26 - job.s_lo) / 0.5).floor() as usize;
    let iy = ((0.24f64 + 20.0) / 0.5).floor() as usize;
    let cell = job.best[iy * job.grid_nx + ix];
    assert!((cell.s - 10.26).abs() < 1e-4 && (cell.t - 0.24).abs() < 1e-4);
}

#[test]
fn refuses_a_corridor_over_the_cell_cap() {
    let points = ground((0.0, 10.0), (-5.0, 5.0), 1.0, |_| 0.0);
    let (_dir, file) = open(points);
    const SMALL_CELL_CAP: u64 = 10_000;
    let result = SectionLineJob::new(&file, &line_x(500.0), &standard(SMALL_CELL_CAP));
    match result {
        Err(SectionLineError::Cloth(m)) => {
            assert!(m.contains("解像度") && m.contains("範囲"), "{m}");
        }
        other => panic!("expected a refusal, got {:?}", other.err()),
    }
}

#[test]
fn cancel_stops_the_job() {
    let points = ground((-30.0, 130.0), (-35.0, 35.0), 1.0, |_| 0.0);
    let (_dir, mut file) = open(points);
    let mut calls = 0;
    let result = compute_section_line(&mut file, &line_x(100.0), &standard(2_000_000), &mut |_| {
        calls += 1;
        calls < 3
    });
    assert!(matches!(result, Err(SectionLineError::Cancelled)));
    assert_eq!(calls, 3);
}

#[test]
fn progress_never_goes_back() {
    let points = ground((-30.0, 130.0), (-35.0, 35.0), 1.0, |_| 0.0);
    let (_dir, mut file) = open(points);
    let mut last = 0.0f32;
    let bytes = compute_section_line(&mut file, &line_x(100.0), &standard(2_000_000), &mut |f| {
        assert!(f >= last && f <= 1.0, "{f} after {last}");
        last = f;
        true
    });
    assert!(bytes.is_ok());
    assert!(last > 0.9);
}

#[test]
fn invalid_input_is_an_error() {
    let points = ground((0.0, 10.0), (-5.0, 5.0), 1.0, |_| 0.0);
    let (_dir, file) = open(points);
    let mut params = standard(2_000_000);
    params.corridor_half_width = 0.0;
    assert!(matches!(
        SectionLineJob::new(&file, &line_x(10.0), &params),
        Err(SectionLineError::Invalid(_))
    ));
    let vertical = SectionLine {
        a: [0.0, 0.0, 0.0],
        b: [0.0, 0.0, 5.0],
        up: [0.0, 0.0, 1.0],
    };
    assert!(matches!(
        SectionLineJob::new(&file, &vertical, &standard(2_000_000)),
        Err(SectionLineError::Section(_))
    ));
}

#[test]
fn no_points_in_the_corridor_is_an_error() {
    let points = ground((0.0, 10.0), (200.0, 210.0), 1.0, |_| 0.0);
    let (_dir, mut file) = open(points);
    let result = compute_section_line(&mut file, &line_x(10.0), &standard(2_000_000), &mut |_| {
        true
    });
    assert!(
        matches!(
            result,
            Err(SectionLineError::NoPoints)
                | Err(SectionLineError::NoGround)
                | Err(SectionLineError::Cloth(_))
        ),
        "{:?}",
        result.err()
    );
}

#[test]
fn request_json_becomes_params_without_changing_the_numbers() {
    let json = r#"{"corridorHalfWidth":65.6,"csf":{"clothResolution":1.64,"rigidness":1,"timeStep":0.65,
        "classThresholdUpper":0.33,"classThresholdLower":3.28,"iterations":1500,"slopeSmooth":true,
        "hdiff":0.98,"convergenceThreshold":0.016}}"#;
    let request: SectionLineRequest = serde_json::from_str(json).expect("request");
    let params = request.to_params(123);
    assert_eq!(params.max_cells, 123);
    assert_eq!(params.corridor_half_width, 65.6);
    assert_eq!(params.csf.cloth_resolution, 1.64);
    assert_eq!(params.csf.rigidness, 1);
    assert_eq!(params.csf.class_threshold_lower, 3.28);
    assert_eq!(params.csf.iterations, 1500);
    assert!(params.csf.slope_smooth);
}
