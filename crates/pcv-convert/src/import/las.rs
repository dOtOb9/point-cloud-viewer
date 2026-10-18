//! LAS/LAZ as a `PointSource` (used only by the multi-file point merge, M4-17).
//!
//! Single LAS/LAZ files and all-LAS selections do not come through here: they use
//! `crate::streaming` and `crate::merge`, which keep every attribute. This reader keeps only
//! what `RawPoint` has (x, y, z in real coordinates, RGB, intensity), so that LAS/LAZ can be
//! chained with PLY/PCD/E57 into one COPC.
//!
//! Memory: the points are decoded `READ_BATCH_SIZE` at a time and passed on one by one,
//! so the memory does not grow with the number of points.

use std::path::Path;

use pcv_core::crs::{crs_id_from_las_header, CrsId};

use super::point::{PointSource, RawPoint};
use super::ImportError;
use crate::write_metadata::copc_write_metadata_from_source_header;

/// Same value and same reason as `crate::merge`'s batch size (it helps the parallel LAZ decoder).
const READ_BATCH_SIZE: u64 = 1024 * 1024;

pub(crate) struct LasSource {
    reader: las::Reader,
    has_color: bool,
    declared_points: u64,
    /// CRS of the file. `CrsId::Missing` when it has none.
    pub crs: CrsId,
    /// WKT to write into the output when this file's CRS is used.
    pub wkt_crs: Option<String>,
}

impl LasSource {
    /// Reads the header only; no point is decoded yet.
    pub(crate) fn open(path: &Path) -> Result<Self, ImportError> {
        let reader = las::Reader::from_path(path).map_err(|e| {
            ImportError::Merge(format!("{}: LASを開けなかった: {e}", path.display()))
        })?;
        let header = reader.header();
        Ok(Self {
            has_color: header.point_format().has_color,
            declared_points: header.number_of_points(),
            crs: crs_id_from_las_header(header),
            wkt_crs: copc_write_metadata_from_source_header(header).wkt_crs,
            reader,
        })
    }
}

impl PointSource for LasSource {
    fn has_color(&self) -> bool {
        self.has_color
    }

    fn declared_point_count(&self) -> u64 {
        self.declared_points
    }

    fn for_each_point(
        mut self,
        visit: &mut dyn FnMut(RawPoint) -> Result<(), ImportError>,
    ) -> Result<(), ImportError> {
        let mut batch = las::PointDataBuilder::new()
            .for_header(self.reader.header())
            .build();
        loop {
            let read = self
                .reader
                .fill_points(READ_BATCH_SIZE, &mut batch)
                .map_err(|e| ImportError::Merge(format!("LASの読み込みに失敗した: {e}")))?;
            if read == 0 {
                return Ok(());
            }
            for point in batch.points() {
                let point = point
                    .map_err(|e| ImportError::Merge(format!("LASの点の解釈に失敗した: {e}")))?;
                let color = match point.color {
                    Some(c) => [c.red, c.green, c.blue],
                    None => [0, 0, 0],
                };
                visit(RawPoint {
                    x: point.x,
                    y: point.y,
                    z: point.z,
                    color,
                    intensity: point.intensity,
                })?;
            }
        }
    }
}
