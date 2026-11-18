use pcv_core::raster::geotiff::write_f32;
use pcv_core::raster::{GridSpec, NODATA};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::env::args()
        .nth(1)
        .ok_or("usage: write_sample_geotiff <output.tif>")?;
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
