use std::collections::BTreeSet;
use std::io::Cursor;

use copc_core::{LasPointRecord, NeverCancel, StreamingLayout};
use copc_writer::{write_copc_from_spill_with_fs, CopcWriterParams, MemoryScratchFs, SpillWriter};

fn synthetic_records(point_count: u32) -> Vec<LasPointRecord> {
    (0..point_count)
        .map(|i| LasPointRecord {
            x: f64::from((i * 37) % 5_000) * 0.1,
            y: f64::from((i * 53) % 5_000) * 0.1,
            z: f64::from((i * 13) % 2_000) * 0.1,
            intensity: (i % 1000) as u16,
            ..LasPointRecord::default()
        })
        .collect()
}

fn round_robin_across_workers(
    records: &[LasPointRecord],
    worker_count: usize,
) -> Vec<LasPointRecord> {
    let total = records.len();
    let base = total / worker_count;
    let mut groups: Vec<&[LasPointRecord]> = Vec::with_capacity(worker_count);
    let mut start = 0;
    for i in 0..worker_count {
        let len = if i == worker_count - 1 {
            total - start
        } else {
            base
        };
        groups.push(&records[start..start + len]);
        start += len;
    }

    let mut out = Vec::with_capacity(total);
    let mut indices = vec![0usize; worker_count];
    loop {
        let mut advanced = false;
        for (g, group) in groups.iter().enumerate() {
            if indices[g] < group.len() {
                out.push(group[indices[g]].clone());
                indices[g] += 1;
                advanced = true;
            }
        }
        if !advanced {
            break;
        }
    }
    out
}

fn push_order_and_reopen(records: &[LasPointRecord]) -> (u64, BTreeSet<(u64, u64, u64, u16)>) {
    let layout = StreamingLayout {
        point_format: 0,
        has_gps: false,
        has_color: false,
        has_nir: false,
        has_waveform: false,
        extra_bytes: 0,
        extra_bytes_descriptors: Vec::new(),
    };
    let fs = MemoryScratchFs::new();
    let mut spill = SpillWriter::create(&fs, layout, None).expect("SpillWriterを作れなかった");
    for record in records {
        spill.push(record).expect("pushに失敗した");
    }
    let reader = spill.finalize().expect("finalizeに失敗した");

    write_copc_from_spill_with_fs(
        &fs,
        std::path::Path::new("out.copc.laz"),
        reader,
        &CopcWriterParams::new(500),
        &NeverCancel,
        &Default::default(),
    )
    .expect("write_copc_from_spill_with_fsに失敗した");

    let bytes = fs
        .take_output(std::path::Path::new("out.copc.laz"))
        .expect("出力を読めなかった");

    let mut las_reader = las::Reader::new(Cursor::new(bytes)).expect("las::Readerで開けなかった");
    let mut point_data = las::PointDataBuilder::new()
        .for_header(las_reader.header())
        .build();

    let mut count = 0u64;
    let mut set = BTreeSet::new();
    loop {
        let n = las_reader
            .fill_points(65_536, &mut point_data)
            .expect("fill_pointsに失敗した");
        if n == 0 {
            break;
        }
        for result in point_data.points() {
            let point = result.expect("点のデコードに失敗した");
            set.insert((
                point.x.to_bits(),
                point.y.to_bits(),
                point.z.to_bits(),
                point.intensity,
            ));
            count += 1;
        }
    }
    (count, set)
}

#[test]
fn reordered_push_matches_sequential_push_point_set() {
    const POINT_COUNT: u32 = 20_000;
    const WORKER_COUNT: usize = 4;

    let records = synthetic_records(POINT_COUNT);
    let reordered = round_robin_across_workers(&records, WORKER_COUNT);
    assert_eq!(
        reordered.len(),
        records.len(),
        "並べ替え後も点数は変わらないはず"
    );

    let (sequential_count, sequential_set) = push_order_and_reopen(&records);
    let (reordered_count, reordered_set) = push_order_and_reopen(&reordered);

    assert_eq!(sequential_count, u64::from(POINT_COUNT));
    assert_eq!(
        sequential_count, reordered_count,
        "順序を変えてpushすると点数が変わった"
    );
    assert_eq!(
        sequential_set, reordered_set,
        "順序を変えてpushすると座標+intensityの集合が変わった \
         (SpillWriter::pushが順序に依存する処理をしている可能性がある)"
    );
}
