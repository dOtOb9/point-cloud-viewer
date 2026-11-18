#[derive(Clone, Copy, Debug)]
pub struct RawPoint {
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub intensity: u16,
    pub classification: u8,
    pub color: [u16; 3],
}

pub struct SourceCloud {
    pub points: Vec<RawPoint>,
    pub has_color: bool,
    pub scale: (f64, f64, f64),
    pub offset: (f64, f64, f64),
    pub bounds_min: (f64, f64, f64),
    pub bounds_max: (f64, f64, f64),
}

#[derive(Debug, thiserror::Error)]
pub enum ReadError {
    #[error("入力LAS/LAZを開けなかった: {0}")]
    Open(#[source] las::Error),
    #[error("点の読み出しに失敗した: {0}")]
    Point(#[source] las::Error),
    #[error("入力に点が1つも無い")]
    Empty,
}

pub fn read_all(path: &std::path::Path) -> Result<SourceCloud, ReadError> {
    let mut reader = las::Reader::from_path(path).map_err(ReadError::Open)?;
    let has_color = reader.header().point_format().has_color;
    let transforms = *reader.header().transforms();
    let count = reader.header().number_of_points() as usize;

    let mut points = Vec::with_capacity(count);
    let mut min = (f64::MAX, f64::MAX, f64::MAX);
    let mut max = (f64::MIN, f64::MIN, f64::MIN);

    let point_data = reader.read_all().map_err(ReadError::Point)?;
    for point in point_data.points() {
        let point = point.map_err(ReadError::Point)?;
        min.0 = min.0.min(point.x);
        min.1 = min.1.min(point.y);
        min.2 = min.2.min(point.z);
        max.0 = max.0.max(point.x);
        max.1 = max.1.max(point.y);
        max.2 = max.2.max(point.z);

        let color = point
            .color
            .map(|c| [c.red, c.green, c.blue])
            .unwrap_or([0, 0, 0]);
        points.push(RawPoint {
            x: point.x,
            y: point.y,
            z: point.z,
            intensity: point.intensity,
            classification: u8::from(point.classification),
            color,
        });
    }

    if points.is_empty() {
        return Err(ReadError::Empty);
    }

    Ok(SourceCloud {
        points,
        has_color,
        scale: (transforms.x.scale, transforms.y.scale, transforms.z.scale),
        offset: (
            transforms.x.offset,
            transforms.y.offset,
            transforms.z.offset,
        ),
        bounds_min: min,
        bounds_max: max,
    })
}
