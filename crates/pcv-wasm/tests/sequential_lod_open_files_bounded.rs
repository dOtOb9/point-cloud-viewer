//! M4-11(`TaskSheets/M4-import-and-conversion.md`)の調査・回帰テスト:
//! **逐次**(`parallel-lod`フィーチャを使わない既定ビルド)のoctree分割
//! (`vendor/copc-writer`の`lod.rs`、`build_lod_index`)が、変換中に
//! **同時に開く一時ファイルの最大数**を測る。
//!
//! # なぜこのクレートに置くか
//!
//! `vendor/copc-writer/`・`crates/pcv-convert/`は並行作業中の別エージェント
//! (後処理の圧縮の並列化・PCDテストデータ作り)の担当のため触らない
//! (コーディネーターの指示)。`vendor/copc-writer`には既に並列版を測る
//! `tests/parallel_lod_open_files_bounded.rs`(`required-features =
//! ["parallel-lod"]`)があるが、これは**並列**版(`rayon`でルート直下を並列化)
//! を測るものであり、Web版が実際に使う**逐次**版(`crates/pcv-wasm`は
//! `copc-writer`に`default-features = false`で依存しており、`parallel-lod`は
//! 有効化していない)の数値はそこには無い。
//!
//! `copc-writer`の`MemoryScratchFs`・`write_copc_from_spill_with_fs`・
//! `SpillWriter`はすべて`pub`な公開APIで、`crates/pcv-wasm/tests/
//! memory_scratch_conversion.rs`が既に同じ依存(`default-features = false`)で
//! 使っている。本テストもその依存経由で「逐次版が同時に開く一時ファイル数」を
//! 測る(`vendor/copc-writer`自体のソースは一切変更しない)。
//!
//! # 測り方(ソースを読んで導いた理論値)
//!
//! `vendor/copc-writer/src/lod.rs`の`assign`(逐次の再帰関数、`#[cfg(not(feature
//! = "parallel-lod"))]`版)を読むと、ある時点で開いている一時ファイルは次の
//! 3種類に限られる:
//!
//! 1. 現在処理中のノードに至る**祖先**それぞれの`run.reader`(1個ずつ、
//!    末端までの再帰が終わるまで保持され続ける。Rustの所有権どおり、
//!    `assign`が値として受け取った`run`はその呼び出しがreturnするまで
//!    dropされない)
//! 2. 祖先の各レベルで、`partition_index_run`が返した最大8個の子
//!    (`children`配列)のうち、**まだ再帰していない兄弟**(配列に残った
//!    まま、そのレベルの`assign`が終わるまで保持される)
//! 3. 現在のレベルで`partition_index_run`が新しく開いている
//!    **最大8個の書き込み中パーティション**(1回の線形スキャンの間、
//!    データ次第で8オクタント全部が同時に書き込み中になりうる)
//!
//! つまり深さ`D`まで降りた時点のピークは、各レベルで「祖先1個+未処理の
//! 兄弟(最大7個)」=最大8個が積み上がり、現在のレベルでさらに最大8個が
//! 増える。加えて全体を通して開いたままの`order`書き込み用一時ファイルが
//! 1個ある。**理論上の上限は `8 * (D + 1) + 1` 程度**になるはずで、これを
//! `points_forcing_depth`が作る「8分木が実際に深さDまでフル分岐する」
//! 人工データで確かめる。
//!
//! `points_forcing_depth(depth)`は、各レベルで7個の"番兵"点(各レベルの
//! 中心のすぐ外側に1点だけ置き、即座に葉になる)と、常に「0番オクタント
//! (全軸で下側)」に留まり続ける"本流"の2点(ちょうど`max_points_per_node`
//! =2個になった時点で`depth`レベル目の葉として止まる)を使い、点数
//! `7*depth + 4`程度の小さい入力で、8分木がちょうど`depth`段フル分岐する
//! 状況を再現する(詳細は関数のコメント参照)。

use std::io::{Read, Result as IoResult, Seek, SeekFrom, Write};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use copc_core::{LasPointRecord, NeverCancel, Result, StreamingLayout};
use copc_writer::{
    write_copc_from_spill_with_fs, CopcWriteMetadata, CopcWriterParams, MemoryScratchFs, ScratchFs,
    ScratchReader, ScratchWriter, SpillWriter,
};

/// 「現在何個の一時ファイルが開いているか」とそのピークを数える
/// (`vendor/copc-writer/tests/parallel_lod_open_files_bounded.rs`と
/// 同じ考え方。コピーして使っているが、理由は上記のとおり
/// `vendor/copc-writer`自体には触れないため)。
#[derive(Clone, Default)]
struct OpenFileTracker {
    current: Arc<AtomicUsize>,
    peak: Arc<AtomicUsize>,
}

impl OpenFileTracker {
    fn opened(&self) -> OpenGuard {
        let now = self.current.fetch_add(1, Ordering::SeqCst) + 1;
        self.peak.fetch_max(now, Ordering::SeqCst);
        OpenGuard(self.current.clone())
    }

    fn peak(&self) -> usize {
        self.peak.load(Ordering::SeqCst)
    }
}

struct OpenGuard(Arc<AtomicUsize>);

impl Drop for OpenGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

struct TrackingScratchFs {
    inner: MemoryScratchFs,
    tracker: OpenFileTracker,
}

impl ScratchFs for TrackingScratchFs {
    fn create_temp(&self, label: &str) -> Result<Box<dyn ScratchWriter>> {
        Ok(Box::new(TrackingScratchWriter {
            inner: self.inner.create_temp(label)?,
            guard: Some(self.tracker.opened()),
        }))
    }

    fn create_output(&self, final_path: &Path) -> Result<Box<dyn ScratchWriter>> {
        // 出力ファイルは1個しかできないので、このテストの関心事(一時ファイルの
        // 同時オープン数)には数えない。
        self.inner.create_output(final_path)
    }
}

struct TrackingScratchWriter {
    inner: Box<dyn ScratchWriter>,
    guard: Option<OpenGuard>,
}

impl Write for TrackingScratchWriter {
    fn write(&mut self, buf: &[u8]) -> IoResult<usize> {
        self.inner.write(buf)
    }

    fn flush(&mut self) -> IoResult<()> {
        self.inner.flush()
    }
}

impl Seek for TrackingScratchWriter {
    fn seek(&mut self, pos: SeekFrom) -> IoResult<u64> {
        self.inner.seek(pos)
    }
}

impl ScratchWriter for TrackingScratchWriter {
    fn finish_temp(mut self: Box<Self>) -> Result<Box<dyn ScratchReader>> {
        let guard = self.guard.take();
        let inner = self.inner.finish_temp()?;
        Ok(Box::new(TrackingScratchReader {
            inner,
            _guard: guard,
        }))
    }

    fn finish_output(self: Box<Self>) -> Result<()> {
        self.inner.finish_output()
    }
}

struct TrackingScratchReader {
    inner: Box<dyn ScratchReader>,
    _guard: Option<OpenGuard>,
}

impl ScratchReader for TrackingScratchReader {
    fn open_at(&self, offset: u64) -> Result<Box<dyn Read + Send>> {
        self.inner.open_at(offset)
    }

    fn read_at(&self, offset: u64, buf: &mut [u8]) -> Result<()> {
        self.inner.read_at(offset, buf)
    }

    fn len(&self) -> Result<u64> {
        self.inner.len()
    }
}

fn point_at(x: f64, y: f64, z: f64) -> LasPointRecord {
    LasPointRecord {
        x,
        y,
        z,
        return_number: 1,
        number_of_returns: 1,
        ..LasPointRecord::default()
    }
}

/// 8分木がちょうど`depth`段フル分岐する人工点群を作る(モジュールドキュメント
/// 参照)。`max_points_per_node`は2固定にする(本流2点がちょうど収まる値)。
///
/// 座標の作り方: ルート(レベル0)の中心を0、半径を`h0`とし、標準的な
/// 8分木の再帰的ハーフ分割(子の半径=親の半径/2、子の中心=親の中心±親の
/// 半径/2)を仮定して、各レベルの中心`centers[i]`・半径`halfsizes[i]`を
/// 事前に計算する(`centers[0]=0`、`halfsizes[i] = halfsizes[i-1]/2`、
/// `centers[i] = centers[i-1] - halfsizes[i]` = "常に負方向(0番オクタント)へ
/// 進む経路"を仮定した式)。
///
/// - **本流(2点)**: `(-h0+ε, -h0+ε, -h0+ε)`と`(-h0, -h0, -h0)`。εは
///   `depth`より十分深いレベルまで0番オクタントに留まるよう極小にしてある。
///   `depth`段分岐した後、この2点だけが残りちょうど`max_points_per_node`
///   (2)に収まり、それ以上分割されない
/// - **番兵(レベルごとに7点)**: レベル`i`の番兵は、軸の組み合わせ
///   (1〜7の3bitパターン)ごとに、flipする軸は`centers[i]+eps_i`
///   (`eps_i = halfsizes[i]/4`、レベル`i`の中心のすぐ外側かつレベル`i-1`
///   の中心より内側になるよう選んだ値)、flipしない軸は本流と同じ値にする。
///   これにより、レベル`i`を処理する時点では「本流+未来のレベルの番兵」が
///   0番オクタントに残り、レベル`i`の番兵7個がそれぞれ別のオクタント(1〜7)
///   に1点ずつ入り、**8オクタント全部が同時に(1回の線形スキャンの中で)
///   書き込み中になる**(worst case)
/// - 原点から`(h0,h0,h0)`の1点を追加し、`cube_from_bounds`が計算する
///   バウンディングボックスを`[-h0,h0]^3`(中心0・半径h0)に固定する
fn points_forcing_depth(depth: u32) -> Vec<LasPointRecord> {
    let h0 = 1_000_000.0f64;
    let depth_usize = depth as usize;
    let mut centers = vec![0.0f64; depth_usize + 1];
    let mut halfsizes = vec![h0; depth_usize + 1];
    for i in 1..=depth_usize {
        halfsizes[i] = halfsizes[i - 1] / 2.0;
        centers[i] = centers[i - 1] - halfsizes[i];
    }

    let mut points = Vec::new();

    // バウンディングボックスを[-h0,h0]^3に固定するアンカー。
    points.push(point_at(h0, h0, h0));

    // 本流: depthより十分小さいεで、常に0番オクタントへ留まり続ける2点。
    let main_eps = h0 / 2f64.powi(depth as i32 + 10);
    let main = -h0 + main_eps;
    points.push(point_at(main, main, main));
    points.push(point_at(-h0, -h0, -h0));

    // レベルiごとの番兵7点。
    for i in 0..depth_usize {
        let c = centers[i];
        let eps = halfsizes[i] / 4.0;
        let flipped = c + eps;
        for pattern in 1u8..8 {
            let x = if pattern & 1 != 0 { flipped } else { main };
            let y = if pattern & 2 != 0 { flipped } else { main };
            let z = if pattern & 4 != 0 { flipped } else { main };
            points.push(point_at(x, y, z));
        }
    }
    points
}

/// `depth`段フル分岐する人工点群を変換し、同時に開いていた一時ファイル数の
/// ピークを返す。
fn peak_open_temp_files_at_depth(depth: u32) -> usize {
    let tracker = OpenFileTracker::default();
    let fs = TrackingScratchFs {
        inner: MemoryScratchFs::new(),
        tracker: tracker.clone(),
    };

    let layout = StreamingLayout {
        point_format: 0,
        has_gps: false,
        has_color: false,
        has_nir: false,
        has_waveform: false,
        extra_bytes: 0,
        extra_bytes_descriptors: Vec::new(),
    };
    let mut spill = SpillWriter::create(&fs, layout).expect("SpillWriter::create");
    for point in points_forcing_depth(depth) {
        spill.push(&point).expect("spill.push");
    }
    let spill_reader = spill.finalize().expect("spill.finalize");

    let output_path = Path::new("depth-bounded.copc.laz");
    write_copc_from_spill_with_fs(
        &fs,
        output_path,
        spill_reader,
        &CopcWriterParams::new(2),
        &NeverCancel,
        &CopcWriteMetadata::default(),
    )
    .expect("write_copc_from_spill_with_fs");

    tracker.peak()
}

/// 深さ0では、バウンディングボックス固定用のアンカー`(h0,h0,h0)`が本流2点と
/// 別オクタントに入るため、ルートで1回だけ不可避の分割が起きる
/// (本流2点が収まる葉1つ+アンカー1点の葉1つ)。この最小構成でもピークが
/// `8*1+1`(1レベル分の理論上限)を超えないことを確かめる。
#[test]
fn depth_zero_has_minimal_peak() {
    let peak = peak_open_temp_files_at_depth(0);
    const ONE_LEVEL_UPPER_BOUND: usize = 8 + 1;
    assert!(
        peak <= ONE_LEVEL_UPPER_BOUND,
        "深さ0(アンカーによる不可避の1回の分割のみ)のピーク{peak}が理論上限を超えた"
    );
}

/// 深さが増えるほどピークが線形に増え、モジュールドキュメントが導いた
/// 理論上の上限 `8 * (depth + 1) + 1` を超えないことを確かめる。
#[test]
fn peak_grows_linearly_with_depth_not_with_point_count() {
    let mut peaks = Vec::new();
    for depth in [0u32, 1, 2, 3, 5, 8, 12, 16] {
        let peak = peak_open_temp_files_at_depth(depth);
        let theoretical_upper_bound = 8 * (depth as usize + 1) + 1;
        assert!(
            peak <= theoretical_upper_bound,
            "depth={depth}: ピーク{peak}が理論上の上限{theoretical_upper_bound}を超えた"
        );
        peaks.push((depth, peak));
    }
    let (_, deepest_peak) = *peaks.last().unwrap();
    assert!(
        deepest_peak <= 8 * 17 + 1,
        "深さ16のピーク({deepest_peak})が理論上の上限を超えた(詳細: {peaks:?})"
    );
    // `cargo test -- --nocapture`で実測値を見るための出力
    // (TaskSheets/M4-import-and-conversion.mdの調査結果に転記した)。
    println!("sequential build_lod_index peak open temp files by depth: {peaks:?}");
}
