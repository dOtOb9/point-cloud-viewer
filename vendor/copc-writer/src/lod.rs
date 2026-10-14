//! Disk-backed LOD octree index construction for COPC writes.
//!
//! M4-6a(`TaskSheets/M4-import-and-conversion.md`参照)で、一時ファイルの
//! 作成・読み書きを`crate::scratch::ScratchFs`トレイト経由に差し替えた。
//! octree分割のアルゴリズム自体は変えていない。

use std::io::{BufReader, BufWriter, Read, Write};

use byteorder::{LittleEndian, ReadBytesExt, WriteBytesExt};
use copc_core::{Bounds, CancelCheck, Error, Result, VoxelKey};

use crate::scratch::{ScratchFs, ScratchReader, ScratchWriter};
use crate::source::CopcPointSource;
use crate::writer::CopcWriterParams;
use crate::CANCEL_POLL_STRIDE;

pub(crate) const INDEX_RECORD_BYTES: u64 = 4;
pub(crate) const INDEX_IO_BUFFER_BYTES: usize = 1024 * 1024;
/// Hard cap on octree subdivision depth: deeper voxel keys would overflow the
/// i32 key coordinates (level 30 keys reach 2^30). The layered LAZ compressor
/// buffers an entire COPC chunk (one octree node) in memory before flushing,
/// so nodes must keep subdividing until they fit `max_points_per_node`.
/// Pathological coincident inputs that cannot fit by this depth are rejected
/// rather than producing an oversized chunk.
const MAX_OCTREE_DEPTH: u32 = 30;

pub(crate) struct LodIndex {
    pub(crate) nodes: Vec<LodNodeRange>,
    /// 各ノードの点インデックス列("order")を保持する読み出し専用ハンドル。
    /// `node.start`から`node.count`個の`u32`を読めば、そのノードに属する
    /// 元の点インデックスが得られる(`writer.rs`の`encode_node_points`参照)。
    pub(crate) order: Box<dyn ScratchReader>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct LodNodeRange {
    pub(crate) key: VoxelKey,
    pub(crate) start: u64,
    pub(crate) count: usize,
}

struct IndexRun {
    reader: Box<dyn ScratchReader>,
    start: u64,
    count: usize,
}

#[cfg(not(feature = "parallel-lod"))]
pub(crate) fn build_lod_index<S: CopcPointSource>(
    source: &S,
    center: (f64, f64, f64),
    halfsize: f64,
    params: &CopcWriterParams,
    cancel: &(dyn CancelCheck + Sync),
    fs: &dyn ScratchFs,
) -> Result<LodIndex> {
    cancel.check()?;
    let total_points = checked_total_points(source)?;
    let max_points_per_node = checked_max_points_per_node(params)?;
    let root_run = write_root_index_run(total_points, cancel, fs)?;
    let mut order_offset = 0;
    let mut nodes = Vec::new();
    let order_writer = fs.create_temp("order")?;
    let order = {
        let mut order_writer = BufWriter::with_capacity(INDEX_IO_BUFFER_BYTES, order_writer);
        let mut builder = LodIndexBuilder {
            source,
            max_points_per_node,
            cancel,
            fs,
            order_writer: &mut order_writer,
            order_offset: &mut order_offset,
            nodes: &mut nodes,
        };
        builder.assign(VoxelKey::root(), root_run, Bounds::cube(center, halfsize))?;
        order_writer
            .flush()
            .map_err(|e| Error::io("flush LOD index order", e))?;
        let boxed = order_writer
            .into_inner()
            .map_err(|e| Error::io("flush LOD index order", e.into_error()))?;
        boxed.finish_temp()?
    };
    nodes.sort_by_key(|node| node.key);
    Ok(LodIndex { nodes, order })
}

/// Parallel implementation: M4-8(`TaskSheets/M4-import-and-conversion.md`)で
/// 後処理の内訳を実測したところ、octreeの分割(本関数)が後処理全体の約半分
/// 〜7割を占めることが分かった(ノードごとのLAZ圧縮より大きい)。この関数の
/// 分割は「ルートの直下の子(オクタント)ごとに完全に独立」という構造
/// (あるオクタントの点は他のオクタントの分割処理と一切データを共有しない)
/// なので、ルート直下の子をrayonで並列に処理する。
///
/// # 設計: なぜ「ルート直下の1段」だけを並列化するか
///
/// 各部分木を独立した一時ファイル(ローカルのorder)へ逐次(`LodIndexBuilder::assign`、
/// 変更なし)で書き、並列処理が終わったらオクタント順(0→7)でグローバルな
/// orderファイルへバイト列をそのまま連結する(オフセットを足すだけで中身は
/// 変えない)。**これにより、連結後のorderファイルの中身は逐次版と完全に
/// 一致する**(逐次版もDFS順=「ノード自身の割り当て→子をオクタント順に処理」
/// という同じ順序でorderファイルを埋めるため)。
///
/// 全レベルを再帰的に並列化する(子のそのまた子も並列化する)案も検討したが、
/// 部分木ごとに新しい一時ファイルを作るコストがあるため、葉に近い小さな
/// 部分木まで並列化すると「小さすぎる仕事を並列化してかえって遅くなる」
/// (`TaskSheets/M4-import-and-conversion.md`のM4-7がバッチサイズ64Kiで
/// 観測した逆転と同種)おそれがある。ルート直下の1段(最大8並列)に留め、
/// その中はこれまでどおり逐次の`assign`を再利用することで、新しい
/// 一時ファイルの数を「最大8+各部分木が元々作る分」に抑えた。
///
/// # メモリ
///
/// 各部分木のローカルorderは一時ファイル(ディスク)であり、メモリに保持する
/// のは標準の入出力バッファ(`INDEX_IO_BUFFER_BYTES`)程度。同時に走る部分木の
/// 数は`rayon`のスレッドプール次第だが、`rayon`既定のプールサイズは論理コア数
/// 程度であり、ノード数や点数には比例しない。
#[cfg(feature = "parallel-lod")]
pub(crate) fn build_lod_index<S: CopcPointSource>(
    source: &S,
    center: (f64, f64, f64),
    halfsize: f64,
    params: &CopcWriterParams,
    cancel: &(dyn CancelCheck + Sync),
    fs: &dyn ScratchFs,
) -> Result<LodIndex> {
    use rayon::prelude::*;

    cancel.check()?;
    let total_points = checked_total_points(source)?;
    let max_points_per_node = checked_max_points_per_node(params)?;
    let bounds = Bounds::cube(center, halfsize);
    let root_run = write_root_index_run(total_points, cancel, fs)?;

    // ルートが葉に収まるなら分割の余地が無い。逐次版と全く同じ処理にする。
    if root_run.count <= max_points_per_node {
        let mut order_offset = 0u64;
        let mut nodes = Vec::new();
        let order_writer = fs.create_temp("order")?;
        let order = {
            let mut order_writer = BufWriter::with_capacity(INDEX_IO_BUFFER_BYTES, order_writer);
            append_index_run_to_order(&root_run, &mut order_writer, &mut order_offset, cancel)?;
            nodes.push(LodNodeRange {
                key: VoxelKey::root(),
                start: 0,
                count: root_run.count,
            });
            order_writer
                .flush()
                .map_err(|e| Error::io("flush LOD index order", e))?;
            let boxed = order_writer
                .into_inner()
                .map_err(|e| Error::io("flush LOD index order", e.into_error()))?;
            boxed.finish_temp()?
        };
        return Ok(LodIndex { nodes, order });
    }

    // ルート自身の割り当て分は、逐次版の`LodIndexBuilder::assign`と全く同じ
    // 処理でグローバルなorderファイルの先頭に書く(オクタント分割そのものは
    // 1回しか起きないため、ここは逐次のままでコストは小さい)。
    let mut children = partition_index_run(source, &root_run, bounds, cancel, fs)?;
    let mut order_offset = 0u64;
    let mut nodes = Vec::new();
    let order_writer = fs.create_temp("order")?;
    let mut order_writer = BufWriter::with_capacity(INDEX_IO_BUFFER_BYTES, order_writer);
    let selected_counts = select_for_parent_and_split_children(
        &mut children,
        max_points_per_node,
        &mut order_writer,
        &mut order_offset,
        cancel,
        fs,
    )?;
    let selected_total: usize = selected_counts.iter().sum();
    nodes.push(LodNodeRange {
        key: VoxelKey::root(),
        start: 0,
        count: selected_total,
    });

    // 残った子をオクタント順を保ったまま集め、並列に処理する。
    let mut remaining: Vec<(u8, IndexRun, Bounds)> = Vec::new();
    for (octant, child) in children.iter_mut().enumerate() {
        // 親に選ばれた点は既に除かれた「残り」の列が入っている
        let Some(child_run) = child.take() else {
            continue;
        };
        remaining.push((octant as u8, child_run, bounds.octant(octant as u8)));
    }

    cancel.check()?;
    let branch_results: Vec<Result<BranchSubtree>> = remaining
        .into_par_iter()
        .map(|(octant, child_run, child_bounds)| {
            let key = VoxelKey::root().child(octant)?;
            build_branch_subtree(
                source,
                key,
                child_run,
                child_bounds,
                max_points_per_node,
                cancel,
                fs,
            )
        })
        .collect();

    // オクタント順(`remaining`に積んだ順=0→7)のまま連結するので、逐次版と
    // 同じDFS順になり、orderファイルの中身はバイト単位で一致する。
    for result in branch_results {
        let branch = result?;
        let base_offset = order_offset;
        copy_scratch_reader(branch.order.as_ref(), branch.order_len, &mut order_writer)?;
        order_offset = order_offset
            .checked_add(branch.order_len)
            .ok_or_else(|| Error::InvalidInput("LOD index order exceeds u64 range".into()))?;
        for mut node in branch.nodes {
            node.start = node
                .start
                .checked_add(base_offset)
                .ok_or_else(|| Error::InvalidInput("LOD index order exceeds u64 range".into()))?;
            nodes.push(node);
        }
    }

    order_writer
        .flush()
        .map_err(|e| Error::io("flush LOD index order", e))?;
    let order = order_writer
        .into_inner()
        .map_err(|e| Error::io("flush LOD index order", e.into_error()))?
        .finish_temp()?;
    nodes.sort_by_key(|node| node.key);
    Ok(LodIndex { nodes, order })
}

/// 1つの部分木(あるオクタント以下の全て)の処理結果。並列ワーカーから
/// メインスレッドへ返すためのまとまり。
#[cfg(feature = "parallel-lod")]
struct BranchSubtree {
    /// この部分木が見つけた全ノード(`start`はこの部分木のローカルorderの中の
    /// 相対オフセット。呼び出し側がグローバルなオフセットへ足し直す)。
    nodes: Vec<LodNodeRange>,
    /// この部分木専用のローカルorder一時ファイル。
    order: Box<dyn ScratchReader>,
    /// ローカルorderの総バイト数。
    order_len: u64,
}

/// 部分木を1つ、独立したローカルの一時ファイルへ逐次処理する。
/// `LodIndexBuilder::assign`をそのまま再利用する(分割アルゴリズム自体は
/// 変えていない。ローカルのoffset/nodesを使うだけ)。
#[cfg(feature = "parallel-lod")]
fn build_branch_subtree<S: CopcPointSource>(
    source: &S,
    key: VoxelKey,
    run: IndexRun,
    bounds: Bounds,
    max_points_per_node: usize,
    cancel: &(dyn CancelCheck + Sync),
    fs: &dyn ScratchFs,
) -> Result<BranchSubtree> {
    let mut order_offset = 0u64;
    let mut nodes = Vec::new();
    let order_writer = fs.create_temp("order-branch")?;
    let mut order_writer = BufWriter::with_capacity(INDEX_IO_BUFFER_BYTES, order_writer);
    {
        let mut builder = LodIndexBuilder {
            source,
            max_points_per_node,
            cancel,
            fs,
            order_writer: &mut order_writer,
            order_offset: &mut order_offset,
            nodes: &mut nodes,
        };
        builder.assign(key, run, bounds)?;
    }
    order_writer
        .flush()
        .map_err(|e| Error::io("flush LOD branch order", e))?;
    let order = order_writer
        .into_inner()
        .map_err(|e| Error::io("flush LOD branch order", e.into_error()))?
        .finish_temp()?;
    Ok(BranchSubtree {
        nodes,
        order,
        order_len: order_offset,
    })
}

/// 部分木のローカルorderの中身を、グローバルなorderファイルへそのまま
/// (バイトを変えずに)連結する。
#[cfg(feature = "parallel-lod")]
fn copy_scratch_reader<W: Write>(reader: &dyn ScratchReader, len: u64, out: &mut W) -> Result<()> {
    let mut stream = reader.open_at(0)?;
    let copied =
        std::io::copy(&mut stream, out).map_err(|e| Error::io("copy LOD branch order", e))?;
    if copied != len {
        return Err(Error::InvalidData(format!(
            "LOD branch order copy is {copied} bytes, expected {len}"
        )));
    }
    Ok(())
}

fn checked_total_points<S: CopcPointSource>(source: &S) -> Result<u32> {
    u32::try_from(source.len()).map_err(|_| {
        Error::InvalidInput("COPC writer supports at most u32::MAX points per file".into())
    })
}

fn checked_max_points_per_node(params: &CopcWriterParams) -> Result<usize> {
    if params.max_points_per_node == 0 {
        return Err(Error::InvalidInput(
            "max_points_per_node must be greater than zero".into(),
        ));
    }
    Ok(params.max_points_per_node as usize)
}

struct LodIndexBuilder<'a, S: CopcPointSource, W: Write> {
    source: &'a S,
    max_points_per_node: usize,
    cancel: &'a (dyn CancelCheck + Sync),
    fs: &'a dyn ScratchFs,
    order_writer: &'a mut W,
    order_offset: &'a mut u64,
    nodes: &'a mut Vec<LodNodeRange>,
}

impl<S: CopcPointSource, W: Write> LodIndexBuilder<'_, S, W> {
    fn assign(&mut self, key: VoxelKey, run: IndexRun, bounds: Bounds) -> Result<()> {
        self.cancel.check()?;
        if run.count == 0 {
            return Ok(());
        }
        if run.count <= self.max_points_per_node {
            let start = *self.order_offset;
            append_index_run_to_order(&run, self.order_writer, self.order_offset, self.cancel)?;
            self.nodes.push(LodNodeRange {
                key,
                start,
                count: run.count,
            });
            return Ok(());
        }
        if key.level as u32 >= MAX_OCTREE_DEPTH {
            return Err(Error::InvalidInput(format!(
                "octree node {key:?} still contains {} points at the maximum depth; increase max_points_per_node above {}",
                run.count, self.max_points_per_node
            )));
        }

        let mut children = partition_index_run(self.source, &run, bounds, self.cancel, self.fs)?;
        let start = *self.order_offset;
        let selected_counts = select_for_parent_and_split_children(
            &mut children,
            self.max_points_per_node,
            self.order_writer,
            self.order_offset,
            self.cancel,
            self.fs,
        )?;
        let selected_total = selected_counts.iter().sum();
        self.nodes.push(LodNodeRange {
            key,
            start,
            count: selected_total,
        });

        for (octant, child) in children.iter_mut().enumerate() {
            // 親に選ばれた点は既に除かれた「残り」の列が入っている
            let Some(child_run) = child.take() else {
                continue;
            };
            self.assign(
                key.child(octant as u8)?,
                child_run,
                bounds.octant(octant as u8),
            )?;
        }
        Ok(())
    }
}

fn write_root_index_run(
    total_points: u32,
    cancel: &(dyn CancelCheck + Sync),
    fs: &dyn ScratchFs,
) -> Result<IndexRun> {
    let temp = fs.create_temp("root")?;
    let mut writer = BufWriter::with_capacity(INDEX_IO_BUFFER_BYTES, temp);
    for index in 0..total_points {
        if (index as usize).is_multiple_of(CANCEL_POLL_STRIDE) {
            cancel.check()?;
        }
        writer
            .write_u32::<LittleEndian>(index)
            .map_err(|e| Error::io("write root LOD index", e))?;
    }
    let boxed = writer
        .into_inner()
        .map_err(|e| Error::io("flush root LOD index", e.into_error()))?;
    let reader = boxed.finish_temp()?;
    Ok(IndexRun {
        reader,
        start: 0,
        count: total_points as usize,
    })
}

fn partition_index_run<S: CopcPointSource>(
    source: &S,
    run: &IndexRun,
    bounds: Bounds,
    cancel: &(dyn CancelCheck + Sync),
    fs: &dyn ScratchFs,
) -> Result<[Option<IndexRun>; 8]> {
    let mut reader = open_index_run(run)?;
    let mut writers: [Option<BufWriter<Box<dyn ScratchWriter>>>; 8] = std::array::from_fn(|_| None);
    let mut counts = [0usize; 8];
    let center = bounds.center();
    for read_index in 0..run.count {
        if read_index.is_multiple_of(CANCEL_POLL_STRIDE) {
            cancel.check()?;
        }
        let index = reader
            .read_u32::<LittleEndian>()
            .map_err(|e| Error::io("read LOD partition index", e))?;
        let (x, y, z) = source.xyz(index as usize)?;
        let octant = child_octant(center, x, y, z);
        if writers[octant].is_none() {
            writers[octant] = Some(BufWriter::with_capacity(
                INDEX_IO_BUFFER_BYTES,
                fs.create_temp("partition")?,
            ));
        }
        writers[octant]
            .as_mut()
            .ok_or_else(|| Error::InvalidData("partition writer was not created".into()))?
            .write_u32::<LittleEndian>(index)
            .map_err(|e| Error::io("write LOD partition index", e))?;
        counts[octant] += 1;
    }

    let mut children: [Option<IndexRun>; 8] = std::array::from_fn(|_| None);
    for octant in 0..8 {
        let Some(writer) = writers[octant].take() else {
            continue;
        };
        let boxed = writer
            .into_inner()
            .map_err(|e| Error::io("flush LOD partition index", e.into_error()))?;
        let reader = boxed.finish_temp()?;
        children[octant] = Some(IndexRun {
            reader,
            start: 0,
            count: counts[octant],
        });
    }
    Ok(children)
}

/// 子ごとに親へ入れる点数を決める(各子へ1点ずつ順に配るラウンドロビン。
/// 点数だけを決め、ファイルは読まない)。
fn decide_selected_counts(
    children: &[Option<IndexRun>; 8],
    max_points_per_node: usize,
) -> [usize; 8] {
    let mut selected_counts = [0usize; 8];
    let mut selected_total = 0usize;
    while selected_total < max_points_per_node {
        let mut progressed = false;
        for octant in 0..8 {
            let Some(child) = &children[octant] else {
                continue;
            };
            if selected_counts[octant] >= child.count {
                continue;
            }
            selected_counts[octant] += 1;
            selected_total += 1;
            progressed = true;
            if selected_total == max_points_per_node {
                break;
            }
        }
        if !progressed {
            break;
        }
    }
    selected_counts
}

/// 親ノードに入れる点を、各子の列の**全体から等間隔に**選んで`order_writer`へ
/// 書き、選ばれなかった点を新しい一時ファイルへ書き出して子の列に置き換える
/// (M4-16)。
///
/// 以前は各子の列の先頭から取っていた。列は入力順を保つので、先頭=入力ファイルの
/// 先頭部分(LASの走査線順なら空間的に一部の帯。複数図郭の結合なら先頭の図郭)
/// になり、上位ノード(=引いたときに見える点)が空間的に偏った。
///
/// - 選ぶ点数は`decide_selected_counts`のまま(子ごとの割り当ては変えない)。
/// - 子の列を1回だけ順に読む。`k`個選ぶ列(長さ`n`)では、`i`番目(0始まり)を
///   `(i+1)*k/n > i*k/n`のとき選ぶ。ちょうど`k`個が等間隔になる。
/// - 選ぶ側も残す側も列の中の相対順(indexの昇順)を保つ。順序を保つとノード内の
///   点が近い順に並び、LAZの圧縮率が落ちない。結果も決定的(逐次版・並列版で同じ)。
/// - メモリは入出力バッファだけ(点数に比例しない)。
///
/// 戻り値は子ごとの選んだ点数。`children[octant]`は、全点を選んだ子は`None`、
/// 1点も選ばなかった子は元のまま、それ以外は「残り」の列(`start`=0)になる。
fn select_for_parent_and_split_children<W: Write>(
    children: &mut [Option<IndexRun>; 8],
    max_points_per_node: usize,
    order_writer: &mut W,
    order_offset: &mut u64,
    cancel: &(dyn CancelCheck + Sync),
    fs: &dyn ScratchFs,
) -> Result<[usize; 8]> {
    let selected_counts = decide_selected_counts(children, max_points_per_node);
    for octant in 0..8 {
        let Some(child) = children[octant].take() else {
            continue;
        };
        let selected = selected_counts[octant];
        if selected == 0 {
            children[octant] = Some(child);
            continue;
        }
        let n = child.count as u64;
        let k = selected as u64;
        let mut reader = open_index_run(&child)?;
        let mut rest_writer = if selected < child.count {
            Some(BufWriter::with_capacity(
                INDEX_IO_BUFFER_BYTES,
                fs.create_temp("remainder")?,
            ))
        } else {
            None
        };
        for i in 0..child.count {
            if i.is_multiple_of(CANCEL_POLL_STRIDE) {
                cancel.check()?;
            }
            let index = reader
                .read_u32::<LittleEndian>()
                .map_err(|e| Error::io("read selected LOD index", e))?;
            let i = i as u64;
            if (i + 1) * k / n > i * k / n {
                append_index_to_order(order_writer, order_offset, index)?;
            } else if let Some(rest) = rest_writer.as_mut() {
                rest.write_u32::<LittleEndian>(index)
                    .map_err(|e| Error::io("write LOD remainder index", e))?;
            }
        }
        if let Some(rest) = rest_writer {
            let boxed = rest
                .into_inner()
                .map_err(|e| Error::io("flush LOD remainder index", e.into_error()))?;
            children[octant] = Some(IndexRun {
                reader: boxed.finish_temp()?,
                start: 0,
                count: child.count - selected,
            });
        }
    }
    Ok(selected_counts)
}

fn append_index_run_to_order<W: Write>(
    run: &IndexRun,
    order_writer: &mut W,
    order_offset: &mut u64,
    cancel: &(dyn CancelCheck + Sync),
) -> Result<()> {
    let mut reader = open_index_run(run)?;
    for read_index in 0..run.count {
        if read_index.is_multiple_of(CANCEL_POLL_STRIDE) {
            cancel.check()?;
        }
        let index = reader
            .read_u32::<LittleEndian>()
            .map_err(|e| Error::io("read LOD index", e))?;
        append_index_to_order(order_writer, order_offset, index)?;
    }
    Ok(())
}

fn append_index_to_order<W: Write>(
    order_writer: &mut W,
    order_offset: &mut u64,
    index: u32,
) -> Result<()> {
    order_writer
        .write_u32::<LittleEndian>(index)
        .map_err(|e| Error::io("write LOD index order", e))?;
    *order_offset = order_offset
        .checked_add(INDEX_RECORD_BYTES)
        .ok_or_else(|| Error::InvalidInput("LOD index order exceeds u64 range".into()))?;
    Ok(())
}

fn open_index_run(run: &IndexRun) -> Result<BufReader<Box<dyn Read + Send>>> {
    let reader = run.reader.open_at(run.start)?;
    Ok(BufReader::with_capacity(INDEX_IO_BUFFER_BYTES, reader))
}

fn child_octant(center: (f64, f64, f64), x: f64, y: f64, z: f64) -> usize {
    usize::from(x >= center.0)
        | (usize::from(y >= center.1) << 1)
        | (usize::from(z >= center.2) << 2)
}

pub(crate) fn cube_from_bounds(bounds: &Bounds) -> ((f64, f64, f64), f64) {
    let dx = bounds.max.0 - bounds.min.0;
    let dy = bounds.max.1 - bounds.min.1;
    let dz = bounds.max.2 - bounds.min.2;
    let center = (
        bounds.min.0 + dx * 0.5,
        bounds.min.1 + dy * 0.5,
        bounds.min.2 + dz * 0.5,
    );
    let halfsize = (dx.max(dy).max(dz) * 0.5).max(1e-6);
    (center, halfsize)
}

#[cfg(test)]
mod tests {
    use super::*;

    use copc_core::NeverCancel;

    use crate::scratch::MemoryScratchFs;
    #[cfg(feature = "native-fs")]
    use crate::scratch::NativeScratchFs;
    use crate::source::CopcPointFields;

    struct VecSource {
        points: Vec<CopcPointFields>,
    }

    impl CopcPointSource for VecSource {
        fn len(&self) -> usize {
            self.points.len()
        }

        fn xyz(&self, index: usize) -> Result<(f64, f64, f64)> {
            let point = &self.points[index];
            Ok((point.x, point.y, point.z))
        }

        fn fields_into(&self, index: usize, out: &mut CopcPointFields) -> Result<()> {
            out.clone_from(&self.points[index]);
            Ok(())
        }
    }

    /// M4-6aの受け入れ条件「そのトレイトのメモリ上の実装でネイティブの
    /// テストが通ること」: 同じ検証ロジックをネイティブ実装・メモリ実装
    /// 両方に対して走らせる。
    fn spooled_lod_index_covers_each_point_once(fs: &dyn ScratchFs) {
        let points = (0..257)
            .map(|i| CopcPointFields {
                x: f64::from((i * 37) % 101),
                y: f64::from((i * 53) % 103),
                z: f64::from((i * 71) % 107),
                intensity: 0,
                return_number: 1,
                number_of_returns: 1,
                synthetic: 0,
                key_point: 0,
                withheld: 0,
                overlap: 0,
                scan_channel: 0,
                scan_direction_flag: 0,
                edge_of_flight_line: 0,
                classification: 0,
                user_data: 0,
                scan_angle: 0.0,
                point_source_id: 0,
                gps_time: f64::from(i),
                red: 0,
                green: 0,
                blue: 0,
                extra_bytes: Vec::new(),
            })
            .collect();
        let source = VecSource { points };
        let bounds = source_bounds(&source);
        let (center, halfsize) = cube_from_bounds(&bounds);
        let params = CopcWriterParams::new(7);

        let spooled =
            build_lod_index(&source, center, halfsize, &params, &NeverCancel, fs).unwrap();
        let ranges = read_lod_index(&spooled).unwrap();

        let mut seen = vec![false; source.len()];
        let mut total = 0usize;
        for (_key, indices) in ranges {
            assert!(indices.len() <= params.max_points_per_node as usize);
            for index in indices {
                let seen = &mut seen[index as usize];
                assert!(!*seen, "point index {index} was assigned more than once");
                *seen = true;
                total += 1;
            }
        }
        assert_eq!(source.len(), total);
        assert!(seen.into_iter().all(|value| value));
    }

    #[cfg(feature = "native-fs")]
    #[test]
    fn spooled_lod_index_covers_each_point_once_native() {
        let dir = tempfile::tempdir().unwrap();
        spooled_lod_index_covers_each_point_once(&NativeScratchFs::new(dir.path()));
    }

    #[test]
    fn spooled_lod_index_covers_each_point_once_memory() {
        spooled_lod_index_covers_each_point_once(&MemoryScratchFs::new());
    }

    #[test]
    fn dense_cluster_stays_bounded_below_giant_chunks() {
        // A dense cluster inside large bounds must keep subdividing until every
        // node fits `max_points_per_node`; an oversized leaf would force the
        // layered LAZ compressor to buffer that entire chunk in memory (the
        // multi-GB failure mode on real clouds).
        let field = |x: f64, y: f64, z: f64, i: u32| CopcPointFields {
            x,
            y,
            z,
            intensity: 0,
            return_number: 1,
            number_of_returns: 1,
            synthetic: 0,
            key_point: 0,
            withheld: 0,
            overlap: 0,
            scan_channel: 0,
            scan_direction_flag: 0,
            edge_of_flight_line: 0,
            classification: 0,
            user_data: 0,
            scan_angle: 0.0,
            point_source_id: 0,
            gps_time: f64::from(i),
            red: 0,
            green: 0,
            blue: 0,
            extra_bytes: Vec::new(),
        };
        // 4000 distinct points packed into a ~0.4-unit cluster ...
        let mut points: Vec<CopcPointFields> = (0..4_000u32)
            .map(|i| {
                let f = f64::from(i);
                field(
                    f * 1e-4,
                    (f * 1.7).fract() * 0.4,
                    (f * 2.3).fract() * 0.4,
                    i,
                )
            })
            .collect();
        // ... plus a few points spread wide to set large bounds around it.
        for i in 0..8u32 {
            points.push(field(
                f64::from(i) * 1000.0,
                f64::from(i) * 1000.0,
                f64::from(i) * 100.0,
                100_000 + i,
            ));
        }
        let max_points = 100usize;
        let source = VecSource { points };
        let bounds = source_bounds(&source);
        let (center, halfsize) = cube_from_bounds(&bounds);
        let params = CopcWriterParams::new(max_points as u32);

        let fs = MemoryScratchFs::new();
        let lod = build_lod_index(&source, center, halfsize, &params, &NeverCancel, &fs).unwrap();
        for (key, indices) in read_lod_index(&lod).unwrap() {
            assert!(
                indices.len() <= max_points,
                "node {key:?} holds {} points, exceeding max_points_per_node {max_points}",
                indices.len(),
            );
        }
    }

    #[test]
    fn identical_points_fail_instead_of_creating_an_unbounded_leaf() {
        let point = CopcPointFields {
            x: 1.0,
            y: 1.0,
            z: 1.0,
            return_number: 1,
            number_of_returns: 1,
            ..CopcPointFields::default()
        };
        let source = VecSource {
            points: vec![point; 32],
        };
        let bounds = source_bounds(&source);
        let (center, halfsize) = cube_from_bounds(&bounds);
        let fs = MemoryScratchFs::new();
        let error = build_lod_index(
            &source,
            center,
            halfsize,
            &CopcWriterParams::new(1),
            &NeverCancel,
            &fs,
        )
        .err()
        .expect("identical points must exceed the depth cap");

        assert!(error.to_string().contains("maximum depth"));
    }

    /// M4-16: 空間的に並んだ入力(yの昇順)でも、ルートなど上位ノードの点が
    /// 空間全体に散らばること。親へ入れる点を子の列の「先頭から」取っていた
    /// ころは、入力の先頭付近(=yの小さい帯)にしか点が無かった。
    fn upper_nodes_cover_spatially_sorted_input(fs: &dyn ScratchFs) {
        let side = 64u32;
        let mut points = Vec::new();
        for yi in 0..side {
            for xi in 0..side {
                points.push(CopcPointFields {
                    x: f64::from(xi),
                    y: f64::from(yi),
                    z: f64::from((xi + yi) % 5),
                    return_number: 1,
                    number_of_returns: 1,
                    ..CopcPointFields::default()
                });
            }
        }
        let source = VecSource { points };
        let bounds = source_bounds(&source);
        let (center, halfsize) = cube_from_bounds(&bounds);
        let params = CopcWriterParams::new(200);
        let lod = build_lod_index(&source, center, halfsize, &params, &NeverCancel, fs).unwrap();
        let ranges = read_lod_index(&lod).unwrap();

        // 全点が1回ずつ現れること(選び方を変えても欠落・重複が無い)
        let mut seen = vec![false; source.len()];
        for (_key, indices) in &ranges {
            for &index in indices {
                assert!(!seen[index as usize], "point {index} assigned twice");
                seen[index as usize] = true;
            }
        }
        assert!(seen.into_iter().all(|v| v));

        // ルートだけ、ルートとレベル1だけ、それぞれで、yの範囲を10分割した
        // 各区間に点があること
        for max_level in 0..=1u32 {
            let mut bins = [0usize; 10];
            for (key, indices) in &ranges {
                if key.level as u32 > max_level {
                    continue;
                }
                for &index in indices {
                    let y = source.points[index as usize].y;
                    let bin = ((y / f64::from(side)) * 10.0) as usize;
                    bins[bin.min(9)] += 1;
                }
            }
            assert!(
                bins.iter().all(|&n| n > 0),
                "レベル{max_level}以下の点が y の全範囲に広がっていない: {bins:?}"
            );
        }
    }

    #[test]
    fn upper_nodes_cover_spatially_sorted_input_memory() {
        upper_nodes_cover_spatially_sorted_input(&MemoryScratchFs::new());
    }

    #[cfg(feature = "native-fs")]
    #[test]
    fn upper_nodes_cover_spatially_sorted_input_native() {
        let dir = tempfile::tempdir().unwrap();
        upper_nodes_cover_spatially_sorted_input(&NativeScratchFs::new(dir.path()));
    }

    fn source_bounds(source: &VecSource) -> Bounds {
        source.points.iter().fold(
            Bounds::point(source.points[0].x, source.points[0].y, source.points[0].z),
            |mut bounds, point| {
                bounds.extend(point.x, point.y, point.z);
                bounds
            },
        )
    }

    fn read_lod_index(index: &LodIndex) -> Result<Vec<(VoxelKey, Vec<u32>)>> {
        let mut out = Vec::new();
        for node in &index.nodes {
            let mut reader = index.order.open_at(node.start)?;
            let mut indices = Vec::with_capacity(node.count);
            for _ in 0..node.count {
                indices.push(
                    reader
                        .read_u32::<LittleEndian>()
                        .map_err(|e| Error::io("read LOD order", e))?,
                );
            }
            out.push((node.key, indices));
        }
        Ok(out)
    }
}
