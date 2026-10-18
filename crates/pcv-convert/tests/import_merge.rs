//! M4-17: merging several files of any format into one COPC
//! (`pcv_convert::import::merge::convert_paths_to_copc_and_timings`).
//!
//! All inputs are synthetic and written by the tests.

mod common;

use std::path::{Path, PathBuf};

use copc_core::NeverCancel;
use copc_writer::CopcWriterParams;
use pcv_convert::import::merge::{
    convert_paths_to_copc_and_timings, is_las_or_laz, PointMergeSummary,
    LAS_ATTRIBUTES_DROPPED_WARNING, NON_LAS_SAME_CRS_WARNING,
};
use pcv_convert::import::ImportError;
use pcv_convert::stage_timings::ConversionStageTimings;

/// ASCII PLY with x y z only.
fn write_ply_xyz(path: &Path, points: &[(f32, f32, f32)]) {
    let mut text = format!(
        "ply\nformat ascii 1.0\nelement vertex {}\n\
         property float x\nproperty float y\nproperty float z\nend_header\n",
        points.len()
    );
    for (x, y, z) in points {
        text.push_str(&format!("{x} {y} {z}\n"));
    }
    std::fs::write(path, text).expect("write ply");
}

/// ASCII PLY with x y z red green blue (uchar).
fn write_ply_rgb(path: &Path, points: &[(f32, f32, f32)], rgb: [u8; 3]) {
    let mut text = format!(
        "ply\nformat ascii 1.0\nelement vertex {}\n\
         property float x\nproperty float y\nproperty float z\n\
         property uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n",
        points.len()
    );
    for (x, y, z) in points {
        text.push_str(&format!("{x} {y} {z} {} {} {}\n", rgb[0], rgb[1], rgb[2]));
    }
    std::fs::write(path, text).expect("write ply");
}

/// ASCII PCD with x y z only (no color).
fn write_pcd_xyz(path: &Path, points: &[(f32, f32, f32)]) {
    let n = points.len();
    let mut text = format!(
        "# .PCD v0.7\nVERSION 0.7\nFIELDS x y z\nSIZE 4 4 4\nTYPE F F F\nCOUNT 1 1 1\n\
         WIDTH {n}\nHEIGHT 1\nVIEWPOINT 0 0 0 1 0 0 0\nPOINTS {n}\nDATA ascii\n"
    );
    for (x, y, z) in points {
        text.push_str(&format!("{x} {y} {z}\n"));
    }
    std::fs::write(path, text).expect("write pcd");
}

/// LAS 1.2 point format 3 (GPS time + color), classification 5 on every point.
/// `epsg` adds a GeoTIFF ProjectedCRSGeoKey VLR.
fn write_las(path: &Path, points: &[(f64, f64, f64)], epsg: Option<u16>) {
    let mut builder = las::Builder::from((1, 2));
    builder.point_format = las::point::Format::new(3).expect("format 3");
    if let Some(epsg) = epsg {
        let mut keys = Vec::new();
        for v in [1u16, 1, 1, 1, 3072, 0, 1, epsg] {
            keys.extend_from_slice(&v.to_le_bytes());
        }
        builder.vlrs.push(las::Vlr {
            user_id: "LASF_Projection".to_string(),
            record_id: 34735,
            description: String::new(),
            data: keys,
        });
    }
    let header = builder.into_header().expect("header");
    let mut writer = las::Writer::from_path(path, header).expect("las writer");
    for &(x, y, z) in points {
        let point = las::Point {
            x,
            y,
            z,
            gps_time: Some(0.0),
            color: Some(las::Color::new(1000, 2000, 3000)),
            classification: las::point::Classification::new(5).expect("class"),
            ..Default::default()
        };
        writer.write_point(point).expect("write point");
    }
    writer.close().expect("close las");
}

fn merge(paths: &[PathBuf], output: &Path) -> Result<PointMergeSummary, ImportError> {
    let mut timings = ConversionStageTimings::default();
    convert_paths_to_copc_and_timings(
        paths,
        output,
        output.parent().expect("parent"),
        &CopcWriterParams::default(),
        &NeverCancel,
        |_| {},
        &mut timings,
    )
}

const PLY_POINTS: [(f32, f32, f32); 3] = [(0.0, 0.0, 0.0), (1.0, 2.0, 3.0), (4.0, 5.0, 6.0)];
const PCD_POINTS: [(f32, f32, f32); 2] = [(100.0, 100.0, 100.0), (101.0, 102.0, 103.0)];

#[test]
fn ply_and_pcd_without_color_merge_into_one_cloud_without_color() {
    let dir = tempfile::tempdir().expect("tempdir");
    let ply = dir.path().join("a.ply");
    let pcd = dir.path().join("b.pcd");
    let out = dir.path().join("out.copc.laz");
    write_ply_xyz(&ply, &PLY_POINTS);
    write_pcd_xyz(&pcd, &PCD_POINTS);

    // Selection order must not matter: pass the files reversed.
    let summary = merge(&[pcd, ply], &out).expect("merge");
    assert_eq!(summary.import.point_count, 5);
    assert!(summary.warnings.is_empty(), "{:?}", summary.warnings);

    let (declared, points) = common::read_all_points(&out);
    assert_eq!(declared, 5);
    assert_eq!(points.len(), 5);
    // Bounds cover both clouds.
    let max_x = points.iter().map(|p| p.x).fold(f64::MIN, f64::max);
    let min_x = points.iter().map(|p| p.x).fold(f64::MAX, f64::min);
    assert!(min_x.abs() < 0.01 && (max_x - 101.0).abs() < 0.01);
    assert!(
        !output_has_color(&out),
        "no input has color, so the output has none"
    );
    // Same color on every point (a leftover of the writer default, not a real color).
    assert!(points.iter().all(|p| p.color == points[0].color));
}

#[test]
fn colored_ply_and_uncolored_pcd_give_gray_to_the_pcd_points() {
    let dir = tempfile::tempdir().expect("tempdir");
    let ply = dir.path().join("a.ply");
    let pcd = dir.path().join("b.pcd");
    let out = dir.path().join("out.copc.laz");
    write_ply_rgb(&ply, &PLY_POINTS, [255, 0, 0]);
    write_pcd_xyz(&pcd, &PCD_POINTS);

    let summary = merge(&[ply, pcd], &out).expect("merge");
    assert_eq!(summary.import.point_count, 5);

    assert!(
        output_has_color(&out),
        "one input has color, so the output has it"
    );
    let (_, points) = common::read_all_points(&out);
    // PLY red = [65535, 0, 0] in 16 bit, PCD gray = [32768; 3]. The reader narrows to 8 bit
    // when some channel is above 255.
    let expected = common::expected_u8_colors(&[[65535, 0, 0], [32768, 32768, 32768]]);
    let (red, gray) = (expected[0], expected[1]);
    let red_count = points.iter().filter(|p| p.color == red).count();
    let gray_count = points.iter().filter(|p| p.color == gray).count();
    assert_eq!((red_count, gray_count), (3, 2), "{points:?}");
    // The gray ones are the PCD points (x >= 100).
    assert!(points
        .iter()
        .filter(|p| p.x >= 100.0)
        .all(|p| p.color == gray));
}

#[test]
fn las_and_ply_merge_with_the_attribute_warning() {
    let dir = tempfile::tempdir().expect("tempdir");
    let las = dir.path().join("a.las");
    let ply = dir.path().join("b.ply");
    let out = dir.path().join("out.copc.laz");
    write_las(&las, &[(10.0, 10.0, 10.0), (11.0, 11.0, 11.0)], None);
    write_ply_xyz(&ply, &PLY_POINTS);

    let summary = merge(&[las, ply], &out).expect("merge");
    assert_eq!(summary.import.point_count, 5);
    // No CRS anywhere, so only the attribute warning.
    assert_eq!(summary.warnings, vec![LAS_ATTRIBUTES_DROPPED_WARNING]);
    assert!(!summary.import.crs_known);

    // The LAS has color, the PLY has none: the output has color and the PLY points are gray.
    let (_, points) = common::read_all_points(&out);
    assert_eq!(points.len(), 5);
    let expected = common::expected_u8_colors(&[[1000, 2000, 3000], [32768, 32768, 32768]]);
    assert_eq!(points.iter().filter(|p| p.color == expected[0]).count(), 2);
    assert_eq!(points.iter().filter(|p| p.color == expected[1]).count(), 3);
}

#[test]
fn las_crs_is_kept_and_the_same_crs_warning_is_added() {
    let dir = tempfile::tempdir().expect("tempdir");
    let las = dir.path().join("a.las");
    let ply = dir.path().join("b.ply");
    let out = dir.path().join("out.copc.laz");
    write_las(&las, &[(10.0, 10.0, 10.0)], Some(6677));
    write_ply_xyz(&ply, &PLY_POINTS);

    let summary = merge(&[las, ply], &out).expect("merge");
    assert!(summary.import.crs_known);
    assert_eq!(
        summary.warnings,
        vec![LAS_ATTRIBUTES_DROPPED_WARNING, NON_LAS_SAME_CRS_WARNING]
    );
}

#[test]
fn two_las_with_different_crs_and_a_ply_fail_before_writing() {
    let dir = tempfile::tempdir().expect("tempdir");
    let a = dir.path().join("a.las");
    let b = dir.path().join("b.las");
    let ply = dir.path().join("c.ply");
    let out = dir.path().join("out.copc.laz");
    write_las(&a, &[(10.0, 10.0, 10.0)], Some(6677));
    write_las(&b, &[(11.0, 11.0, 11.0)], Some(6678));
    write_ply_xyz(&ply, &PLY_POINTS);

    let err = merge(&[a, b, ply], &out).expect_err("CRS conflict");
    let message = err.to_string();
    assert!(message.contains("CRS"), "{message}");
    assert!(message.contains("b.las"), "the file is named: {message}");
    assert!(!out.exists(), "nothing is written on a CRS conflict");
}

#[test]
fn a_las_without_crs_agrees_with_one_that_has_a_crs() {
    let dir = tempfile::tempdir().expect("tempdir");
    let a = dir.path().join("a.las");
    let b = dir.path().join("b.las");
    let ply = dir.path().join("c.ply");
    let out = dir.path().join("out.copc.laz");
    write_las(&a, &[(10.0, 10.0, 10.0)], None);
    write_las(&b, &[(11.0, 11.0, 11.0)], Some(6677));
    write_ply_xyz(&ply, &PLY_POINTS);

    let summary = merge(&[a, b, ply], &out).expect("merge");
    assert!(summary.import.crs_known);
}

/// The existing LAS-only route (`pcv_convert::merge`) keeps classification, which the point
/// merge cannot. `src-tauri` chooses the route with `is_las_or_laz`.
#[test]
fn all_las_inputs_keep_using_the_las_merge_which_keeps_classification() {
    let dir = tempfile::tempdir().expect("tempdir");
    let a = dir.path().join("a.las");
    let b = dir.path().join("b.las");
    let out = dir.path().join("out.copc.laz");
    write_las(&a, &[(10.0, 10.0, 10.0)], None);
    write_las(&b, &[(11.0, 11.0, 11.0)], None);

    let paths = vec![a, b];
    assert!(paths.iter().all(|p| is_las_or_laz(p)));
    assert!(!is_las_or_laz(Path::new("x.ply")));
    assert!(is_las_or_laz(Path::new("X.LAZ")));

    let mut timings = ConversionStageTimings::default();
    pcv_convert::merge::merge_paths_and_timings(
        paths,
        &out,
        dir.path(),
        &CopcWriterParams::default(),
        &NeverCancel,
        |_| {},
        &mut timings,
    )
    .expect("las merge");

    let mut reader = las::Reader::from_path(&out).expect("open output");
    let all = reader.read_all().expect("read all");
    let classes: Vec<u8> = all
        .points()
        .map(|p| u8::from(p.expect("point").classification))
        .collect();
    assert_eq!(classes, vec![5, 5]);
}

fn output_has_color(path: &Path) -> bool {
    let reader = las::Reader::from_path(path).expect("open output");
    reader.header().point_format().has_color
}
