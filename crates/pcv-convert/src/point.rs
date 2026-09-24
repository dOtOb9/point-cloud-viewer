//! 入力LAS/LAZの読み込みと、変換中にメモリへ保持する点の表現。
//!
//! # なぜ`las::Point`をそのまま保持しないのか
//!
//! `las::Point`はLASの全属性(リターン情報・GPS時刻・波形・追加バイト等)を
//! 持てるように`Option`やベクタを含んでおり、1点あたり100バイトを超える
//! (`Option<f64>`だけで16バイト、空の`Vec<u8>`でも24バイト)。
//!
//! 本ビューアが実際に使う属性は、着色モード(`ARCHITECTURE.md`の現在の状態表、
//! M2-2)が示すとおり RGB・標高(=座標)・強度・分類の4つだけである。
//! 素朴な実装ではあるが、「使わない属性のために2倍以上のメモリを積む」のは
//! 素朴さの言い訳にならないため、ここだけは持つ属性を絞る。
//! GPS時刻・リターン番号・スキャン角度などは読み捨てる
//! (このスパイクの結果としては後述の`Cargo.toml`同様に記録する簡略化)。
#[derive(Clone, Copy, Debug)]
pub struct RawPoint {
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub intensity: u16,
    pub classification: u8,
    /// 色を持たない入力では`[0, 0, 0]`。`SourceCloud::has_color`で判別する。
    pub color: [u16; 3],
}

/// 読み込んだ入力点群。出力のCOPCも同じscale/offsetをそのまま使う
/// (再量子化しない。入力と同じ精度で十分なため)。
pub struct SourceCloud {
    pub points: Vec<RawPoint>,
    pub has_color: bool,
    pub scale: (f64, f64, f64),
    pub offset: (f64, f64, f64),
    /// 実データから実測した範囲。ヘッダの申告値は信用しない
    /// (`TaskSheets/TEST-DATA.md`が指摘する「ヘッダは食い違いうる」を踏まえる)。
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

/// 入力ファイル全体を素朴にメモリへ読み込む。out-of-core化はしない
/// (M4-1の目的は「素朴に書いたらどれくらいか」を知ることなので、
/// ここを頑張ると測るものが変わってしまう)。
pub fn read_all(path: &std::path::Path) -> Result<SourceCloud, ReadError> {
    let mut reader = las::Reader::from_path(path).map_err(ReadError::Open)?;
    let has_color = reader.header().point_format().has_color;
    let transforms = *reader.header().transforms();
    let count = reader.header().number_of_points() as usize;

    let mut points = Vec::with_capacity(count);
    let mut min = (f64::MAX, f64::MAX, f64::MAX);
    let mut max = (f64::MIN, f64::MIN, f64::MIN);

    // `read_all`は入力全体をいったん生バイト列(`PointData`)として読み、
    // `.points()`が1点ずつ`las::Point`へ変換するイテレータを返す。素朴な
    // 読み方で(out-of-core化はしない)、このスパイクの目的に合う。
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
