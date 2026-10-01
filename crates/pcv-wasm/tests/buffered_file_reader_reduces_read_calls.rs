//! 実機不具合の回帰テスト(2026-10-01、`TaskSheets/M4-import-and-conversion.md`の
//! M4-6b追記参照)。
//!
//! `crates/pcv-wasm/src/file_reader.rs`の`FileRangeReader`は、`Read::read`が
//! 呼ばれるたびに`File.slice`→`FileReaderSync`→JSからwasmへのコピー、という
//! 重い処理を行い、自分ではバッファを持たない。`las::Reader`は(LAZ非圧縮の
//! 生のLASでは)点を1件ずつ、点の生レコード長(20〜38バイト程度)だけ読むため、
//! `FileRangeReader`を直接渡すと**1点ごとにこの重い処理が1回走る**。
//! 所有者の実機(Chrome)で、数万点を読む前に進捗が一度も出ないまま止まって
//! 見えるという不具合として実際に踏んだ。
//!
//! `FileRangeReader`自体はブラウザ専用(`web_sys::File`)でネイティブからは
//! 作れないため、ここでは「呼ばれるたびに重い」という性質だけを再現した
//! 疑似リーダー(`CountingReader`、メモリ上のバイト列をラップし、下位の
//! `read`呼び出し回数を数える)を使う。`crates/pcv-wasm/src/convert.rs`が
//! 実際に行っている対処(`std::io::BufReader`で包む)と同じ包み方をして、
//! 下位の呼び出し回数が劇的に減ることを確認する。

use std::io::{Cursor, Read, Seek, SeekFrom};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

/// `FileRangeReader`と同じ「呼ばれるたびに重い」形を再現する疑似リーダー。
/// 実際に重い処理をする代わりに、呼び出し回数だけを数える。
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

/// x/y/z全軸に散らした決定的な合成LAZ(圧縮)を、メモリ上のバイト列として作る
/// (`crates/pcv-convert/tests/streaming_conversion.rs`の
/// `write_synthetic_las_scattered_in_3d`と同じ考え方だが、**LAZ圧縮を有効にする**。
///
/// なぜLAZにするか: 非圧縮の生LASは`las`クレートの読み込み実装
/// (`src/reader/las.rs`の`PointReader::fill_into_bytes`)が
/// 「バッチ全体をVecにリサイズして1回の`read_exact`で読む」という形で、
/// 実はバッチ単位では既に効率的(本テストを最初にこの形で書いたとき、
/// バッファの有無に関わらず下位のread呼び出し回数が少なく、不具合を
/// 再現できなかった)。実機で踏んだ不具合はLAZ(圧縮)の入力で、
/// `laz`クレートのデコーダ(`src/reader/laz.rs`の`decompress_many`が使う
/// `LasZipDecompressor`)がエントロピー復号のために下位の`Read`を
/// 細かい単位で何度も呼ぶため、ここで初めて`FileRangeReader`の
/// 「呼ばれるたびに重い」という性質が問題になる。
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

/// `CountingReader`で`las::Reader`を回し、全点を読み終えるまでに下位の
/// `read`が何回呼ばれたかを返す。`wrap`で`BufReader`を挟むかどうかを選べる
/// ようにしてあり、同じ関数を「バッファ無し」「バッファ有り」の両方で呼ぶ。
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

    // `crates/pcv-wasm/src/convert.rs`が実際に行っているのと同じ包み方
    // (4MiB、`READ_BUFFER_BYTES`と同じ値)。
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

    // `WasmConverter::feed`と同じ手順(バッチで読む)。
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

    // バッファ無し: LAZのエントロピー復号(laz::LasZipDecompressor)は下位の
    // Readを細かい単位で何度も呼ぶため、下位のread呼び出し回数は点数と
    // 同じ桁になるはず(不具合の再現。実測はpoint_countの9割程度だった。
    // デコーダの内部状態によって完全に1:1にはならないため、半分を超える
    // 程度の緩い閾値にしてある)。
    assert!(
        raw_calls > point_count as usize / 2,
        "バッファ無しでは点数に近い回数readが呼ばれるはず: raw_calls={raw_calls}, point_count={point_count}"
    );

    // バッファ有り: ファイルサイズ÷バッファサイズ程度(+ヘッダー分の余裕)に
    // まで下位のread呼び出し回数が減るはず(受け入れ条件どおり)。
    const READ_BUFFER_BYTES: usize = 4 * 1024 * 1024;
    let expected_upper_bound = file_size.div_ceil(READ_BUFFER_BYTES) + 4;
    assert!(
        buffered_calls <= expected_upper_bound,
        "バッファ有りの呼び出し回数が想定より多い: buffered_calls={buffered_calls}, \
         expected_upper_bound={expected_upper_bound}(file_size={file_size})"
    );

    // 「ずっと少ない」ことを数で裏付ける(受け入れ条件)。
    assert!(
        buffered_calls * 10 < raw_calls,
        "バッファ有りの呼び出し回数がバッファ無しよりずっと少ないはず: \
         buffered_calls={buffered_calls}, raw_calls={raw_calls}"
    );
}
