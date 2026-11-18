#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct RawPoint {
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub color: [u16; 3],
    pub intensity: u16,
}

pub(crate) trait PointSource {
    fn has_color(&self) -> bool;

    fn declared_point_count(&self) -> u64;

    fn for_each_point(
        self,
        visit: &mut dyn FnMut(RawPoint) -> Result<(), super::ImportError>,
    ) -> Result<(), super::ImportError>;
}
