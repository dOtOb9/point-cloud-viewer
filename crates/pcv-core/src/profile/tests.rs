//! Tests of the section profile on small COPC files written on the spot (same approach as
//! `extract/all_points_tests.rs`).

use super::*;
use copc_writer::{
    write_source, CopcPointFields, CopcPointSource, CopcWriteMetadata, CopcWriterParams,
};

struct Source(Vec<CopcPointFields>);

impl CopcPointSource for Source {
    fn len(&self) -> usize {
        self.0.len()
    }
    fn xyz(&self, index: usize) -> copc_core::Result<(f64, f64, f64)> {
        let p = &self.0[index];
        Ok((p.x, p.y, p.z))
    }
    fn fields_into(&self, index: usize, out: &mut CopcPointFields) -> copc_core::Result<()> {
        out.clone_from(&self.0[index]);
        Ok(())
    }
}

fn open(dir: &std::path::Path, points: Vec<CopcPointFields>, has_color: bool) -> CopcFile {
    let bounds = points.iter().fold(
        copc_core::Bounds::point(points[0].x, points[0].y, points[0].z),
        |mut b, p| {
            b.extend(p.x, p.y, p.z);
            b
        },
    );
    let path = dir.join("section.copc.laz");
    write_source(
        &path,
        &Source(points),
        has_color,
        bounds,
        &CopcWriterParams::new(500),
        &CopcWriteMetadata::default(),
    )
    .expect("write test copc");
    CopcFile::open(&path).expect("open test copc")
}

/// A lattice in the plane y = 0: x = i (0..nx), z = j (0..nz).
fn wall(nx: u32, nz: u32) -> Vec<CopcPointFields> {
    let mut points = Vec::new();
    for i in 0..nx {
        for j in 0..nz {
            points.push(CopcPointFields {
                x: f64::from(i),
                y: 0.0,
                z: f64::from(j),
                classification: if j < 5 { 2 } else { 6 },
                red: 200,
                green: 100,
                blue: 50,
                ..Default::default()
            });
        }
    }
    points
}

struct Decoded {
    flags: u32,
    s_range: (f32, f32),
    z_range: (f32, f32),
    /// (s, z, [r, g, b, class])
    points: Vec<(f32, f32, [u8; 4])>,
}

fn decode(bytes: &[u8]) -> Decoded {
    let u32_at =
        |o: usize| u32::from_le_bytes([bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]]);
    let f32_at = |o: usize| f32::from_bits(u32_at(o));
    let count = u32_at(0) as usize;
    assert_eq!(
        bytes.len(),
        PROFILE_HEADER_BYTES + count * PROFILE_RECORD_BYTES
    );
    let points = (0..count)
        .map(|i| {
            let o = PROFILE_HEADER_BYTES + i * PROFILE_RECORD_BYTES;
            (
                f32_at(o),
                f32_at(o + 4),
                [bytes[o + 8], bytes[o + 9], bytes[o + 10], bytes[o + 11]],
            )
        })
        .collect();
    Decoded {
        flags: u32_at(4),
        s_range: (f32_at(8), f32_at(12)),
        z_range: (f32_at(16), f32_at(20)),
        points,
    }
}

fn line_x() -> SectionLine {
    SectionLine {
        a: [0.0, 0.0, 0.0],
        b: [10.0, 0.0, 0.0],
        up: [0.0, 0.0, 1.0],
    }
}

#[test]
fn keeps_every_point_under_the_cap_with_exact_s_and_z() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut file = open(dir.path(), wall(10, 8), true);
    let bytes = read_section_profile(&mut file, &line_x(), 1000).expect("profile");
    let d = decode(&bytes);
    assert_eq!(d.points.len(), 80);
    assert_eq!(d.flags & PROFILE_FLAG_THINNED, 0);
    assert_eq!(d.flags & PROFILE_FLAG_COLOR, PROFILE_FLAG_COLOR);
    assert_eq!(d.s_range, (0.0, 9.0));
    assert_eq!(d.z_range, (0.0, 7.0));
    // Every lattice point is present once, and colour / classification are carried over.
    let mut seen: Vec<(i32, i32)> = d.points.iter().map(|p| (p.0 as i32, p.1 as i32)).collect();
    seen.sort_unstable();
    seen.dedup();
    assert_eq!(seen.len(), 80);
    for (s, z, rgbc) in &d.points {
        assert_eq!(&rgbc[..3], &[200, 100, 50]);
        assert_eq!(rgbc[3], if *z < 5.0 { 2 } else { 6 }, "s={s}");
    }
}

#[test]
fn s_follows_a_to_b_and_z_follows_up_when_the_line_is_not_on_the_x_axis() {
    // A wall in the plane x = 5 seen along +y: s = y - 5 (A = (5, 5, 0)).
    let mut points = Vec::new();
    for j in 0..20 {
        points.push(CopcPointFields {
            x: 5.0,
            y: f64::from(j),
            z: 3.0,
            ..Default::default()
        });
    }
    let dir = tempfile::tempdir().expect("tempdir");
    let mut file = open(dir.path(), points, false);
    let line = SectionLine {
        a: [5.0, 5.0, 0.0],
        b: [5.0, 15.0, 100.0], // the height difference of A and B must not change s
        up: [0.0, 0.0, 2.0],   // not unit length
    };
    let d = decode(&read_section_profile(&mut file, &line, 0).expect("profile"));
    assert_eq!(d.flags & PROFILE_FLAG_COLOR, 0);
    assert_eq!(d.s_range, (-5.0, 14.0));
    assert_eq!(d.z_range, (3.0, 3.0));
    assert!(d.points.iter().all(|p| p.1 == 3.0));
}

#[test]
fn never_returns_more_than_the_cap_and_still_covers_the_whole_section() {
    let dir = tempfile::tempdir().expect("tempdir");
    // 200 x 200 = 40,000 points, cap 1,000.
    let mut file = open(dir.path(), wall(200, 200), false);
    let line = SectionLine {
        a: [0.0, 0.0, 0.0],
        b: [199.0, 0.0, 0.0],
        up: [0.0, 0.0, 1.0],
    };
    let bytes = read_section_profile(&mut file, &line, 1000).expect("profile");
    let d = decode(&bytes);
    assert!(d.points.len() <= 1000, "got {}", d.points.len());
    assert!(
        d.points.len() > 500,
        "thinning kept too few: {}",
        d.points.len()
    );
    assert_eq!(d.flags & PROFILE_FLAG_THINNED, PROFILE_FLAG_THINNED);
    // The size is bounded by the cap, not by the 40,000 input points.
    assert!(bytes.len() <= PROFILE_HEADER_BYTES + 1000 * PROFILE_RECORD_BYTES);
    // The thinned points spread over the whole wall (not only one corner).
    assert!(
        d.s_range.0 <= 10.0 && d.s_range.1 >= 189.0,
        "{:?}",
        d.s_range
    );
    assert!(
        d.z_range.0 <= 10.0 && d.z_range.1 >= 189.0,
        "{:?}",
        d.z_range
    );
}

#[test]
fn a_cap_equal_to_the_point_count_does_not_thin() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut file = open(dir.path(), wall(30, 30), false);
    let d = decode(&read_section_profile(&mut file, &line_x(), 900).expect("profile"));
    assert_eq!(d.points.len(), 900);
    assert_eq!(d.flags & PROFILE_FLAG_THINNED, 0);
}

#[test]
fn a_vertical_section_line_is_an_error() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut file = open(dir.path(), wall(3, 3), false);
    let line = SectionLine {
        a: [0.0, 0.0, 0.0],
        b: [0.0, 0.0, 5.0],
        up: [0.0, 0.0, 1.0],
    };
    assert!(matches!(
        read_section_profile(&mut file, &line, 0),
        Err(ProfileError::InvalidSection(_))
    ));
}

#[test]
fn grid_never_has_more_cells_than_requested() {
    let spans = [
        (100.0, 100.0),
        (1e6, 1.0),
        (1.0, 1e6),
        (0.0, 50.0),
        (50.0, 0.0),
        (0.0, 0.0),
        (1e-3, 1e5),
    ];
    for cells in [1usize, 2, 10, 1000, 2_000_000] {
        for (s, z) in spans {
            let (w, h) = grid_dims(s, z, cells);
            assert!(w >= 1 && h >= 1, "{s} {z} {cells}");
            assert!(w * h <= cells, "{w}x{h} > {cells} for {s} {z}");
        }
    }
}
