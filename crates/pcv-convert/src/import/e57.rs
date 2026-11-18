use std::io::{Read, Seek};

use e57::{CartesianCoordinate, E57Reader};

use super::point::{PointSource, RawPoint};
use super::ImportError;

pub(crate) struct E57Source<R: Read + Seek> {
    reader: E57Reader<R>,
    pointclouds: Vec<e57::PointCloud>,
    has_color: bool,
    total_points: u64,
}

impl<R: Read + Seek> E57Source<R> {
    pub(crate) fn open(reader: R) -> Result<Self, ImportError> {
        let reader = E57Reader::new(reader)?;
        let pointclouds = reader.pointclouds();
        let has_color = pointclouds.iter().any(e57::PointCloud::has_color);
        let total_points = pointclouds.iter().map(|pc| pc.records).sum();
        Ok(Self {
            reader,
            pointclouds,
            has_color,
            total_points,
        })
    }
}

impl<R: Read + Seek> PointSource for E57Source<R> {
    fn has_color(&self) -> bool {
        self.has_color
    }

    fn declared_point_count(&self) -> u64 {
        self.total_points
    }

    fn for_each_point(
        mut self,
        visit: &mut dyn FnMut(RawPoint) -> Result<(), ImportError>,
    ) -> Result<(), ImportError> {
        for pc in &self.pointclouds {
            let mut pc_reader = self.reader.pointcloud_simple(pc)?;
            for point in &mut pc_reader {
                let point = point?;
                let CartesianCoordinate::Valid { x, y, z } = point.cartesian else {
                    continue;
                };

                let color = point
                    .color
                    .map(|c| {
                        [
                            normalize_unit_to_u16(c.red),
                            normalize_unit_to_u16(c.green),
                            normalize_unit_to_u16(c.blue),
                        ]
                    })
                    .unwrap_or([0, 0, 0]);
                let intensity = point.intensity.map(normalize_unit_to_u16).unwrap_or(0);

                visit(RawPoint {
                    x,
                    y,
                    z,
                    color,
                    intensity,
                })?;
            }
        }
        Ok(())
    }
}

fn normalize_unit_to_u16(value: f32) -> u16 {
    (value.clamp(0.0, 1.0) * 65535.0).round() as u16
}
