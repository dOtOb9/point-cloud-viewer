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

use byteorder::{LittleEndian, ReadBytesExt, WriteBytesExt};
use copc_core::{
    Bounds, CancelCheck, CopcInfo, Entry, Error, LasPointRecord, Result, StreamingLayout, VoxelKey,
    MAX_EVLR_COUNT, MAX_VLR_COUNT,
};
use las::point::Format as LasFormat;
use laz::{LasZipCompressor, LazVlrBuilder};
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
use crate::lod::{build_lod_index, cube_from_bounds};
use crate::metadata::{
    CopcWriteMetadata, OutputLasMetadata, LASZIP_VLR_RECORD_ID, LASZIP_VLR_USER_ID,
};
use crate::scratch::{ScratchFs, ScratchReader};
use crate::source::{CopcPointFields, CopcPointSource, SpillSource};
use crate::spill::{SpillReader, SpillWriter};
use crate::validate::{
    quantize_xyz, scan_angle_to_las_scaled, validate_source_points,
    validate_streaming_layout_supported, validate_write_setup, PointStats,
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
}

impl CopcWriterParams {
    pub fn new(max_points_per_node: u32) -> Self {
        Self {
            max_points_per_node,
            parallel_node_compression: cfg!(feature = "parallel-compress"),
        }
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
    // LOD索引の置き場所は、今までと同じくOS既定の一時ディレクトリ
    // (`lod.rs`の旧`new_index_tempfile`と同じ選び方)。出力先は`path`の
    // 親ディレクトリを使う(`NativeScratchFs::create_output`がそこから導く)。
    let fs = NativeScratchFs::new(std::env::temp_dir());
    write_copc_inner(
        path,
        source,
        has_color,
        bounds,
        params,
        cancel,
        &metadata.to_output(),
        None,
        &fs,
        None,
        None,
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

/// M4-10(`TaskSheets/M4-import-and-conversion.md`)の回帰テスト専用。
/// `write_copc_from_spill_with_fs`と同じ処理を行い、あわせて
/// `compress_nodes_parallel`が実際に処理したバッチ(`rayon`で並列圧縮する
/// ノードのまとまり)ごとのノード数を返す。`parallel_node_compression`が
/// falseの場合、またはそもそも`parallel-compress`フィーチャが無効な
/// ビルドでは常に空になる(バッチという概念が無い逐次経路のため)。
/// 本番の変換経路はこちらを呼ばない。
pub fn write_copc_from_spill_with_fs_and_batch_sizes(
    fs: &dyn ScratchFs,
    path: &Path,
    reader: SpillReader,
    params: &CopcWriterParams,
    cancel: &(dyn CancelCheck + Sync),
    metadata: &CopcWriteMetadata,
) -> Result<Vec<usize>> {
    let mut batch_sizes = Vec::new();
    write_copc_from_spill(
        path,
        reader,
        params,
        cancel,
        &metadata.to_output(),
        fs,
        None,
        Some(&mut batch_sizes),
    )?;
    Ok(batch_sizes)
}

#[allow(clippy::too_many_arguments)]
fn write_copc_from_spill(
    path: &Path,
    reader: SpillReader,
    params: &CopcWriterParams,
    cancel: &(dyn CancelCheck + Sync),
    metadata: &OutputLasMetadata,
    fs: &dyn ScratchFs,
    stage_timings: Option<&mut PostProcessStageTimings>,
    batch_sizes: Option<&mut Vec<usize>>,
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
    let has_color = reader.layout().has_color;
    let bounds = reader.bounds();
    let stats = reader.stats();
    let source = SpillSource::new(&reader);
    write_copc_inner(
        path,
        &source,
        has_color,
        bounds,
        params,
        cancel,
        metadata,
        Some(stats),
        fs,
        stage_timings,
        batch_sizes,
    )
}

#[allow(clippy::too_many_arguments)]
fn write_copc_inner<S: CopcPointSource>(
    path: &Path,
    source: &S,
    has_color: bool,
    bounds: Bounds,
    params: &CopcWriterParams,
    cancel: &(dyn CancelCheck + Sync),
    metadata: &OutputLasMetadata,
    intake_stats: Option<PointStats>,
    fs: &dyn ScratchFs,
    mut stage_timings: Option<&mut PostProcessStageTimings>,
    batch_sizes: Option<&mut Vec<usize>>,
) -> Result<()> {
    cancel.check()?;
    if params.max_points_per_node == 0 {
        return Err(Error::InvalidInput(
            "max_points_per_node must be greater than zero".into(),
        ));
    }
    let point_format_id = if has_color { 7u8 } else { 6u8 };
    let mut point_format =
        LasFormat::new(point_format_id).map_err(|e| Error::Las(format!("point format: {e}")))?;
    let extra_byte_count = source.extra_byte_count();
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
    // Spill-backed sources validate records and accumulate stats at intake;
    // other sources need the full validation pass here. Quantization-range
    // failures for intake-validated sources surface during encoding instead,
    // where the atomic output rename still prevents partial files.
    let point_stats = match intake_stats {
        Some(stats) => stats,
        None => validate_source_points(
            source,
            bounds,
            (scale_x, scale_y, scale_z),
            (offset_x, offset_y, offset_z),
            cancel,
        )?,
    };
    let (center, halfsize) = cube_from_bounds(&bounds);

    let lod_build_start = Instant::now();
    let lod_index = build_lod_index(source, center, halfsize, params, cancel, fs)?;
    if let Some(timings) = stage_timings.as_mut() {
        timings.lod_index_build += lod_build_start.elapsed();
    }
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
    let extra_bytes_vlrs = source.extra_bytes_vlrs();
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
        total_point_count: source.len() as u64,
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

    let compress_start = Instant::now();
    let hierarchy = compress_nodes_dispatch(
        &mut writer,
        &var_vlr,
        &lod_index,
        source,
        (scale_x, scale_y, scale_z),
        (offset_x, offset_y, offset_z),
        usize::from(point_record_length),
        &point_format,
        cancel,
        params.parallel_node_compression,
        batch_sizes,
    )?;
    if let Some(timings) = stage_timings.as_mut() {
        timings.node_compression += compress_start.elapsed();
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

/// Reads one node's ordered source indexes from the LOD order file and
/// encodes its points into `raw` (`node.count * record_len` bytes).
///
/// M4-6a: `order`から都度`open_at(node.start)`で読み出し専用ストリームを
/// 開き直す(以前は`BufReader<File>`を使い回して`seek`していたが、
/// `ScratchReader`の抽象はオフセット指定の開き直しだけを提供するので、
/// これで置き換えた。ネイティブ実装はmmap済みの領域を指すだけなので、
/// 開き直しの実コストはほぼ無い)。
#[allow(clippy::too_many_arguments)]
fn encode_node_points<S: CopcPointSource>(
    node: &crate::lod::LodNodeRange,
    order: &dyn ScratchReader,
    source: &S,
    fields: &mut CopcPointFields,
    raw: &mut Vec<u8>,
    record_len: usize,
    scale: (f64, f64, f64),
    offset: (f64, f64, f64),
    point_format: &LasFormat,
    cancel: &(dyn CancelCheck + Sync),
) -> Result<()> {
    raw.clear();
    let raw_len = node
        .count
        .checked_mul(record_len)
        .ok_or_else(|| Error::InvalidInput("node point buffer size overflows usize".into()))?;
    raw.resize(raw_len, 0);
    let mut index_reader = order.open_at(node.start)?;
    for point_index in 0..node.count {
        if point_index.is_multiple_of(CANCEL_POLL_STRIDE) {
            cancel.check()?;
        }
        let source_index = index_reader
            .read_u32::<LittleEndian>()
            .map_err(|e| Error::io("read LOD order", e))? as usize;
        source.fields_into(source_index, fields)?;
        encode_point_record(
            &mut raw[point_index * record_len..(point_index + 1) * record_len],
            fields,
            scale,
            offset,
            source_index,
            point_format,
        )?;
    }
    Ok(())
}

fn hierarchy_entry(key: VoxelKey, offset: u64, byte_size: u64, count: usize) -> Result<Entry> {
    Ok(Entry {
        key,
        offset,
        byte_size: i32::try_from(byte_size)
            .map_err(|_| Error::InvalidInput("LAZ chunk exceeds COPC i32 byte size".into()))?,
        point_count: i32::try_from(count)
            .map_err(|_| Error::InvalidInput("node point count exceeds COPC i32 range".into()))?,
    })
}

/// M4-10(`TaskSheets/M4-import-and-conversion.md`): `compress_nodes_sequential`
/// と`compress_nodes_parallel`(`parallel-compress`フィーチャが有効なときだけ
/// コンパイルされる)のどちらを呼ぶかを、`CopcWriterParams::
/// parallel_node_compression`(実行時のフラグ)で選ぶ。
///
/// M4-8では`#[cfg(feature = "parallel-compress")]`で関数そのものを排他的に
/// 切り替えていたため、同じビルド内で両方の経路を実行できなかった
/// (ハッシュ一致の回帰テストと点集合一致のテストを同じcrateで両立できない)。
/// M4-10で所有者が「バイト単位の一致」を「点の集合の一致」へ条件を緩めたのを
/// 機に、両方の実装を常にコンパイルし(フィーチャがオフなら逐次だけ)、
/// 実行時フラグで切り替える形に変えた。`parallel-compress`フィーチャが無効な
/// ビルド(Web/wasm32)では、`parallel_node_compression`の値に関わらず常に
/// 逐次経路を使う(並列実装自体がコンパイルされていないため)。
#[cfg(feature = "parallel-compress")]
#[allow(clippy::too_many_arguments)]
fn compress_nodes_dispatch<W: Write + Seek + Send + Sync, S: CopcPointSource>(
    writer: &mut W,
    var_vlr: &laz::LazVlr,
    lod_index: &crate::lod::LodIndex,
    source: &S,
    scale: (f64, f64, f64),
    offset: (f64, f64, f64),
    record_len: usize,
    point_format: &LasFormat,
    cancel: &(dyn CancelCheck + Sync),
    want_parallel: bool,
    batch_sizes: Option<&mut Vec<usize>>,
) -> Result<Vec<Entry>> {
    if want_parallel {
        return compress_nodes_parallel(
            writer,
            var_vlr,
            lod_index,
            source,
            scale,
            offset,
            record_len,
            point_format,
            cancel,
            batch_sizes,
        );
    }
    let _ = batch_sizes; // 逐次経路にはバッチという概念が無い。
    compress_nodes_sequential(
        writer,
        var_vlr,
        lod_index,
        source,
        scale,
        offset,
        record_len,
        point_format,
        cancel,
    )
}

#[cfg(not(feature = "parallel-compress"))]
#[allow(clippy::too_many_arguments)]
fn compress_nodes_dispatch<W: Write + Seek + Send + Sync, S: CopcPointSource>(
    writer: &mut W,
    var_vlr: &laz::LazVlr,
    lod_index: &crate::lod::LodIndex,
    source: &S,
    scale: (f64, f64, f64),
    offset: (f64, f64, f64),
    record_len: usize,
    point_format: &LasFormat,
    cancel: &(dyn CancelCheck + Sync),
    want_parallel: bool,
    batch_sizes: Option<&mut Vec<usize>>,
) -> Result<Vec<Entry>> {
    // `parallel-compress`が無効なビルド(Web/wasm32)では並列実装自体が
    // コンパイルされていないため、フラグの値に関わらず常に逐次。
    let _ = want_parallel;
    let _ = batch_sizes;
    compress_nodes_sequential(
        writer,
        var_vlr,
        lod_index,
        source,
        scale,
        offset,
        record_len,
        point_format,
        cancel,
    )
}

/// Compress each LOD node into one COPC chunk, returning the hierarchy
/// entries. Sequential implementation: one `LasZipCompressor` streams every
/// chunk in order.
#[allow(clippy::too_many_arguments)]
fn compress_nodes_sequential<W: Write + Seek + Send + Sync, S: CopcPointSource>(
    writer: &mut W,
    var_vlr: &laz::LazVlr,
    lod_index: &crate::lod::LodIndex,
    source: &S,
    scale: (f64, f64, f64),
    offset: (f64, f64, f64),
    record_len: usize,
    point_format: &LasFormat,
    cancel: &(dyn CancelCheck + Sync),
) -> Result<Vec<Entry>> {
    let mut compressor = LasZipCompressor::new(&mut *writer, var_vlr.clone())
        .map_err(|e| Error::Las(format!("compressor: {e}")))?;
    let mut hierarchy = Vec::with_capacity(lod_index.nodes.len());
    let mut raw = Vec::new();
    let mut fields = CopcPointFields::default();
    let mut chunk_start_file_offset = compressor
        .get_mut()
        .stream_position()
        .map_err(|e| Error::io("record chunk start", e))?;
    chunk_start_file_offset = chunk_start_file_offset
        .checked_add(8)
        .ok_or_else(|| Error::InvalidInput("LAZ point-data offset overflows u64".into()))?;

    for node in &lod_index.nodes {
        cancel.check()?;
        encode_node_points(
            node,
            lod_index.order.as_ref(),
            source,
            &mut fields,
            &mut raw,
            record_len,
            scale,
            offset,
            point_format,
            cancel,
        )?;
        compressor
            .compress_many(&raw)
            .map_err(|e| Error::Las(format!("compress chunk: {e}")))?;
        compressor
            .finish_current_chunk()
            .map_err(|e| Error::Las(format!("finish chunk: {e}")))?;
        let after = compressor
            .get_mut()
            .stream_position()
            .map_err(|e| Error::io("record chunk end", e))?;
        hierarchy.push(hierarchy_entry(
            node.key,
            chunk_start_file_offset,
            after.checked_sub(chunk_start_file_offset).ok_or_else(|| {
                Error::InvalidData("LAZ compressor moved before the chunk start".into())
            })?,
            node.count,
        )?);
        chunk_start_file_offset = after;
    }

    cancel.check()?;
    compressor
        .done()
        .map_err(|e| Error::Las(format!("finish compressor: {e}")))?;
    Ok(hierarchy)
}

/// Compress each LOD node into one COPC chunk, returning the hierarchy
/// entries. Parallel implementation: node point buffers are encoded
/// sequentially in bounded batches, compressed on rayon workers (each node is
/// one standalone LAZ chunk), then written in node order; the LAZ chunk table
/// and its offset are emitted to match the sequential layout.
///
/// Peak memory is roughly `2 * batch * max_points_per_node * record_len`
/// bytes for the raw and compressed batch buffers, with
/// `batch = 2 * rayon::current_num_threads()`.
#[cfg(feature = "parallel-compress")]
#[allow(clippy::too_many_arguments)]
fn compress_nodes_parallel<W: Write + Seek + Send, S: CopcPointSource>(
    writer: &mut W,
    var_vlr: &laz::LazVlr,
    lod_index: &crate::lod::LodIndex,
    source: &S,
    scale: (f64, f64, f64),
    offset: (f64, f64, f64),
    record_len: usize,
    point_format: &LasFormat,
    cancel: &(dyn CancelCheck + Sync),
    mut batch_sizes: Option<&mut Vec<usize>>,
) -> Result<Vec<Entry>> {
    use laz::laszip::{ChunkTable, ChunkTableEntry};
    use rayon::prelude::*;

    let table_offset_position = writer
        .stream_position()
        .map_err(|e| Error::io("record chunk table offset position", e))?;
    writer
        .write_i64::<LittleEndian>(-1)
        .map_err(|e| Error::io("write chunk table offset placeholder", e))?;

    let mut hierarchy = Vec::with_capacity(lod_index.nodes.len());
    let mut chunk_table = ChunkTable::with_capacity(lod_index.nodes.len());
    let mut fields = CopcPointFields::default();
    let mut chunk_start_file_offset = table_offset_position + 8;
    let batch_size = rayon::current_num_threads().max(1) * 2;

    for batch in lod_index.nodes.chunks(batch_size) {
        cancel.check()?;
        if let Some(sizes) = batch_sizes.as_mut() {
            sizes.push(batch.len());
        }
        let mut raw_chunks = Vec::with_capacity(batch.len());
        for node in batch {
            let mut raw = Vec::new();
            encode_node_points(
                node,
                lod_index.order.as_ref(),
                source,
                &mut fields,
                &mut raw,
                record_len,
                scale,
                offset,
                point_format,
                cancel,
            )?;
            raw_chunks.push(raw);
        }

        let compressed: Vec<Result<Vec<u8>>> = raw_chunks
            .par_iter()
            .map(|raw| compress_standalone_chunk(raw, var_vlr))
            .collect();

        for (node, chunk) in batch.iter().zip(compressed) {
            let chunk = chunk?;
            writer
                .write_all(&chunk)
                .map_err(|e| Error::io("write LAZ chunk", e))?;
            hierarchy.push(hierarchy_entry(
                node.key,
                chunk_start_file_offset,
                chunk.len() as u64,
                node.count,
            )?);
            chunk_table.push(ChunkTableEntry {
                point_count: node.count as u64,
                byte_count: chunk.len() as u64,
            });
            chunk_start_file_offset = chunk_start_file_offset
                .checked_add(chunk.len() as u64)
                .ok_or_else(|| Error::InvalidInput("LAZ point-data offset overflows u64".into()))?;
        }
    }

    cancel.check()?;
    let chunk_table_position = writer
        .stream_position()
        .map_err(|e| Error::io("record chunk table position", e))?;
    chunk_table
        .write_to(&mut *writer, var_vlr)
        .map_err(|e| Error::io("write chunk table", e))?;
    let end_position = writer
        .stream_position()
        .map_err(|e| Error::io("record chunk table end", e))?;
    writer
        .seek(SeekFrom::Start(table_offset_position))
        .map_err(|e| Error::io("seek chunk table offset", e))?;
    let chunk_table_position = i64::try_from(chunk_table_position)
        .map_err(|_| Error::InvalidInput("LAZ chunk table offset exceeds i64 range".into()))?;
    writer
        .write_i64::<LittleEndian>(chunk_table_position)
        .map_err(|e| Error::io("patch chunk table offset", e))?;
    writer
        .seek(SeekFrom::Start(end_position))
        .map_err(|e| Error::io("seek end of point data", e))?;
    Ok(hierarchy)
}

/// Compress one node's raw points as a standalone variable-size LAZ chunk and
/// return exactly the chunk bytes (no chunk-table offset, no chunk table).
#[cfg(feature = "parallel-compress")]
fn compress_standalone_chunk(raw_points: &[u8], var_vlr: &laz::LazVlr) -> Result<Vec<u8>> {
    let mut cursor = std::io::Cursor::new(Vec::new());
    let mut compressor = LasZipCompressor::new(&mut cursor, var_vlr.clone())
        .map_err(|e| Error::Las(format!("chunk compressor: {e}")))?;
    compressor
        .compress_many(raw_points)
        .map_err(|e| Error::Las(format!("compress chunk: {e}")))?;
    compressor
        .done()
        .map_err(|e| Error::Las(format!("finish chunk: {e}")))?;
    drop(compressor);
    let bytes = cursor.into_inner();
    // A LAZ point-data stream starts with an i64 offset to the chunk table;
    // the single chunk's bytes sit between that offset field and the table.
    let table_position = i64::from_le_bytes(
        bytes[0..8]
            .try_into()
            .map_err(|_| Error::InvalidData("truncated LAZ chunk stream".into()))?,
    );
    let table_position = usize::try_from(table_position)
        .map_err(|_| Error::InvalidData("invalid LAZ chunk table offset".into()))?;
    if table_position < 8 || table_position > bytes.len() {
        return Err(Error::InvalidData(
            "LAZ chunk table offset out of range".into(),
        ));
    }
    Ok(bytes[8..table_position].to_vec())
}

/// Encode one point directly into the PDRF 6/7 record layout, avoiding the
/// per-point `las::raw::Point` construction (and its `extra_bytes` clone) in
/// the hot compression loop.
fn encode_point_record(
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
            &CopcWriterParams::new(500),
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
