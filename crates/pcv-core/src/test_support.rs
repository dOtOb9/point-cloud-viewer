//! Test-only helpers: write a small synthetic COPC file whose points carry a unique id
//! in `gps_time`. Shared by the tile, thinning and outlier tests.

use copc_reader::CopcReader;
use copc_writer::{
    write_source, CopcPointFields, CopcPointSource, CopcWriteMetadata, CopcWriterParams,
};
use std::path::{Path, PathBuf};

pub(crate) struct Source(Vec<CopcPointFields>);

impl CopcPointSource for Source {
    fn len(&self) -> usize {
        self.0.len()
    }
    fn xyz(&self, i: usize) -> copc_core::Result<(f64, f64, f64)> {
        Ok((self.0[i].x, self.0[i].y, self.0[i].z))
    }
    fn fields_into(&self, i: usize, out: &mut CopcPointFields) -> copc_core::Result<()> {
        out.clone_from(&self.0[i]);
        Ok(())
    }
}

pub(crate) fn field(x: f64, y: f64, z: f64, id: f64) -> CopcPointFields {
    CopcPointFields {
        x,
        y,
        z,
        intensity: 0,
        return_number: 1,
        number_of_returns: 1,
        synthetic: 0,
        key_point: 0,
        withheld: 0,
        overlap: 0,
        scan_channel: 0,
        scan_direction_flag: 0,
        edge_of_flight_line: 0,
        classification: 2,
        user_data: 0,
        scan_angle: 0.0,
        point_source_id: 1,
        gps_time: id, // unique id of the point
        red: 0,
        green: 0,
        blue: 0,
        extra_bytes: Vec::new(),
    }
}

pub(crate) fn write_copc(dir: &Path, points: Vec<CopcPointFields>, max_per_node: u32) -> PathBuf {
    let bounds = points.iter().fold(
        copc_core::Bounds::point(points[0].x, points[0].y, points[0].z),
        |mut b, p| {
            b.extend(p.x, p.y, p.z);
            b
        },
    );
    let path = dir.join("tiles.copc.laz");
    write_source(
        &path,
        &Source(points),
        false,
        bounds,
        &CopcWriterParams::new(max_per_node),
        &CopcWriteMetadata::default(),
    )
    .expect("write copc");
    path
}

pub(crate) type FileReader = CopcReader<std::io::BufReader<std::fs::File>>;

pub(crate) fn open_fn(path: &Path) -> impl FnMut() -> copc_core::Result<FileReader> + '_ {
    move || CopcReader::from_path(path)
}
