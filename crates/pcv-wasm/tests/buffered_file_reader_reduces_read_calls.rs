use std::io::{Cursor, Read, Seek, SeekFrom};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

struct CountingReader {
    inner: Cursor<Vec<u8>>,
    read_calls: Arc<AtomicUsize>,
}

impl Read for CountingReader {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        self.read_calls.fetch_add(1, Ordering::Relaxed);
        self.inner.read(buf)
    }
}

impl Seek for CountingReader {
    fn seek(&mut self, pos: SeekFrom) -> std::io::Result<u64> {
        self.inner.seek(pos)
    }
}

fn synthetic_laz_bytes(point_count: u32) -> Vec<u8> {
    let mut builder = las::Builder::from((1, 2));
    builder.point_format = las::point::Format::new(2).expect("format 2(RGBあり)");
    builder.point_format.is_compressed = true;
    let header = builder.into_header().expect("valid header");

    let buffer: Vec<u8> = Vec::new();
    let mut writer = las::Writer::new(Cursor::new(buffer), header).expect("LAS writerの作成に失敗");
    for i in 0..point_count {
        let x = f64::from((i * 37) % 500) * 0.1;
        let y = f64::from((i * 53) % 500) * 0.1;
        let z = f64::from((i * 13) % 200) * 0.1;
        let point = las::Point {
            x,
            y,
            z,
            intensity: (i % 1000) as u16,
            color: Some(las::Color {
                red: (i % 256) as u16,
                green: ((i * 3) % 256) as u16,
                blue: ((i * 7) % 256) as u16,
            }),
            ..Default::default()
        };
        writer.write_point(point).expect("点の書き込みに失敗");
    }
    writer
        .into_inner()
        .expect("writerの終了に失敗")
        .into_inner()
}

fn count_read_calls_to_parse_all_points(
    bytes: Vec<u8>,
    point_count: u32,
    wrap_in_buf_reader: bool,
) -> usize {
    let read_calls = Arc::new(AtomicUsize::new(0));
    let counting = CountingReader {
        inner: Cursor::new(bytes),
        read_calls: read_calls.clone(),
    };

    const READ_BUFFER_BYTES: usize = 4 * 1024 * 1024;
    let mut reader = if wrap_in_buf_reader {
        las::Reader::new(std::io::BufReader::with_capacity(
            READ_BUFFER_BYTES,
            counting,
        ))
        .expect("valid LAS")
    } else {
        las::Reader::new(counting).expect("valid LAS")
    };

    let mut point_data = las::PointDataBuilder::new()
        .for_header(reader.header())
        .build();
    const BATCH_SIZE: u64 = 64 * 1024;
    let mut total_read = 0u32;
    loop {
        let count = reader
            .fill_points(BATCH_SIZE, &mut point_data)
            .expect("fill_points");
        if count == 0 {
            break;
        }
        for result in point_data.points() {
            result.expect("点の読み出しに失敗");
            total_read += 1;
        }
    }
    assert_eq!(total_read, point_count, "全点を読み終えているはず");

    read_calls.load(Ordering::Relaxed)
}

#[test]
fn buffering_drastically_reduces_underlying_read_calls() {
    let point_count = 20_000u32;
    let bytes = synthetic_laz_bytes(point_count);
    let file_size = bytes.len();

    let raw_calls = count_read_calls_to_parse_all_points(bytes.clone(), point_count, false);
    let buffered_calls = count_read_calls_to_parse_all_points(bytes, point_count, true);

    const MIN_REDUCTION_FACTOR: usize = 10;
    let half_of_the_points = point_count as usize / 2;
    assert!(
        raw_calls > half_of_the_points,
        "バッファ無しでは点数に近い回数readが呼ばれるはず: raw_calls={raw_calls}, point_count={point_count}"
    );

    const READ_BUFFER_BYTES: usize = 4 * 1024 * 1024;
    const HEADER_READS: usize = 4;
    let expected_upper_bound = file_size.div_ceil(READ_BUFFER_BYTES) + HEADER_READS;
    assert!(
        buffered_calls <= expected_upper_bound,
        "バッファ有りの呼び出し回数が想定より多い: buffered_calls={buffered_calls}, \
         expected_upper_bound={expected_upper_bound}(file_size={file_size})"
    );

    assert!(
        buffered_calls * MIN_REDUCTION_FACTOR < raw_calls,
        "バッファ有りの呼び出し回数がバッファ無しよりずっと少ないはず: \
         buffered_calls={buffered_calls}, raw_calls={raw_calls}"
    );
}
