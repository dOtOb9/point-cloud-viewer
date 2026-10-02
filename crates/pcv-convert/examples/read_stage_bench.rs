//! 変換の「読み込み」段階の内訳を測る。
//!
//! ```text
//! cargo run -p pcv-convert --release --example read_stage_bench -- <file.las|.laz>
//! ```
//!
//! # なぜこれを測るか
//!
//! `TaskSheets/ADR-0007-pcv-protocol-concurrency.md`は「並列度だけを上げて、
//! 1回あたりのコストを疑わなかった」失敗を記録している(並行数を上げても
//! 頭打ちになり、原因は1ノードあたりの読み出しコストそのものだった)。
//! LAZ展開の並列化に進む前に、同じ轍を踏まないよう、まず
//! 「読み込み」段階(`crates/pcv-convert/src/streaming.rs`の`convert`が
//! `write_streaming_with_cancel`に点を渡すまでの区間)の時間が何に
//! 使われているかを、次の3つに分けて測る。
//!
//! 1. **入力の読み込み(ファイルI/O)**: `std::fs::read`でファイル全体を
//!    バイト列として読む時間。ディスクから読む部分だけを測りたいので、
//!    解凍(LAZ展開)やパースは一切行わない。
//! 2. **LAZの展開**: 1.で得たバイト列を`std::io::Cursor`に包み、
//!    ディスクI/Oを一切発生させない状態で`las::Reader`に読ませ、
//!    全点を`fill_points`で読み切る(点は捨てる)。ディスクI/Oがゼロの
//!    状態での所要時間なので、LAZ展開+lasクレートのレコード組み立て
//!    (点ごとの軽いパース)のコストをほぼそのまま表す。
//! 3. **点を`copc-writer`に渡して一時ファイルに書く部分**: ディスクから
//!    読みながら(1.+2.相当の処理を経て)、`copc_writer::SpillWriter::push`
//!    でspillへ書く。`fill_points`呼び出しにかかった時間と`push`呼び出しに
//!    かかった時間を、ループの中でそれぞれ別の`Duration`に積算することで、
//!    「読み込み(ディスクI/O+LAZ展開)」と「spillへの書き込み」を直接
//!    分離して測る(推測ではなく、実際にその呼び出しを包んだ時間)。
//!
//! 参考として、読み込みの後の段階(octreeの構築・書き出し。
//! `write_copc_from_spill_with_fs`の1回の呼び出し)の時間も測る。
//!
//! 出力(変換結果・spill)は`std::env::temp_dir()`配下に書き、
//! プログラム終了時に消す(リポジトリには何もコミットしない)。

use std::io::Cursor;
use std::path::Path;
use std::time::{Duration, Instant};

use copc_core::{LasPointRecord, StreamingLayout};
use copc_writer::{write_copc_from_spill_with_fs, CopcWriterParams, NativeScratchFs, SpillWriter};
use pcv_convert::write_metadata::copc_write_metadata_from_source_header;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(path) = args.first() else {
        eprintln!("usage: read_stage_bench <file.las|.laz>");
        std::process::exit(2);
    };
    let path = Path::new(path);
    let name = path.file_name().unwrap_or_default().to_string_lossy();

    // --- 1. 入力の読み込み(ファイルI/O) ---
    let io_start = Instant::now();
    let bytes = std::fs::read(path).expect("ファイルを読めなかった");
    let io_elapsed = io_start.elapsed();
    let file_mib = bytes.len() as f64 / (1024.0 * 1024.0);

    println!("{name}  ファイルサイズ: {file_mib:.1} MiB");
    println!();
    println!("[1] 入力の読み込み(ファイルI/O、std::fs::read):");
    println!(
        "    {:>8.3} 秒  ({:>7.1} MiB/秒)",
        io_elapsed.as_secs_f64(),
        file_mib / io_elapsed.as_secs_f64()
    );

    // --- 2. LAZの展開(ディスクI/Oゼロ、メモリ上のバイト列から読む) ---
    // `las::Reader::new`は`R: 'static`を要求するため、バイト列を複製して
    // 所有権を渡す(複製自体はメモリコピーのみでディスクI/Oを伴わないため、
    // 計測対象には含めない=計測区間の外で行う)。
    let bytes_owned = bytes.clone();
    let cursor = Cursor::new(bytes_owned);
    let mut reader = las::Reader::new(cursor).expect("las::Readerを開けなかった");
    let total_points = reader.header().number_of_points();
    let mut point_data = las::PointDataBuilder::new()
        .for_header(reader.header())
        .build();

    let decompress_start = Instant::now();
    let mut decompressed_points: u64 = 0;
    loop {
        let count = reader
            .fill_points(READ_BATCH_SIZE, &mut point_data)
            .expect("fill_pointsに失敗した(メモリ上の読み出し)");
        if count == 0 {
            break;
        }
        for result in point_data.points() {
            result.expect("点のデコードに失敗した");
            decompressed_points += 1;
        }
    }
    let decompress_elapsed = decompress_start.elapsed();

    println!();
    println!("[2] LAZの展開(ディスクI/Oゼロ、メモリ上のバイト列から読む):");
    println!(
        "    {:>8.3} 秒  ({} 点, {:>10.0} 点/秒)",
        decompress_elapsed.as_secs_f64(),
        decompressed_points,
        decompressed_points as f64 / decompress_elapsed.as_secs_f64()
    );
    assert_eq!(
        decompressed_points, total_points,
        "展開した点数がヘッダーの申告点数と一致しない"
    );

    // --- 3. 点をcopc-writerに渡して一時ファイルに書く部分(ディスクから読みながら) ---
    let bench_dir =
        std::env::temp_dir().join(format!("pcv-read-stage-bench-{}", std::process::id()));
    std::fs::create_dir_all(&bench_dir).expect("ベンチ用一時ディレクトリを作れなかった");
    let fs = NativeScratchFs::new(&bench_dir);

    let mut disk_reader = las::Reader::new(std::io::BufReader::new(
        std::fs::File::open(path).expect("入力を開けなかった"),
    ))
    .expect("las::Readerを開けなかった(ディスク)");
    let layout = StreamingLayout::from_las_header(disk_reader.header());
    let metadata = copc_write_metadata_from_source_header(disk_reader.header());
    let mut disk_point_data = las::PointDataBuilder::new()
        .for_header(disk_reader.header())
        .build();

    let mut spill = SpillWriter::create(&fs, layout).expect("SpillWriterを作れなかった");

    let mut read_time = Duration::ZERO;
    let mut spill_time = Duration::ZERO;
    let mut points_written: u64 = 0;
    loop {
        let read_start = Instant::now();
        let count = disk_reader
            .fill_points(READ_BATCH_SIZE, &mut disk_point_data)
            .expect("fill_pointsに失敗した(ディスク読み出し)");
        read_time += read_start.elapsed();
        if count == 0 {
            break;
        }
        for result in disk_point_data.points() {
            let point = result.expect("点のデコードに失敗した");
            let record = LasPointRecord::from_las_point(&point);
            let push_start = Instant::now();
            spill.push(&record).expect("spillへの書き込みに失敗した");
            spill_time += push_start.elapsed();
            points_written += 1;
        }
    }
    let read_stage_total = read_time + spill_time;

    println!();
    println!("[3] 読み込み段階の内訳(ディスクから読みながらspillへ書く、実測):");
    println!(
        "    fill_points合計(ディスクI/O+LAZ展開): {:>8.3} 秒",
        read_time.as_secs_f64()
    );
    println!(
        "    spill.push合計(一時ファイルへの書き込み): {:>8.3} 秒",
        spill_time.as_secs_f64()
    );
    println!(
        "    読み込み段階合計:                        {:>8.3} 秒  ({} 点)",
        read_stage_total.as_secs_f64(),
        points_written
    );

    // --- 参考: 読み込みの後の段階(octreeの構築・書き出し) ---
    let spill_reader = spill.finalize().expect("spillの確定に失敗した");
    let params = CopcWriterParams::new(100_000);
    let output_path = bench_dir.join("bench-output.copc.laz");

    let postprocess_start = Instant::now();
    write_copc_from_spill_with_fs(
        &fs,
        &output_path,
        spill_reader,
        &params,
        &copc_core::NeverCancel,
        &metadata,
    )
    .expect("write_copc_from_spill_with_fsに失敗した");
    let postprocess_elapsed = postprocess_start.elapsed();

    println!();
    println!("[参考] 読み込みの後の段階(octree構築・書き出し):");
    println!("    {:>8.3} 秒", postprocess_elapsed.as_secs_f64());

    let total = io_elapsed + read_stage_total + postprocess_elapsed;
    println!();
    println!("--- まとめ ---");
    println!(
        "読み込み段階に占めるLAZ展開の割合(目安): [2]の時間 / [3]のfill_points合計 = {:.1}%",
        decompress_elapsed.as_secs_f64() / read_time.as_secs_f64() * 100.0
    );
    println!(
        "読み込み段階の合計([3]) vs 後処理([参考]): {:.3}秒 vs {:.3}秒 (比 {:.2})",
        read_stage_total.as_secs_f64(),
        postprocess_elapsed.as_secs_f64(),
        read_stage_total.as_secs_f64() / postprocess_elapsed.as_secs_f64()
    );
    println!("(参考)[1]+[3]+[参考]の合計: {:.3}秒", total.as_secs_f64());

    // 後始末: ベンチ用の一時ファイル・出力は残さない。
    let _ = std::fs::remove_dir_all(&bench_dir);
}

/// `crates/pcv-convert/src/streaming.rs`の`READ_BATCH_SIZE`と同じ値
/// (本番の読み込みと同じ粒度で測るため)。
const READ_BATCH_SIZE: u64 = 64 * 1024;
