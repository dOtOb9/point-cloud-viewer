//! Writes a sample GeoTIFF so a person can open it in QGIS and check the position,
//! the values and the NoData handling (G1-2).
//!
//! Usage: `cargo run -p pcv-core --example write_sample_geotiff -- <output.tif>`
//!
//! The image is 200 x 100 cells of 1 m in EPSG:6677 (JGD2011 / Japan Plane
//! Rectangular CS IX, Tokyo area). The value is x + y in cell units, so it grows from
//! the top-left (north-west) towards the bottom-right; a 20 x 20 hole of NoData sits in
//! the middle, which QGIS must show as transparent.

use pcv_core::raster::geotiff::write_f32;
use pcv_core::raster::{GridSpec, NODATA};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::env::args()
        .nth(1)
        .ok_or("usage: write_sample_geotiff <output.tif>")?;
    // South-west corner at (easting, northing) = (-5000, -35000) m. This is only a
    // plausible place in the zone IX area, chosen for a visual check.
    let spec = GridSpec {
        origin_x: -5000.0,
        origin_y: -35000.0,
        cell_size: 1.0,
        width: 200,
        height: 100,
    };
    let values = (0..spec.height).flat_map(|row| {
        (0..spec.width).map(move |col| {
            let in_hole = (90..110).contains(&col) && (40..60).contains(&row);
            if in_hole {
                NODATA
            } else {
                (col + row) as f32
            }
        })
    });
    let file = std::fs::File::create(&path)?;
    let mut out = std::io::BufWriter::new(file);
    write_f32(&mut out, &spec, Some(6677), NODATA, values)?;
    Ok(())
}
