//! COPC write orchestration: entry points, chunk emission, and file assembly.
//!
//! M4-6a(`TaskSheets/M4-import-and-conversion.md`参照)で、出力ファイルの
//! 書き出し(`PendingOutput`)を`crate::scratch::ScratchFs`トレイト経由に
//! 差し替えた。公開関数の署名は変えていない(`pcv-convert`側は無変更で動く)。
//! `native-fs`フィーチャ(既定オン)が無効だと、`NativeScratchFs`に依存する
//! 公開関数(`write_source`・`write_streaming_with_cancel`・
//! `convert_las_to_copc_streaming*`)自体がビルドから外れる
//! (`wasm32-unknown-unknown`向けにメモリ実装だけでビルドできるかを
//! 確かめるため)。

use std::io::{BufReader, BufWriter, Seek, SeekFrom, Write};
use std::path::Path;
use std::time::Duration;

use byteorder::{LittleEndian, WriteBytesExt};
use copc_core::{
    Bounds, CancelCheck, CopcInfo, Error, LasPointRecord, Result, StreamingLayout, VoxelKey,
    MAX_EVLR_COUNT, MAX_VLR_COUNT,
};
use las::point::Format as LasFormat;
use laz::LazVlrBuilder;
// 2026-10-07の緊急修正: `std::time::Instant::now()`はwasm32-unknown-unknownでは
// panicする(`metadata.rs`冒頭のコメント参照)。`write_copc_from_spill_with_fs`
// (pcv-wasmが呼ぶ本番の変換経路)は`stage_timings`に常に`None`を渡すので
// 計測自体は要らないはずだったが、このファイルの`Instant::now()`呼び出しは
// 元々`stage_timings`の有無にかかわらず**無条件に**実行されていた
// (「`None`のときは呼び出しさえ発生しない」という104行目付近のコメントは
// 誤りだった。実際に計測を使うかどうかは`elapsed()`を呼ぶかどうかでしか
// 分岐していなかった)。`web_time::Instant`に替えることで、計測の有無に
// 関わらずwasm32でも安全に呼べるようにする(`metadata.rs`のコメント・
// `TaskSheets/M4-import-and-conversion.md`のM4-8追記参照)。
use web_time::Instant;

use crate::hierarchy_pages::{
    assign_hierarchy_page_offsets, plan_hierarchy_pages, write_hierarchy_page_tree,
};
use crate::las_out::{
    regular_las_vlrs_bytes, write_evlr_header, write_las_evlr, write_las_vlr, write_vlr_header,
    LasHeader, LAS_EVLR_HEADER_BYTES, LAS_VLR_HEADER_BYTES,
};
use crate::lod::{cube_from_bounds, LodParams, RunTask};
use crate::metadata::{
    CopcWriteMetadata, OutputLasMetadata, LASZIP_VLR_RECORD_ID, LASZIP_VLR_USER_ID,
};
use crate::node_pipeline::{write_chunks, NodeContext, PartitionClock};
use crate::scratch::ScratchFs;
use crate::source::{record_from_fields, CopcPointFields, CopcPointSource};
use crate::spill::{SpillReader, SpillWriter};
use crate::validate::{
    quantize_xyz, scan_angle_to_las_scaled, validate_source_points,
    validate_streaming_layout_supported, validate_write_setup,
};
use crate::CANCEL_POLL_STRIDE;

#[cfg(feature = "native-fs")]
use crate::metadata::read_all_source_evlrs;
#[cfg(feature = "native-fs")]
use crate::scratch::NativeScratchFs;
#[cfg(feature = "native-fs")]
use crate::validate::validate_las_conversion_supported;
#[cfg(feature = "native-fs")]
use copc_core::NeverCancel;

const LAS_INPUT_BUFFER_BYTES: usize = 1024 * 1024;
const COPC_OUTPUT_BUFFER_BYTES: usize = 1024 * 1024;
const LAS_POINT_BATCH_SIZE: u64 = 64 * 1024;

/// Tuning parameters for COPC writes.
#[derive(Debug, Clone, Copy)]
#[non_exhaustive]
pub struct CopcWriterParams {
    /// Target maximum number of points per octree node (one LAZ chunk). The
    /// octree subdivides until nodes fit this budget, up to an internal depth
    /// cap that keeps voxel keys in range.
    pub max_points_per_node: u32,
    /// M4-10(`TaskSheets/M4-import-and-conversion.md`): ノードごとのLAZ圧縮を
    /// `rayon`で並列に行うかどうか。`new()`の既定値は、`parallel-compress`
    /// フィーチャが有効ならtrue、無効なら(そもそも並列実装がコンパイルされて
    /// いないため)常にfalse扱いになる(`compress_nodes_dispatch`参照)。
    ///
    /// このフィールドを公開しているのは、同じビルド内で逐次・並列の両方の
    /// 経路をテストから選べるようにするため(逐次のバイト一致回帰テストと、
    /// 並列の点集合一致テストを同じcrateで両立させる。`crates/pcv-convert/
    /// tests/streaming_conversion.rs`参照)。本番の呼び出し側(`pcv-convert`)は
    /// このフィールドを変更せず、既定値(featureが有効なら並列)のまま使う。
    pub parallel_node_compression: bool,
    /// ADR-0019: memory the conversion may use to finish octree subtrees in
    /// memory (the records of all subtrees being built at the same moment,
    /// counted twice because a subtree is split into a second set of
    /// buffers). A run of point records that fits its share is loaded and
    /// finished in memory; a bigger one is split on disk first. The default
    /// is 1 GiB on desktop, 256 MiB on Android and 64 MiB on Web. This is not
    /// a hard limit on the whole process: compression buffers, the read
    /// buffers of the disk passes and the compressed chunks waiting to be
    /// written come on top, but none of them grows with the point count.
    pub memory_budget_bytes: u64,
    /// ADR-0019: how many octree subtrees are built and compressed at the
    /// same time (worker threads). The default is the number of logical CPUs,
    /// at most 8, and 1 when `parallel-compress` is off (Web). Each subtree
    /// gets `memory_budget_bytes / (2 * this)` of records. It is ignored (1
    /// is used) when `parallel_node_compression` is false.
    pub max_concurrent_subtrees: usize,
}

/// Default for `CopcWriterParams::memory_budget_bytes`.
fn default_memory_budget_bytes() -> u64 {
    if cfg!(target_arch = "wasm32") {
        64 * 1024 * 1024
    } else if cfg!(target_os = "android") {
        256 * 1024 * 1024
    } else {
        1024 * 1024 * 1024
    }
}

/// Default for `CopcWriterParams::max_concurrent_subtrees`.
fn default_max_concurrent_subtrees() -> usize {
    if cfg!(feature = "parallel-compress") {
        std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(1)
            .min(8)
    } else {
        1
    }
}

/// Number of threads that build subtrees, from the parameters.
fn subtree_workers(params: &CopcWriterParams) -> usize {
    if cfg!(feature = "parallel-compress") && params.parallel_node_compression {
        params.max_concurrent_subtrees.max(1)
    } else {
        1
    }
}

impl CopcWriterParams {
    pub fn new(max_points_per_node: u32) -> Self {
        Self {
            max_points_per_node,
            parallel_node_compression: cfg!(feature = "parallel-compress"),
            memory_budget_bytes: default_memory_budget_bytes(),
            max_concurrent_subtrees: default_max_concurrent_subtrees(),
        }
    }

    /// Sets `memory_budget_bytes`.
    pub fn with_memory_budget_bytes(mut self, bytes: u64) -> Self {
        self.memory_budget_bytes = bytes;
        self
    }

    /// Sets `max_concurrent_subtrees`.
    pub fn with_max_concurrent_subtrees(mut self, count: usize) -> Self {
        self.max_concurrent_subtrees = count;
        self
    }

    /// ノードごとのLAZ圧縮を並列で行うかどうかを明示的に指定する
    /// (`parallel-compress`フィーチャが無効なビルドでは常に逐次にフォール
    /// バックする。`compress_nodes_dispatch`参照)。
    pub fn with_parallel_node_compression(mut self, enabled: bool) -> Self {
        self.parallel_node_compression = enabled;
        self
    }
}

impl Default for CopcWriterParams {
    fn default() -> Self {
        Self::new(100_000)
    }
}

/// 計測専用: 後処理(octree構築・ノード圧縮・書き出し)の内訳。
///
/// 本番の変換経路(`write_copc_from_spill_with_fs`・`write_streaming_with_cancel`等)は
/// これを使わない(常に`None`を渡す)。M4-8(`TaskSheets/M4-import-and-conversion.md`)の
/// 計測ハーネス(`crates/pcv-convert/examples/post_process_stage_bench.rs`)専用に、
/// `write_copc_from_spill_with_fs_and_timings`経由で使う。
///
/// **2026-10-07追記(M4-8追記、緊急修正): 以前このコメントは「`None`のときは
/// `Instant::now()`の呼び出しさえ発生しない」と書いていたが、これは誤りだった。**
/// `write_copc_inner`の4箇所の`Instant::now()`は`stage_timings`の有無に関わらず
/// **無条件に**呼ばれており、`None`かどうかで分岐していたのは`.elapsed()`を
/// 呼んで加算するかどうかだけだった。`std::time::Instant::now()`は
/// wasm32-unknown-unknownでは`time not implemented on this platform`で
/// panicするため、**Web版の変換は(ファイルサイズに関係なく)M4-8以降、
/// 常にこの箇所で失敗していた。** 詳細・修正は`TaskSheets/M4-import-and-conversion.md`
/// のM4-8追記、`Instant`の実体は`web_time::Instant`(このファイル冒頭のuse文の
/// コメント参照)。
///
/// 3つのフィールドの合計は、後処理全体(`write_copc_from_spill_with_fs`1回の呼び出し)の
/// 所要時間とほぼ一致する(計測区間に漏れが無いように、関数の実行区間を過不足なく
/// 3つに割っている)。
/// 計測専用: 変換のうち「スパイルまで」(入力の読み込み+一時ファイルへの
/// 書き込み)の内訳。M4-12(`TaskSheets/M4-import-and-conversion.md`)で、
/// `PostProcessStageTimings`と対になる形で追加した。
/// `write_streaming_with_cancel_and_timings`参照。
#[derive(Debug, Clone, Copy, Default)]
pub struct IngestStageTimings {
    /// 入力イテレータから1点を取り出すのにかかった時間の合計
    /// (ディスクI/O+LAZ展開。呼び出し側のイテレータ実装がこの区間を
    /// 丸ごと占有する)。
    pub source_read_and_decode: Duration,
    /// 取り出した点を一時ファイル(spill)へ書き込むのにかかった時間の合計
    /// (`SpillWriter::push`)。
    pub spill_write: Duration,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct PostProcessStageTimings {
    /// octreeの分割(LODの索引作り、点のノードへの振り分け。`build_lod_index`)。
    pub lod_index_build: Duration,
    /// ノードごとのLAZ圧縮(圧縮したバイト列を出力ストリームへ書く部分を含む。`compress_nodes`)。
    pub node_compression: Duration,
    /// 出力ファイルのヘッダー・VLR・hierarchyの書き出し(圧縮以外の全て)。
    pub header_and_hierarchy_write: Duration,
}

#[cfg(feature = "native-fs")]
pub fn write_source<S: CopcPointSource>(
    path: &Path,
    source: &S,
    has_color: bool,
    bounds: Bounds,
    params: &CopcWriterParams,
    metadata: &CopcWriteMetadata,
) -> Result<()> {
    write_source_with_cancel(
        path,
        source,
        has_color,
        bounds,
        params,
        metadata,
        &NeverCancel,
    )
}

#[cfg(feature = "native-fs")]
pub fn write_source_with_cancel<S: CopcPointSource>(
    path: &Path,
    source: &S,
    has_color: bool,
    bounds: Bounds,
    params: &CopcWriterParams,
    metadata: &CopcWriteMetadata,
    cancel: &(dyn CancelCheck + Sync),
) -> Result<()> {
    cancel.check()?;
    if source.is_empty() {
        return Err(Error::InvalidInput(
            "cannot write empty cloud to COPC".into(),
        ));
    }
    // The writer works on a spill (ADR-0019 carries the spill's records through
    // the octree), so a generic source is copied into one first. Temporary
    // files go to the OS temp directory; the output goes next to `path`.
    let fs = NativeScratchFs::new(std::env::temp_dir());
    // A generic source has not been validated at spill intake, so run the full
    // check first (points inside the declared bounds, encodable coordinates).
    let output_metadata = metadata.to_output();
    let offset = output_metadata
        .offset
        .unwrap_or((bounds.min.0, bounds.min.1, bounds.min.2));
    validate_write_setup(bounds, output_metadata.scale, offset)?;
    validate_source_points(source, bounds, output_metadata.scale, offset, cancel)?;
    let layout = StreamingLayout {
        point_format: if has_color { 7 } else { 6 },
        has_gps: true,
        has_color,
        has_nir: false,
        has_waveform: false,
        extra_bytes: source.extra_byte_count(),
        extra_bytes_descriptors: source.extra_bytes_vlrs().to_vec(),
    };
    let mut spill = SpillWriter::create(&fs, layout)?;
    let mut fields = CopcPointFields::default();
    for index in 0..source.len() {
        if index.is_multiple_of(CANCEL_POLL_STRIDE) {
            cancel.check()?;
        }
        source.fields_into(index, &mut fields)?;
        spill.push(&record_from_fields(&fields))?;
    }
    let reader = spill.finalize()?;
    write_copc_from_spill(
        path,
        reader,
        params,
        cancel,
        &metadata.to_output(),
        &fs,
        None,
        Some(bounds),
    )
}

#[cfg(feature = "native-fs")]
pub fn write_streaming_with_cancel<I>(
    path: &Path,
    layout: StreamingLayout,
    points: I,
    params: &CopcWriterParams,
    metadata: &CopcWriteMetadata,
    spill_dir: &Path,
    cancel: &(dyn CancelCheck + Sync),
) -> Result<()>
where
    I: IntoIterator<Item = Result<LasPointRecord>>,
{
    write_streaming_with_cancel_and_timings(
        path, layout, points, params, metadata, spill_dir, cancel, None, None,
    )
}

/// M4-12(`TaskSheets/M4-import-and-conversion.md`): `write_streaming_with_cancel`と
/// 同じ処理を行い、あわせて「読み込み(ディスクI/O+LAZ展開)」「一時ファイル
/// (spill)への書き込み」の内訳(`ingest_timings`)と、後処理の内訳
/// (`stage_timings`、既存の[`PostProcessStageTimings`])を取れる。
///
/// **本番の変換経路(デスクトップ・Android)がこの計測を使う**(以前の
/// `PostProcessStageTimings`はベンチ専用だったが、M4-12で所有者向けの
/// 「変換のどこが遅いか」の内訳表示に使うようになった)。
///
/// `ingest_timings`の2つのフィールドは、`points`イテレータから1点を取り出す
/// 区間(`source_read_and_decode`。`pcv_convert::streaming`の
/// `BatchedLasPoints::next`実装が1バッチぶんの`fill_points`+デコードを行う
/// 区間を含む)と、取り出した点を`SpillWriter::push`する区間
/// (`spill_write`)を、ループの中で`Instant`で区切って直接測るだけで、
/// アルゴリズム自体は変えていない。1点ごとに`Instant::now()`を2回余分に
/// 呼ぶ(ネイティブでは数十ns程度、`examples/read_stage_bench.rs`が
/// 同じ粒度で測っている実測と同じ桁)。
#[cfg(feature = "native-fs")]
#[allow(clippy::too_many_arguments)]
pub fn write_streaming_with_cancel_and_timings<I>(
    path: &Path,
    layout: StreamingLayout,
    points: I,
    params: &CopcWriterParams,
    metadata: &CopcWriteMetadata,
    spill_dir: &Path,
    cancel: &(dyn CancelCheck + Sync),
    mut ingest_timings: Option<&mut IngestStageTimings>,
    stage_timings: Option<&mut PostProcessStageTimings>,
) -> Result<()>
where
    I: IntoIterator<Item = Result<LasPointRecord>>,
{
    cancel.check()?;
    validate_streaming_layout_supported(&layout)?;
    // spillファイルは呼び出し側が指定した`spill_dir`に置く(今までと同じ)。
    // LOD索引はOS既定の一時ディレクトリ(`spill_dir`の指定は効かない。
    // これは改修前から変わっていない挙動で、`TaskSheets/
    // M4-import-and-conversion.md`のM4-1bが記録した既知の仕様)。
    let spill_fs = NativeScratchFs::new(spill_dir);
    let mut spill = SpillWriter::create(&spill_fs, layout)?;
    let mut iter = points.into_iter();
    let mut index = 0usize;
    loop {
        let fetch_start = Instant::now();
        let next = iter.next();
        if let Some(timings) = ingest_timings.as_mut() {
            timings.source_read_and_decode += fetch_start.elapsed();
        }
        let Some(item) = next else { break };
        if index.is_multiple_of(CANCEL_POLL_STRIDE) {
            cancel.check()?;
        }
        let record = item?;
        let push_start = Instant::now();
        spill.push(&record)?;
        if let Some(timings) = ingest_timings.as_mut() {
            timings.spill_write += push_start.elapsed();
        }
        index += 1;
    }
    cancel.check()?;
    let reader = spill.finalize()?;
    let lod_fs = NativeScratchFs::new(std::env::temp_dir());
    write_copc_from_spill(
        path,
        reader,
        params,
        cancel,
        &metadata.to_output(),
        &lod_fs,
        stage_timings,
        None,
    )
}

#[cfg(feature = "native-fs")]
pub fn convert_las_to_copc_streaming(
    las_path: &Path,
    copc_path: &Path,
    params: &CopcWriterParams,
    spill_dir: &Path,
    cancel: &(dyn CancelCheck + Sync),
) -> Result<()> {
    convert_las_to_copc_streaming_inner(las_path, copc_path, params, spill_dir, cancel, None)
}

/// Converts LAS/LAZ to COPC and emits `crs_wkt_override` as a WKT CRS VLR
/// when the source has GeoTIFF CRS records but no WKT CRS record.
#[cfg(feature = "native-fs")]
pub fn convert_las_to_copc_streaming_with_crs_wkt_override(
    las_path: &Path,
    copc_path: &Path,
    params: &CopcWriterParams,
    spill_dir: &Path,
    cancel: &(dyn CancelCheck + Sync),
    crs_wkt_override: Option<&str>,
) -> Result<()> {
    convert_las_to_copc_streaming_inner(
        las_path,
        copc_path,
        params,
        spill_dir,
        cancel,
        crs_wkt_override,
    )
}

#[cfg(feature = "native-fs")]
fn convert_las_to_copc_streaming_inner(
    las_path: &Path,
    copc_path: &Path,
    params: &CopcWriterParams,
    spill_dir: &Path,
    cancel: &(dyn CancelCheck + Sync),
    crs_wkt_override: Option<&str>,
) -> Result<()> {
    cancel.check()?;
    let las_file =
        std::fs::File::open(las_path).map_err(|e| Error::io("open source LAS/LAZ", e))?;
    let mut reader = las::Reader::new(BufReader::with_capacity(LAS_INPUT_BUFFER_BYTES, las_file))
        .map_err(|e| Error::Las(e.to_string()))?;
    let source_evlrs = read_all_source_evlrs(las_path)?;
    validate_las_conversion_supported(reader.header(), &source_evlrs, crs_wkt_override)?;
    let output_metadata =
        OutputLasMetadata::from_las_header(reader.header(), &source_evlrs, crs_wkt_override);
    let layout = StreamingLayout::from_las_header(reader.header());
    let spill_fs = NativeScratchFs::new(spill_dir);
    let mut spill = SpillWriter::create(&spill_fs, layout)?;
    let mut point_data = las::PointDataBuilder::new()
        .for_header(reader.header())
        .build();
    let mut index = 0usize;
    loop {
        let count = reader
            .fill_points(LAS_POINT_BATCH_SIZE, &mut point_data)
            .map_err(|e| Error::Las(e.to_string()))?;
        if count == 0 {
            break;
        }
        for result in point_data.points() {
            if index.is_multiple_of(CANCEL_POLL_STRIDE) {
                cancel.check()?;
            }
            let point = result.map_err(|e| Error::Las(e.to_string()))?;
            spill.push(&LasPointRecord::from_las_point(&point))?;
            index = index
                .checked_add(1)
                .ok_or_else(|| Error::InvalidInput("source point count exceeds usize".into()))?;
        }
    }
    cancel.check()?;
    let reader = spill.finalize()?;
    let lod_fs = NativeScratchFs::new(std::env::temp_dir());
    write_copc_from_spill(
        copc_path,
        reader,
        params,
        cancel,
        &output_metadata,
        &lod_fs,
        None,
        None,
    )
}

/// M4-6b(`TaskSheets/M4-import-and-conversion.md`参照)で追加した公開関数。
///
/// `write_streaming_with_cancel`(native-fsフィーチャ限定)は内部で
/// `NativeScratchFs`を組み立てて`write_copc_from_spill`を呼ぶだけなので、
/// spillを既に済ませた呼び出し側(Web版。`crates/pcv-wasm`が点の読み込みを
/// バッチ単位でTypeScript側から駆動し、`SpillWriter::create`/`push`/
/// `finalize`を自分で呼ぶ設計になっている。理由は
/// `crates/pcv-wasm/src/convert.rs`のドキュメント参照)が`&dyn ScratchFs`を
/// 直接渡せる入口が無かった。`write_copc_from_spill`自体は最初から
/// `&dyn ScratchFs`を受け取る形だった(M4-6aの改修)ので、公開ラッパーを
/// 1つ足すだけで済む。`native-fs`フィーチャの有無に関わらず常にビルドされる
/// (`tempfile`/`memmap2`には一切触れない)。
pub fn write_copc_from_spill_with_fs(
    fs: &dyn ScratchFs,
    path: &Path,
    reader: SpillReader,
    params: &CopcWriterParams,
    cancel: &(dyn CancelCheck + Sync),
    metadata: &CopcWriteMetadata,
) -> Result<()> {
    write_copc_from_spill(
        path,
        reader,
        params,
        cancel,
        &metadata.to_output(),
        fs,
        None,
        None,
    )
}

/// M4-8(`TaskSheets/M4-import-and-conversion.md`)の計測ハーネス専用。
/// `write_copc_from_spill_with_fs`と同じ処理を行い、あわせて内訳
/// ([`PostProcessStageTimings`])を返す。本番の変換経路はこちらを呼ばない。
pub fn write_copc_from_spill_with_fs_and_timings(
    fs: &dyn ScratchFs,
    path: &Path,
    reader: SpillReader,
    params: &CopcWriterParams,
    cancel: &(dyn CancelCheck + Sync),
    metadata: &CopcWriteMetadata,
) -> Result<PostProcessStageTimings> {
    let mut timings = PostProcessStageTimings::default();
    write_copc_from_spill(
        path,
        reader,
        params,
        cancel,
        &metadata.to_output(),
        fs,
        Some(&mut timings),
        None,
    )?;
    Ok(timings)
}

#[allow(clippy::too_many_arguments)]
fn write_copc_from_spill(
    path: &Path,
    reader: SpillReader,
    params: &CopcWriterParams,
    cancel: &(dyn CancelCheck + Sync),
    metadata: &OutputLasMetadata,
    fs: &dyn ScratchFs,
    mut stage_timings: Option<&mut PostProcessStageTimings>,
    bounds_override: Option<Bounds>,
) -> Result<()> {
    cancel.check()?;
    if params.max_points_per_node == 0 {
        return Err(Error::InvalidInput(
            "max_points_per_node must be greater than zero".into(),
        ));
    }
    validate_streaming_layout_supported(reader.layout())?;
    if reader.is_empty() {
        return Err(Error::InvalidInput(
            "cannot write empty cloud to COPC".into(),
        ));
    }
    // Copy what is needed from the spill reader; the reader itself is handed
    // over to the LOD builder below and the spill file goes away with it.
    let layout = reader.layout().clone();
    let has_color = layout.has_color;
    let bounds = bounds_override.unwrap_or_else(|| reader.bounds());
    let point_stats = reader.stats();
    let total_points = reader.len();
    let record_width = reader.record_width();
    let point_format_id = if has_color { 7u8 } else { 6u8 };
    let mut point_format =
        LasFormat::new(point_format_id).map_err(|e| Error::Las(format!("point format: {e}")))?;
    let extra_byte_count = layout.extra_bytes;
    let point_record_length = point_format
        .len()
        .checked_add(extra_byte_count)
        .ok_or_else(|| {
            Error::InvalidInput(format!(
                "point record length with {extra_byte_count} extra bytes exceeds LAS u16 range"
            ))
        })?;
    point_format.extra_bytes = extra_byte_count;

    let (scale_x, scale_y, scale_z) = metadata.scale;
    let (offset_x, offset_y, offset_z) =
        metadata
            .offset
            .unwrap_or((bounds.min.0, bounds.min.1, bounds.min.2));
    validate_write_setup(
        bounds,
        (scale_x, scale_y, scale_z),
        (offset_x, offset_y, offset_z),
    )?;
    // The spill validated every record and gathered the statistics at intake
    // (`point_stats`). Quantization-range failures surface while the nodes
    // are encoded, where the atomic output rename still prevents partial files.
    let (center, halfsize) = cube_from_bounds(&bounds);
    cancel.check()?;

    let header_write_start = Instant::now();
    let var_vlr = LazVlrBuilder::default()
        .with_point_format(point_format_id, extra_byte_count)
        .map_err(|e| Error::Las(format!("laz items: {e}")))?
        .with_variable_chunk_size()
        .build();
    let mut var_vlr_bytes = Vec::new();
    var_vlr
        .write_to(&mut var_vlr_bytes)
        .map_err(|e| Error::Las(format!("variable chunk LAZ VLR: {e}")))?;

    let copc_info_vlr_size = 160u16;
    let las_header_size = 375u32;
    let regular_crs_vlr_count = metadata.regular_crs_vlr_count();
    let regular_crs_vlr_bytes = metadata.regular_crs_vlr_bytes()?;
    let extra_bytes_vlrs = layout.extra_bytes_descriptors.as_slice();
    let extra_bytes_vlr_bytes = regular_las_vlrs_bytes(extra_bytes_vlrs)?;
    let pass_through_vlr_bytes = regular_las_vlrs_bytes(&metadata.pass_through_vlrs)?;
    let number_of_vlrs = u32::try_from(
        2usize
            .checked_add(regular_crs_vlr_count)
            .and_then(|count| count.checked_add(extra_bytes_vlrs.len()))
            .and_then(|count| count.checked_add(metadata.pass_through_vlrs.len()))
            .ok_or_else(|| Error::InvalidInput("VLR count overflow".into()))?,
    )
    .map_err(|_| Error::InvalidInput("VLR count overflow".into()))?;
    if number_of_vlrs > MAX_VLR_COUNT {
        return Err(Error::InvalidInput(format!(
            "output VLR count {number_of_vlrs} exceeds max supported {MAX_VLR_COUNT}"
        )));
    }
    let number_of_evlrs = u32::try_from(
        1usize
            .checked_add(metadata.source_evlr_count_after_hierarchy())
            .ok_or_else(|| Error::InvalidInput("EVLR count overflow".into()))?,
    )
    .map_err(|_| Error::InvalidInput("EVLR count overflow".into()))?;
    if number_of_evlrs > MAX_EVLR_COUNT {
        return Err(Error::InvalidInput(format!(
            "output EVLR count {number_of_evlrs} exceeds max supported {MAX_EVLR_COUNT}"
        )));
    }
    let var_vlr_body_size = u16::try_from(var_vlr_bytes.len())
        .map_err(|_| Error::InvalidInput("LAZ VLR byte size exceeds LAS VLR limit".into()))?;
    let var_vlr_storage_bytes = LAS_VLR_HEADER_BYTES
        .checked_add(u32::from(var_vlr_body_size))
        .ok_or_else(|| Error::InvalidInput("LAZ VLR byte size overflow".into()))?;
    let total_vlr_bytes = LAS_VLR_HEADER_BYTES
        .checked_add(u32::from(copc_info_vlr_size))
        .and_then(|total| total.checked_add(var_vlr_storage_bytes))
        .and_then(|total| total.checked_add(regular_crs_vlr_bytes))
        .and_then(|total| total.checked_add(extra_bytes_vlr_bytes))
        .and_then(|total| total.checked_add(pass_through_vlr_bytes))
        .ok_or_else(|| Error::InvalidInput("VLR byte size overflow".into()))?;
    let offset_to_point_data = las_header_size
        .checked_add(total_vlr_bytes)
        .ok_or_else(|| Error::InvalidInput("point data offset overflow".into()))?;

    let output_writer = fs.create_output(path)?;
    let mut writer = BufWriter::with_capacity(COPC_OUTPUT_BUFFER_BYTES, output_writer);

    let header = LasHeader {
        point_data_format: point_format_id | 0x80,
        point_record_length,
        offset_to_point_data,
        number_of_vlrs,
        file_source_id: metadata.file_source_id,
        global_encoding: metadata.global_encoding,
        guid: metadata.guid,
        system_identifier: metadata.system_identifier.clone(),
        generating_software: metadata.generating_software.clone(),
        creation_day_of_year: metadata.creation_day_of_year,
        creation_year: metadata.creation_year,
        scale: (scale_x, scale_y, scale_z),
        offset: (offset_x, offset_y, offset_z),
        bounds,
        legacy_point_count: 0,
        total_point_count: total_points as u64,
        offset_to_first_evlr: 0,
        number_of_evlrs,
        extended_return_counts: point_stats.extended_return_counts,
    };
    header.write(&mut writer)?;

    write_vlr_header(&mut writer, "copc", 1, copc_info_vlr_size, "COPC info")?;
    let copc_info_payload_start = writer
        .stream_position()
        .map_err(|e| Error::io("record COPC info payload offset", e))?;
    writer
        .write_all(&[0u8; 160])
        .map_err(|e| Error::io("write COPC info placeholder", e))?;

    write_vlr_header(
        &mut writer,
        LASZIP_VLR_USER_ID,
        LASZIP_VLR_RECORD_ID,
        var_vlr_body_size,
        "http://laszip.org",
    )?;
    writer
        .write_all(&var_vlr_bytes)
        .map_err(|e| Error::io("write LAZ VLR", e))?;

    for vlr in metadata.regular_crs_vlrs() {
        write_las_vlr(&mut writer, vlr)?;
    }
    for vlr in extra_bytes_vlrs {
        write_las_vlr(&mut writer, vlr)?;
    }
    for vlr in &metadata.pass_through_vlrs {
        write_las_vlr(&mut writer, vlr)?;
    }

    let point_data_actual_start = writer
        .stream_position()
        .map_err(|e| Error::io("record point data offset", e))?;
    if point_data_actual_start as u32 != offset_to_point_data {
        return Err(Error::InvalidInput(format!(
            "VLR size accounting mismatch: at {point_data_actual_start}, expected {offset_to_point_data}"
        )));
    }

    if let Some(timings) = stage_timings.as_mut() {
        timings.header_and_hierarchy_write += header_write_start.elapsed();
    }

    // ADR-0019: partitioning the octree on disk, building small subtrees in
    // memory and compressing the nodes are one pass now, and they overlap when
    // there are several worker threads. The timings are wall-clock time:
    // `lod_index_build` is the time during which at least one run was being
    // partitioned on disk, `node_compression` is the rest of the pass (building
    // subtrees in memory, compressing, writing the chunks).
    let node_phase_start = Instant::now();
    let workers = subtree_workers(params);
    let clock = PartitionClock::new();
    let node_ctx = NodeContext {
        layout: &layout,
        lod: LodParams {
            max_points_per_node: params.max_points_per_node as usize,
            record_width,
            in_memory_run_bytes: params.memory_budget_bytes / (2 * workers as u64),
        },
        output_record_len: usize::from(point_record_length),
        scale: (scale_x, scale_y, scale_z),
        offset: (offset_x, offset_y, offset_z),
        point_format: &point_format,
        var_vlr: &var_vlr,
        cancel,
        fs,
        clock: &clock,
    };
    let root_task = RunTask {
        key: VoxelKey::root(),
        bounds: Bounds::cube(center, halfsize),
        run: reader.into_run(),
        counts: None,
    };
    let written = write_chunks(&mut writer, &node_ctx, workers, root_task)?;

    let hierarchy = written.hierarchy;
    if let Some(timings) = stage_timings.as_mut() {
        let node_phase = node_phase_start.elapsed();
        timings.lod_index_build += written.disk_partition_time;
        timings.node_compression += node_phase.saturating_sub(written.disk_partition_time);
    }

    let hierarchy_write_start = Instant::now();
    let hierarchy_evlr_start = writer
        .stream_position()
        .map_err(|e| Error::io("record hierarchy EVLR start", e))?;
    let root_hier_offset = hierarchy_evlr_start
        .checked_add(LAS_EVLR_HEADER_BYTES)
        .ok_or_else(|| Error::InvalidInput("hierarchy EVLR offset overflow".into()))?;
    let mut hierarchy_pages = plan_hierarchy_pages(&hierarchy, VoxelKey::root())?;
    let hierarchy_end = assign_hierarchy_page_offsets(&mut hierarchy_pages, root_hier_offset)?;
    let hierarchy_body_size = hierarchy_end
        .checked_sub(root_hier_offset)
        .ok_or_else(|| Error::InvalidInput("hierarchy size overflow".into()))?;
    write_evlr_header(
        &mut writer,
        "copc",
        1000,
        hierarchy_body_size,
        "COPC hierarchy",
    )?;
    let actual_root_hier_offset = writer
        .stream_position()
        .map_err(|e| Error::io("record root hierarchy offset", e))?;
    if actual_root_hier_offset != root_hier_offset {
        return Err(Error::InvalidInput(format!(
            "hierarchy offset accounting mismatch: at {actual_root_hier_offset}, expected {root_hier_offset}"
        )));
    }
    write_hierarchy_page_tree(&mut writer, &hierarchy_pages)?;
    for evlr in metadata.source_evlrs_after_hierarchy() {
        write_las_evlr(&mut writer, evlr)?;
    }

    writer
        .seek(SeekFrom::Start(copc_info_payload_start))
        .map_err(|e| Error::io("seek COPC info payload", e))?;
    let info = CopcInfo {
        center,
        halfsize,
        spacing: halfsize / 128.0,
        root_hier_offset,
        root_hier_size: hierarchy_pages.byte_size,
        gpstime_min: point_stats.gpstime_min,
        gpstime_max: point_stats.gpstime_max,
    };
    let info_bytes = info.write_le_bytes()?;
    writer
        .write_all(&info_bytes)
        .map_err(|e| Error::io("patch COPC info", e))?;

    writer
        .seek(SeekFrom::Start(235))
        .map_err(|e| Error::io("seek first EVLR offset", e))?;
    writer
        .write_u64::<LittleEndian>(hierarchy_evlr_start)
        .map_err(|e| Error::io("patch first EVLR offset", e))?;

    writer
        .flush()
        .map_err(|e| Error::io("flush COPC file", e))?;
    let output_writer = writer
        .into_inner()
        .map_err(|e| Error::io("flush COPC file", e.into_error()))?;
    output_writer.finish_output()?;
    if let Some(timings) = stage_timings.as_mut() {
        timings.header_and_hierarchy_write += hierarchy_write_start.elapsed();
    }
    Ok(())
}

/// Encode one point directly into the PDRF 6/7 record layout, avoiding the
/// per-point `las::raw::Point` construction (and its `extra_bytes` clone) in
/// the hot compression loop.
pub(crate) fn encode_point_record(
    buf: &mut [u8],
    fields: &CopcPointFields,
    scale: (f64, f64, f64),
    offset: (f64, f64, f64),
    point_index: usize,
    format: &LasFormat,
) -> Result<()> {
    debug_assert!(format.is_extended && !format.has_nir && !format.has_waveform);
    debug_assert_eq!(usize::from(format.len()), buf.len());
    let (ix, iy, iz) = quantize_xyz(point_index, fields.x, fields.y, fields.z, scale, offset)?;
    buf[0..4].copy_from_slice(&ix.to_le_bytes());
    buf[4..8].copy_from_slice(&iy.to_le_bytes());
    buf[8..12].copy_from_slice(&iz.to_le_bytes());
    buf[12..14].copy_from_slice(&fields.intensity.to_le_bytes());
    buf[14] = fields.return_number | (fields.number_of_returns << 4);
    buf[15] = fields.synthetic
        | (fields.key_point << 1)
        | (fields.withheld << 2)
        | (fields.overlap << 3)
        | (fields.scan_channel << 4)
        | (fields.scan_direction_flag << 6)
        | (fields.edge_of_flight_line << 7);
    buf[16] = fields.classification;
    buf[17] = fields.user_data;
    buf[18..20].copy_from_slice(&scan_angle_to_las_scaled(fields.scan_angle).to_le_bytes());
    buf[20..22].copy_from_slice(&fields.point_source_id.to_le_bytes());
    buf[22..30].copy_from_slice(&fields.gps_time.to_le_bytes());
    let mut cursor = 30;
    if format.has_color {
        buf[30..32].copy_from_slice(&fields.red.to_le_bytes());
        buf[32..34].copy_from_slice(&fields.green.to_le_bytes());
        buf[34..36].copy_from_slice(&fields.blue.to_le_bytes());
        cursor = 36;
    }
    if fields.extra_bytes.len() != buf.len() - cursor {
        return Err(Error::InvalidInput(format!(
            "point {point_index} has {} extra byte(s), expected {}",
            fields.extra_bytes.len(),
            buf.len() - cursor
        )));
    }
    buf[cursor..].copy_from_slice(&fields.extra_bytes);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    use las::{raw, Color};

    /// The direct encoder must stay byte-identical to `las::raw::Point`
    /// serialization for the PDRF 6/7 layouts the writer emits.
    #[test]
    fn direct_point_encoding_matches_las_raw_point() {
        let fields = CopcPointFields {
            x: 12.345,
            y: -67.89,
            z: 101.5,
            intensity: 0xBEEF,
            return_number: 3,
            number_of_returns: 5,
            synthetic: 1,
            key_point: 0,
            withheld: 1,
            overlap: 0,
            scan_channel: 2,
            scan_direction_flag: 1,
            edge_of_flight_line: 0,
            classification: 6,
            user_data: 0x42,
            scan_angle: -30.25,
            point_source_id: 0xCAFE,
            gps_time: 1.234e9,
            red: 1_000,
            green: 2_000,
            blue: 3_000,
            extra_bytes: Vec::new(),
        };
        let scale = (0.001, 0.001, 0.001);
        let offset = (0.0, 0.0, 0.0);

        for (format_id, extra_bytes) in [(6u8, 0u16), (6, 3), (7, 0), (7, 5)] {
            let mut format = LasFormat::new(format_id).unwrap();
            format.extra_bytes = extra_bytes;
            let mut fields = fields.clone();
            fields.extra_bytes = (0..extra_bytes).map(|byte| byte as u8 ^ 0xA5).collect();

            let mut direct = vec![0u8; usize::from(format.len())];
            encode_point_record(&mut direct, &fields, scale, offset, 0, &format).unwrap();

            let (ix, iy, iz) =
                quantize_xyz(0, fields.x, fields.y, fields.z, scale, offset).unwrap();
            let class_flags = fields.synthetic
                | (fields.key_point << 1)
                | (fields.withheld << 2)
                | (fields.overlap << 3);
            let reference_point = raw::Point {
                x: ix,
                y: iy,
                z: iz,
                intensity: fields.intensity,
                flags: raw::point::Flags::ThreeByte(
                    fields.return_number | (fields.number_of_returns << 4),
                    class_flags
                        | (fields.scan_channel << 4)
                        | (fields.scan_direction_flag << 6)
                        | (fields.edge_of_flight_line << 7),
                    fields.classification,
                ),
                scan_angle: raw::point::ScanAngle::Scaled(scan_angle_to_las_scaled(
                    fields.scan_angle,
                )),
                user_data: fields.user_data,
                point_source_id: fields.point_source_id,
                gps_time: Some(fields.gps_time),
                color: format.has_color.then_some(Color::new(
                    fields.red,
                    fields.green,
                    fields.blue,
                )),
                waveform: None,
                nir: None,
                extra_bytes: fields.extra_bytes.clone(),
            };
            let mut reference = Vec::with_capacity(usize::from(format.len()));
            reference_point.write_to(&mut reference, &format).unwrap();

            assert_eq!(
                reference, direct,
                "format {format_id} with {extra_bytes} extra byte(s)"
            );
        }
    }

    /// M4-12(`TaskSheets/M4-import-and-conversion.md`):
    /// `write_streaming_with_cancel_and_timings`が実際に`ingest_timings`・
    /// `stage_timings`の両方を埋めること(0のまま=計測が素通りしていないこと)
    /// を確認する。値そのものの大小は環境依存なので検証しない
    /// (ゼロでないことだけを確認する決定的なテスト)。
    #[test]
    fn write_streaming_with_cancel_and_timings_fills_both_breakdowns() {
        fn record(seed: u32) -> LasPointRecord {
            let f = f64::from(seed);
            LasPointRecord {
                x: (f * 1.5) % 10_000.0,
                y: (f * 2.25) % 10_000.0,
                z: (f * 0.75) % 10_000.0,
                return_number: 1,
                number_of_returns: 1,
                ..LasPointRecord::default()
            }
        }

        let layout = StreamingLayout {
            point_format: 0,
            has_gps: false,
            has_color: false,
            has_nir: false,
            has_waveform: false,
            extra_bytes: 0,
            extra_bytes_descriptors: Vec::new(),
        };
        let points: Vec<Result<LasPointRecord>> = (0..5_000u32).map(|i| Ok(record(i))).collect();

        let dir = tempfile::tempdir().expect("tempdir");
        let output = dir.path().join("out.copc.laz");
        let spill_dir = dir.path().join("spill");
        std::fs::create_dir_all(&spill_dir).expect("create spill dir");

        let mut ingest = IngestStageTimings::default();
        let mut post = PostProcessStageTimings::default();
        write_streaming_with_cancel_and_timings(
            &output,
            layout,
            points,
            // A small budget makes the octree split on disk; with the default 1 GiB these
            // 5000 points would be finished in memory and `lod_index_build` would be 0.
            &CopcWriterParams::new(500).with_memory_budget_bytes(64 * 1024),
            &CopcWriteMetadata::default(),
            &spill_dir,
            &copc_core::NeverCancel,
            Some(&mut ingest),
            Some(&mut post),
        )
        .expect("write_streaming_with_cancel_and_timings");

        assert!(
            ingest.source_read_and_decode > Duration::ZERO,
            "入力イテレータから読んだ時間が0のまま: {ingest:?}"
        );
        assert!(
            ingest.spill_write > Duration::ZERO,
            "spillへの書き込み時間が0のまま: {ingest:?}"
        );
        assert!(
            post.lod_index_build > Duration::ZERO,
            "octree分割の時間が0のまま: {post:?}"
        );
        assert!(
            post.node_compression > Duration::ZERO,
            "ノード圧縮の時間が0のまま: {post:?}"
        );
    }
}
