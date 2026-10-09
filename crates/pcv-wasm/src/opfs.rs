//! M4-6b: OPFS(Origin Private File System)上で動く`copc_writer::ScratchFs`実装。
//!
//! # なぜプールが要るか
//!
//! `copc-writer`本体(`vendor/copc-writer`、M4-6a/M4-6bの改修は
//! `vendor/copc-writer/PATCH.md`参照)は、octree(LOD)を構築する再帰
//! (`lod.rs`の`partition_index_run`)の中で`ScratchFs::create_temp`を
//! **繰り返し**呼ぶ。呼ばれる回数はデータの分布に依存し、大きい入力では
//! 数千〜数万回になりうる(1呼び出しが1つの内部octreeノードに対応する)。
//!
//! 一方、OPFSで新しいファイルを開く操作
//! (`FileSystemDirectoryHandle.getFileHandle`・
//! `FileSystemFileHandle.createSyncAccessHandle`)はどちらも**非同期**
//! (Promiseを返す。MDN/WHATWG仕様、
//! `TaskSheets/M4-import-and-conversion.md`のM4-6a 7節参照)。`create_temp`は
//! `copc-writer`本体の同期呼び出しの奥深くから呼ばれるため、その場で
//! 非同期にファイルを開くことはできない。
//!
//! そこで、変換を始める前に(`src/datasource/opfs.ts`が)固定個数
//! (`OPFS_SCRATCH_POOL_SIZE`)のOPFSファイルを`createSyncAccessHandle()`で
//! 開いておき(非同期、1回だけ)、この`OpfsScratchFs`はその配列から
//! 「空いているハンドルを借りる」「使い終わったら返す」という同期操作だけで
//! `create_temp`を実装する。借りたハンドルは使い回す(`truncate`で0バイトに
//! 戻してから使う)。
//!
//! ## プールの個数について(M4-11で見直し)
//!
//! **Web版は`copc-writer`を`parallel-lod`フィーチャ無し(逐次)でビルドしている**
//! (`crates/pcv-wasm/Cargo.toml`の`copc-writer`依存は`default-features = false`で、
//! `parallel-lod`を有効化していない。`rayon`はwasm32では使えないため)。
//! `vendor/copc-writer`の`lod.rs`の逐次版`assign`(`#[cfg(not(feature =
//! "parallel-lod"))]`)を読むと、ある時点で開いている一時ファイルは次の3種類に
//! 限られる:
//!
//! 1. 現在処理中のノードに至る**祖先**それぞれの`run.reader`(1個ずつ。Rustの
//!    所有権どおり、`assign`が値として受け取った`run`はその呼び出しがreturnする
//!    まで保持され続ける)
//! 2. 祖先の各レベルで`partition_index_run`が返した最大8個の子
//!    (`children`配列)のうち、**まだ再帰していない兄弟**(そのレベルの
//!    `assign`が終わるまで配列に残ったまま)
//! 3. 現在のレベルで`partition_index_run`が新しく開いている**最大8個の
//!    書き込み中パーティション**(1回の線形スキャンの間、データ次第で8オクタント
//!    全部が同時に書き込み中になりうる)
//!
//! これに全体を通して開いたままの`order`書き込み用一時ファイル1個を加えると、
//! 深さ`D`まで降りた時点のピークの**理論上の上限は `8 * (D + 1) + 1`**
//! になる。`copc-writer`の深さの上限は30(`lod.rs`の`MAX_OCTREE_DEPTH`。
//! そこまで深くなるのは同一座標の点が大量に重なるような病的なデータだけで、
//! `max_points_per_node`が既定10万点なら実用的なデータでは深さ5〜10程度)なので、
//! `D=30`を代入すると`8*31+1=249`。
//!
//! この理論値は、8分木がちょうど指定した深さまでフル分岐する人工データを使った
//! 回帰テスト(`crates/pcv-wasm/tests/sequential_lod_open_files_bounded.rs`。
//! `vendor/copc-writer`には触れず、その公開API=`MemoryScratchFs`経由で測る)で
//! 実測し、裏付けた: 深さ0,1,2,3,5,8,12,16でそれぞれピーク5,11,19,26,40,61,89,117
//! (おおよそ`7*深さ+5`で、常に理論上限`8*(深さ+1)+1`以内)。
//!
//! `OPFS_SCRATCH_POOL_SIZE`は`8*(30+1)+1=249`に約3割の余裕を見て**256**とした
//! (旧実装は深さ上限×8だけから算出して`600`。約2.3倍の削減になる。モバイルの
//! 実機で「変換の準備」が600個分のOPFSハンドルを順に`await`しながら開くことに
//! かかっていた時間・リソースを減らすのがねらい。`TaskSheets/
//! M4-import-and-conversion.md`のM4-11参照)。**プールを使い切った場合は
//! (黙って壊れたファイルを作るのではなく)分かるエラーを返す**
//! (`take_free_pool_slot`、下記`#[cfg(test)]`で裏付け済み)。
//!
//! ## 範囲読み(`read_at`)について
//!
//! M4-6bの実機不具合(`TaskSheets/M4-import-and-conversion.md`のM4-6b追記、
//! `vendor/copc-writer/PATCH.md`参照): かつてこの実装は`ScratchReader::as_bytes`
//! (ファイル全体をランダムアクセス領域として返す。`spill.rs`のレコード読み出しが
//! 使っていた)を、該当ファイルの内容を`vec![0u8; len]`へ丸ごと読み込む形で
//! 実装していた。ネイティブ実装は`mmap`でOSにページ管理を任せられる
//! (`TaskSheets/ADR-0006-conversion-strategy.md`参照)が、**OPFSにはmmap相当の
//! APIが無い**ため、この丸ごと読み込みは文字どおりspill(入力の点データ。
//! 1点あたり50〜60バイト程度)のサイズをそのままwasm32のメモリ使用量にした。
//! 数千万点の入力ではこれが数GBになり、wasm32のアドレス空間(32bit、実務上
//! 4GiB未満)を超えて確保が失敗し、**`unreachable`でwasmごと停止する**
//! 不具合になった(M4-6aの調査は出力の一致だけを確認し、こうしたメモリの
//! 使い方までは検証していなかった)。
//!
//! **この不具合を受け、`as_bytes`を廃止し、`ScratchReader::read_at`
//! (範囲読み)に置き換えた。** `spill.rs`は1レコード分(数十バイト)だけを
//! 都度要求するようになったため、この実装は`FileSystemSyncAccessHandle::read`
//! に`at`オプションを渡して必要な範囲だけを読む。ファイル全体を一度も
//! メモリに載せない。
//!
//! ### 小さな読みの集積を抑えるブロックキャッシュ
//!
//! LOD構築中の読み出しパターンにはある程度の局所性があるとはいえ、
//! 1レコード(数十バイト)ごとに`FileSystemSyncAccessHandle::read`を直接
//! 呼ぶと、JSとの往復コストが点数に比例して積み重なる。これを抑えるため、
//! [`READ_CACHE_BLOCK_BYTES`]単位のブロックで先読みし、直近
//! [`READ_CACHE_MAX_BLOCKS`]個までを保持する小さなキャッシュを
//! [`OpfsTempReader`]に持たせた(合計の上限は
//! `READ_CACHE_BLOCK_BYTES * READ_CACHE_MAX_BLOCKS` = 4MiBで固定。
//! 点数が増えてもこの上限は変わらない)。LRU(最近使ったブロックほど
//! 後ろに置き、あふれたら先頭=最も使われていないものから捨てる)の
//! ごく単純な実装。

use std::cell::{Cell, RefCell};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::rc::Rc;
use std::time::Duration;

use copc_core::{Error, Result};
use copc_writer::{ScratchFs, ScratchReader, ScratchWriter};
use wasm_bindgen::JsValue;
use web_sys::{FileSystemReadWriteOptions, FileSystemSyncAccessHandle};
use web_time::Instant;

/// M4-12(`TaskSheets/M4-import-and-conversion.md`): OPFSへの実際のJS呼び出し
/// (read/write/flush/truncate/get_size)にかかった累積時間。所有者向けの
/// 内訳表示で「OPFSの読み書きにまとまった時間がかかっているか」を
/// ブラウザでしか出ない値として別枠で見せるために測る。
///
/// `vendor/copc-writer`の`SpillReader::xyz_at`/`record_into`は点ごとに
/// `ScratchReader::read_at`を呼ぶ(=この実装では[`OpfsTempReader::read_at`]を
/// 点ごとに呼ぶ)が、[`READ_CACHE_BLOCK_BYTES`]単位のブロックキャッシュに
/// よって実際にJSへ`read`を発行するのはキャッシュミス時(64KiBごと)だけに
/// 既に抑えられている(モジュールドキュメント「小さな読みの集積を抑える
/// ブロックキャッシュ」参照)。このタイマーは、そのキャッシュミス時の
/// 実際のJS呼び出しだけを計測するため、`post_process_stage_bench.rs`が
/// 避けた「個々の呼び出しをInstantで包むことで生じる観測者効果」を
/// 同様に避けている(点ごとではなく、ブロック・バッファ単位でしか
/// `Instant::now()`を呼ばない)。
///
/// 1回の変換で1個の`OpfsScratchFs`しか作らないため、`Rc<Cell<Duration>>`で
/// `OpfsScratchFs`が作る各構造体(`OpfsTempWriter`/`OpfsTempReader`/
/// `OpfsOutputWriter`)の間で共有する(`Rc<RefCell<Pool>>`と同じ考え方)。
#[derive(Clone, Default)]
pub struct OpfsIoTimer(Rc<Cell<Duration>>);

impl OpfsIoTimer {
    fn record(&self, elapsed: Duration) {
        self.0.set(self.0.get() + elapsed);
    }

    /// 累積時間を読む(`convert.rs`が`finish`の後に呼ぶ)。
    pub fn total(&self) -> Duration {
        self.0.get()
    }
}

/// M4-13(`TaskSheets/M4-import-and-conversion.md`): `read_at`の呼び出し回数・
/// ブロックキャッシュのヒット/ミス・OPFSから実際に読んだバイト数・読みに
/// かかった時間の累積。コーディネーターの仮説(「ノード圧縮がLOD順に点を
/// 走査すると、元のspillファイル上では順序がランダムになり、ほぼ毎回
/// キャッシュミスして64KiBの`read`が点数ぶん発生している」)を実測で
/// 確かめるための計測。1回の変換で1個の`OpfsScratchFs`しか作らないため、
/// `OpfsIoTimer`と同じ考え方(`Rc<Cell<..>>`)で全ての`OpfsTempReader`
/// インスタンス(spill・LOD索引の各一時ファイル)間で共有する。
#[derive(Debug, Clone, Copy, Default)]
pub struct OpfsReadStats {
    /// `ScratchReader::read_at`が呼ばれた回数(=呼び出し元が範囲読みを
    /// 要求した回数。ブロックをまたぐ要求でも1回と数える)。
    pub read_at_calls: u64,
    /// ブロックキャッシュに命中した回数(ブロック単位。1回の`read_at`が
    /// 複数ブロックにまたがる場合はブロックごとに数える)。
    pub cache_hits: u64,
    /// ブロックキャッシュを外した回数(=実際にOPFSへ`read`を発行した回数)。
    pub cache_misses: u64,
    /// キャッシュミス時にOPFSから実際に読んだバイト数の合計(ブロック単位、
    /// 要求されたバイト数ではなく読み込んだブロック全体のバイト数)。
    pub bytes_read_from_opfs: u64,
    /// キャッシュミス時の`FileSystemSyncAccessHandle::read`呼び出しに
    /// かかった時間の合計(`OpfsIoTimer`と同じ計測区間を使う。ヒット時は
    /// `Instant::now()`を呼ばないため、ここに含まれない)。
    pub read_time: Duration,
}

/// [`OpfsReadStats`]を複数の`OpfsTempReader`間で共有するための薄いラッパー。
#[derive(Clone, Default)]
pub struct OpfsReadCounters(Rc<Cell<OpfsReadStats>>);

impl OpfsReadCounters {
    fn record_call(&self) {
        let mut stats = self.0.get();
        stats.read_at_calls += 1;
        self.0.set(stats);
    }

    fn record_hit(&self) {
        let mut stats = self.0.get();
        stats.cache_hits += 1;
        self.0.set(stats);
    }

    /// キャッシュミス1回ぶんを記録する。`bytes`はOPFSから実際に読んだ
    /// ブロックのバイト数、`elapsed`は`read_opfs_exact`1回の所要時間。
    fn record_miss(&self, bytes: u64, elapsed: Duration) {
        let mut stats = self.0.get();
        stats.cache_misses += 1;
        stats.bytes_read_from_opfs += bytes;
        stats.read_time += elapsed;
        self.0.set(stats);
    }

    /// 累積値を読む(`convert.rs`が`finish`の後に呼ぶ)。
    pub fn snapshot(&self) -> OpfsReadStats {
        self.0.get()
    }
}

/// プールの既定サイズ。モジュールのドキュメント「プールの個数について」参照
/// (理論上限`8*(MAX_OCTREE_DEPTH+1)+1=249`に約3割の余裕を見た値)。
pub const OPFS_SCRATCH_POOL_SIZE: usize = 256;

/// 範囲読みキャッシュの1ブロックのサイズ。モジュールドキュメント
/// 「小さな読みの集積を抑えるブロックキャッシュ」参照。
const READ_CACHE_BLOCK_BYTES: u64 = 64 * 1024;

/// 範囲読みキャッシュが同時に保持するブロック数の上限。
/// `READ_CACHE_BLOCK_BYTES * READ_CACHE_MAX_BLOCKS` = 4MiBが、この
/// キャッシュが使うメモリの固定上限(点数・ファイルサイズによらず一定)。
const READ_CACHE_MAX_BLOCKS: usize = 64;

fn at(offset: u64) -> FileSystemReadWriteOptions {
    let options = FileSystemReadWriteOptions::new();
    options.set_at_f64(offset as f64);
    options
}

fn js_io_err(context: &str, err: JsValue) -> io::Error {
    let message = js_sys::Error::from(err).message();
    io::Error::other(format!("{context}: {message}"))
}

fn js_copc_err(context: &'static str, err: JsValue) -> Error {
    Error::io(context, js_io_err(context, err))
}

struct Pool {
    handles: Vec<FileSystemSyncAccessHandle>,
    /// 空いている添字。`Vec`を後入れ先出しのスタックとして使う(どの順で
    /// 再利用されるかはアルゴリズムの正しさに影響しない。ただの空き管理)。
    free: Vec<usize>,
}

/// プールから1枠借りる。`free`が空(使い切った)なら、**黙って壊れた
/// ファイルを作るのではなく**分かるエラーを返す(受け入れ条件)。
///
/// `FileSystemSyncAccessHandle`(ブラウザのWorker専用API)に一切触れない
/// 純粋なロジックとして切り出してあるので、ネイティブの`cargo test`で
/// 「尽きたら分かるエラーになること」を検証できる(`OpfsScratchFs`自体は
/// 実際のハンドルを要求するコンストラクタを持つため、ネイティブからは
/// 構築できない。モジュール末尾の既存コメント参照)。
fn take_free_pool_slot(free: &mut Vec<usize>, pool_len: usize, label: &str) -> Result<usize> {
    free.pop().ok_or_else(|| {
        Error::InvalidInput(format!(
            "OPFS一時ファイルの枠({pool_len}個)を使い切りました(要求元: {label})。\
             max_points_per_nodeを増やすか、点密度の偏りが極端なデータでないか確認してください"
        ))
    })
}

/// OPFS上で動く`ScratchFs`。詳細はモジュールドキュメント参照。
pub struct OpfsScratchFs {
    pool: Rc<RefCell<Pool>>,
    /// 出力ファイル用のハンドル。`create_output`は変換につき1回しか
    /// 呼ばれない想定(`copc-writer`は1回の変換で1つの出力しか作らない)ため、
    /// `Option`で「まだ使われていない」を表す。
    output: Rc<RefCell<Option<FileSystemSyncAccessHandle>>>,
    /// M4-12: OPFSへの実際のJS呼び出しにかかった累積時間。
    timer: OpfsIoTimer,
    /// M4-13: `read_at`の呼び出し・キャッシュヒット率・実読みバイト数の統計。
    read_counters: OpfsReadCounters,
}

// SAFETY: wasm32-unknown-unknownはatomics無効時はシングルスレッドで動く
// (このプロジェクトの前提。ADR-0012「Web版はまずWorker1本」)。
// `crates/pcv-wasm/src/file_reader.rs`の`FileRangeReader`と同じ理由で、
// `web_sys`の型(内部はJsValue)を実際に複数スレッドで共有することは無い。
// `ScratchFs: Send + Sync`という形式要件を満たすためだけのもの。
unsafe impl Send for OpfsScratchFs {}
unsafe impl Sync for OpfsScratchFs {}
unsafe impl Send for OpfsTempWriter {}
unsafe impl Sync for OpfsTempWriter {}
unsafe impl Send for OpfsTempReader {}
unsafe impl Sync for OpfsTempReader {}
unsafe impl Send for OpfsOutputWriter {}
unsafe impl Sync for OpfsOutputWriter {}
unsafe impl Send for OpfsSeqReader {}

impl OpfsScratchFs {
    /// `scratch_handles`は事前に(TypeScript側、`src/datasource/opfs.ts`)
    /// `createSyncAccessHandle()`で開いておいた一時ファイルのハンドル。
    /// `output_handle`は変換結果の出力先として事前に開いておいたハンドル。
    ///
    /// ハンドルの**破棄・削除はここでは行わない**。全ハンドルを閉じ、
    /// 一時ファイルを消す責務はTypeScript側にある(変換の成功・失敗・
    /// キャンセルのいずれでも同じ後始末を通す設計。
    /// `crates/pcv-wasm/src/convert.rs`のドキュメント参照)。
    pub fn new(
        scratch_handles: Vec<FileSystemSyncAccessHandle>,
        output_handle: FileSystemSyncAccessHandle,
    ) -> Self {
        let count = scratch_handles.len();
        Self {
            pool: Rc::new(RefCell::new(Pool {
                handles: scratch_handles,
                free: (0..count).collect(),
            })),
            output: Rc::new(RefCell::new(Some(output_handle))),
            timer: OpfsIoTimer::default(),
            read_counters: OpfsReadCounters::default(),
        }
    }

    /// M4-12: OPFSへの実際のJS呼び出しにかかった累積時間
    /// (`crates/pcv-wasm/src/convert.rs`が`finish`の後に読む)。
    pub fn io_timings(&self) -> Duration {
        self.timer.total()
    }

    /// M4-13: `read_at`の呼び出し・キャッシュヒット率・実読みバイト数の統計
    /// (`crates/pcv-wasm/src/convert.rs`が`finish`の後に読む)。
    pub fn read_stats(&self) -> OpfsReadStats {
        self.read_counters.snapshot()
    }
}

impl ScratchFs for OpfsScratchFs {
    fn create_temp(&self, label: &str) -> Result<Box<dyn ScratchWriter>> {
        let index = {
            let mut pool = self.pool.borrow_mut();
            let pool_len = pool.handles.len();
            take_free_pool_slot(&mut pool.free, pool_len, label)?
        };
        {
            let truncate_start = Instant::now();
            let pool = self.pool.borrow();
            pool.handles[index]
                .truncate_with_u32(0)
                .map_err(|e| js_copc_err("OPFS scratch truncate", e))?;
            drop(pool);
            self.timer.record(truncate_start.elapsed());
        }
        Ok(Box::new(OpfsTempWriter {
            pool: self.pool.clone(),
            index,
            pos: 0,
            timer: self.timer.clone(),
            read_counters: self.read_counters.clone(),
        }))
    }

    fn create_output(&self, _final_path: &Path) -> Result<Box<dyn ScratchWriter>> {
        let handle = self
            .output
            .borrow_mut()
            .take()
            .ok_or_else(|| Error::InvalidInput("OPFS出力ハンドルは既に使用済みです".into()))?;
        let truncate_start = Instant::now();
        handle
            .truncate_with_u32(0)
            .map_err(|e| js_copc_err("OPFS output truncate", e))?;
        self.timer.record(truncate_start.elapsed());
        Ok(Box::new(OpfsOutputWriter {
            handle,
            pos: 0,
            timer: self.timer.clone(),
        }))
    }
}

/// プールから借りたハンドルへの書き込み中の状態。
///
/// `finish_temp`が呼ばれずにこの値が破棄される経路(呼び出し側が`?`で
/// 早期returnする失敗経路)では、借りた添字をプールへ返さない。理由:
/// この経路は必ず変換全体の失敗につながり(`copc-writer`はエラーを
/// そのまま呼び出し元へ伝える設計)、TypeScript側がハンドル・OPFSファイルを
/// 丸ごと後始末するため、このプロセス内だけのブックキーピングが多少
/// ずれても実害が無い(このプールインスタンス自体、変換1回で使い捨てる)。
struct OpfsTempWriter {
    pool: Rc<RefCell<Pool>>,
    index: usize,
    pos: u64,
    timer: OpfsIoTimer,
    read_counters: OpfsReadCounters,
}

impl Write for OpfsTempWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let write_start = Instant::now();
        let written = {
            let pool = self.pool.borrow();
            pool.handles[self.index]
                .write_with_u8_array_and_options(buf, &at(self.pos))
                .map_err(|e| js_io_err("OPFS scratch write", e))?
        };
        self.timer.record(write_start.elapsed());
        let written = written as u64;
        self.pos += written;
        Ok(written as usize)
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl Seek for OpfsTempWriter {
    fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
        self.pos = resolve_seek(&self.pool, self.index, self.pos, pos, &self.timer)?;
        Ok(self.pos)
    }
}

impl ScratchWriter for OpfsTempWriter {
    fn finish_temp(self: Box<Self>) -> Result<Box<dyn ScratchReader>> {
        let get_size_start = Instant::now();
        let len = {
            let pool = self.pool.borrow();
            pool.handles[self.index]
                .get_size()
                .map_err(|e| js_copc_err("OPFS scratch get_size", e))?
        };
        self.timer.record(get_size_start.elapsed());
        Ok(Box::new(OpfsTempReader {
            pool: self.pool,
            index: self.index,
            len: len as u64,
            cache: RefCell::new(ReadCache::new()),
            timer: self.timer,
            read_counters: self.read_counters,
        }))
    }

    fn finish_output(self: Box<Self>) -> Result<()> {
        Err(Error::InvalidInput(
            "OpfsTempWriter::finish_outputは呼ばれない想定(create_tempが作った \
             ハンドルはfinish_tempで確定する)"
                .into(),
        ))
    }
}

/// 範囲読みキャッシュの1ブロック。
struct CacheBlock {
    /// ブロック番号(`READ_CACHE_BLOCK_BYTES`単位)。
    block_index: u64,
    data: Vec<u8>,
}

/// 固定個数・固定ブロックサイズの小さいLRUキャッシュ。モジュールドキュメント
/// 「小さな読みの集積を抑えるブロックキャッシュ」参照。`blocks`の末尾ほど
/// 最近使ったブロック、先頭が最も使われていない(あふれたらそこを捨てる)。
struct ReadCache {
    blocks: Vec<CacheBlock>,
}

impl ReadCache {
    fn new() -> Self {
        Self { blocks: Vec::new() }
    }

    /// キャッシュ済みなら、そのブロックを最近使った扱いにして中身を返す。
    fn get(&mut self, block_index: u64) -> Option<&[u8]> {
        let position = self
            .blocks
            .iter()
            .position(|b| b.block_index == block_index)?;
        let block = self.blocks.remove(position);
        self.blocks.push(block);
        Some(&self.blocks.last().expect("just pushed").data)
    }

    /// 新しいブロックを登録する。上限を超えたら最も使われていないもの
    /// (先頭)を1つ捨てる。
    fn insert(&mut self, block_index: u64, data: Vec<u8>) {
        if self.blocks.len() >= READ_CACHE_MAX_BLOCKS {
            self.blocks.remove(0);
        }
        self.blocks.push(CacheBlock { block_index, data });
    }
}

/// 確定した一時ファイルへの読み出し専用アクセス。ドロップ時にプールへ
/// 添字を返す(このプロセス内で、次の`create_temp`が再利用できるようにする。
/// モジュールドキュメントの「なぜプールが要るか」参照)。
struct OpfsTempReader {
    pool: Rc<RefCell<Pool>>,
    index: usize,
    len: u64,
    /// 範囲読み(`read_at`)の小さいブロックキャッシュ。モジュールドキュメント
    /// 「小さな読みの集積を抑えるブロックキャッシュ」参照。
    cache: RefCell<ReadCache>,
    timer: OpfsIoTimer,
    /// M4-13: `read_at`の呼び出し・キャッシュヒット率・実読みバイト数の統計。
    read_counters: OpfsReadCounters,
}

impl Drop for OpfsTempReader {
    fn drop(&mut self) {
        self.pool.borrow_mut().free.push(self.index);
    }
}

impl OpfsTempReader {
    /// OPFSから`[start, start + buf.len())`をちょうど読み切る
    /// (1回の`read()`で全バイトを読み切れる保証は仕様上無いため、
    /// 読み切るまで繰り返す)。呼ばれるのは`read_at`のキャッシュミス時
    /// (`READ_CACHE_BLOCK_BYTES`=64KiBごと)だけなので、ここをまとめて
    /// 計測すれば点ごとの観測者効果を避けられる(モジュールドキュメント
    /// `OpfsIoTimer`参照)。
    fn read_opfs_exact(&self, start: u64, buf: &mut [u8]) -> Result<()> {
        let read_start = Instant::now();
        let pool = self.pool.borrow();
        let handle = &pool.handles[self.index];
        let mut read_total = 0usize;
        while read_total < buf.len() {
            let n = handle
                .read_with_u8_array_and_options(
                    &mut buf[read_total..],
                    &at(start + read_total as u64),
                )
                .map_err(|e| js_copc_err("OPFS scratch read", e))?;
            if n <= 0.0 {
                return Err(Error::InvalidData(
                    "OPFS scratchファイルの読み出しが途中で0バイトを返した".into(),
                ));
            }
            read_total += n as usize;
        }
        drop(pool);
        let elapsed = read_start.elapsed();
        self.timer.record(elapsed);
        // M4-13: このメソッドは`read_at`のキャッシュミス時だけ呼ばれるので、
        // ここで1回だけ記録すればミス回数・実読みバイト数・読み時間が揃う
        // (`read_at`側でもう一度`Instant::now()`を呼ぶ観測者効果を避ける)。
        self.read_counters.record_miss(buf.len() as u64, elapsed);
        Ok(())
    }
}

impl ScratchReader for OpfsTempReader {
    fn open_at(&self, offset: u64) -> Result<Box<dyn Read + Send>> {
        Ok(Box::new(OpfsSeqReader {
            pool: self.pool.clone(),
            index: self.index,
            pos: offset,
            timer: self.timer.clone(),
        }))
    }

    /// `offset`から`buf.len()`バイトを範囲読みする。ファイル全体を一度も
    /// メモリに載せない(モジュールドキュメント「範囲読みについて」参照)。
    /// `READ_CACHE_BLOCK_BYTES`単位のブロックキャッシュを介するため、
    /// 実際にOPFSへ`read`を発行する回数はキャッシュのヒット率に応じて
    /// 減る。キャッシュ自体のメモリ使用量は
    /// `READ_CACHE_BLOCK_BYTES * READ_CACHE_MAX_BLOCKS`(4MiB)で固定。
    fn read_at(&self, offset: u64, buf: &mut [u8]) -> Result<()> {
        // M4-13: 呼び出し元(`spill.rs`の`xyz_at`/`record_into`)が範囲読みを
        // 要求した回数。コーディネーターの仮説(ノード圧縮がLOD順=spill上は
        // ランダムな順で読むため、ほぼ毎回キャッシュミスする)を実測で
        // 確かめるための計測。
        self.read_counters.record_call();
        let end = offset
            .checked_add(buf.len() as u64)
            .ok_or_else(|| Error::InvalidData("OPFS scratch read offset overflow".into()))?;
        if end > self.len {
            return Err(Error::InvalidData(format!(
                "OPFS scratch read range [{offset}, {end}) exceeds file length {}",
                self.len
            )));
        }
        let mut filled = 0usize;
        while filled < buf.len() {
            let pos = offset + filled as u64;
            let block_index = pos / READ_CACHE_BLOCK_BYTES;
            let block_start = block_index * READ_CACHE_BLOCK_BYTES;
            let block_end = (block_start + READ_CACHE_BLOCK_BYTES).min(self.len);
            let block_len = (block_end - block_start) as usize;
            let in_block_offset = (pos - block_start) as usize;
            let want = (buf.len() - filled).min(block_len - in_block_offset);

            let mut cache = self.cache.borrow_mut();
            if let Some(cached) = cache.get(block_index) {
                self.read_counters.record_hit();
                buf[filled..filled + want]
                    .copy_from_slice(&cached[in_block_offset..in_block_offset + want]);
                filled += want;
                continue;
            }
            drop(cache);

            // キャッシュミス: ブロック全体をOPFSから読み、必要な部分を
            // コピーしてからキャッシュへ登録する。
            let mut block_buf = vec![0u8; block_len];
            self.read_opfs_exact(block_start, &mut block_buf)?;
            buf[filled..filled + want]
                .copy_from_slice(&block_buf[in_block_offset..in_block_offset + want]);
            filled += want;
            self.cache.borrow_mut().insert(block_index, block_buf);
        }
        Ok(())
    }

    fn len(&self) -> Result<u64> {
        Ok(self.len)
    }
}

/// `ScratchReader::open_at`が返す、逐次読み出し用のストリーム。プールの
/// 添字を「所有」はしない(所有するのは`OpfsTempReader`。こちらは借りている
/// だけで、Dropで何もしない)。
struct OpfsSeqReader {
    pool: Rc<RefCell<Pool>>,
    index: usize,
    pos: u64,
    timer: OpfsIoTimer,
}

impl Read for OpfsSeqReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let read_start = Instant::now();
        let n = {
            let pool = self.pool.borrow();
            pool.handles[self.index]
                .read_with_u8_array_and_options(buf, &at(self.pos))
                .map_err(|e| js_io_err("OPFS scratch read", e))?
        };
        self.timer.record(read_start.elapsed());
        self.pos += n as u64;
        Ok(n as usize)
    }
}

/// 出力ファイル(COPC本体)への書き込み中の状態。
///
/// OPFSはオリジンごとの非公開ストレージであり、native実装のような
/// 「一時名で書いて成功時だけ本来の名前へrename」という置き換えは行わない
/// (書き込み中の内容が他プロセス・他オリジンから見えることは無いため、
/// アトミックrenameで守るべき「中途半端な状態を人に見せない」という前提が
/// そもそも無い)。ハンドル自体がTypeScript側で既に最終的な出力ファイル名で
/// 開かれている(`src/datasource/opfs.ts`)。**変換が失敗・キャンセルされた
/// 場合の出力ファイルの削除は、この呼び出し元(Worker)の責務**
/// (`crates/pcv-wasm/src/convert.rs`のドキュメント参照)。
struct OpfsOutputWriter {
    handle: FileSystemSyncAccessHandle,
    pos: u64,
    timer: OpfsIoTimer,
}

impl Write for OpfsOutputWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let write_start = Instant::now();
        let written = self
            .handle
            .write_with_u8_array_and_options(buf, &at(self.pos))
            .map_err(|e| js_io_err("OPFS output write", e))?;
        self.timer.record(write_start.elapsed());
        let written = written as u64;
        self.pos += written;
        Ok(written as usize)
    }

    fn flush(&mut self) -> io::Result<()> {
        let flush_start = Instant::now();
        let result = self
            .handle
            .flush()
            .map_err(|e| js_io_err("OPFS output flush", e));
        self.timer.record(flush_start.elapsed());
        result
    }
}

impl Seek for OpfsOutputWriter {
    fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
        self.pos = match pos {
            SeekFrom::Start(p) => p,
            SeekFrom::End(offset) => {
                let get_size_start = Instant::now();
                let size = self
                    .handle
                    .get_size()
                    .map_err(|e| js_io_err("OPFS output get_size", e))?;
                self.timer.record(get_size_start.elapsed());
                apply_offset(size as u64, offset)?
            }
            SeekFrom::Current(offset) => apply_offset(self.pos, offset)?,
        };
        Ok(self.pos)
    }
}

impl ScratchWriter for OpfsOutputWriter {
    fn finish_temp(self: Box<Self>) -> Result<Box<dyn ScratchReader>> {
        Err(Error::InvalidInput(
            "OpfsOutputWriter::finish_tempは呼ばれない想定(create_outputが作った \
             ハンドルはfinish_outputで確定する)"
                .into(),
        ))
    }

    fn finish_output(self: Box<Self>) -> Result<()> {
        let flush_start = Instant::now();
        let result = self
            .handle
            .flush()
            .map_err(|e| js_copc_err("OPFS output finish flush", e));
        self.timer.record(flush_start.elapsed());
        result
    }
}

fn apply_offset(base: u64, offset: i64) -> io::Result<u64> {
    let resolved = base as i64 + offset;
    if resolved < 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "seek position underflowed 0",
        ));
    }
    Ok(resolved as u64)
}

fn resolve_seek(
    pool: &Rc<RefCell<Pool>>,
    index: usize,
    current: u64,
    pos: SeekFrom,
    timer: &OpfsIoTimer,
) -> io::Result<u64> {
    match pos {
        SeekFrom::Start(p) => Ok(p),
        SeekFrom::End(offset) => {
            let get_size_start = Instant::now();
            let size = {
                let pool = pool.borrow();
                pool.handles[index]
                    .get_size()
                    .map_err(|e| js_io_err("OPFS scratch get_size", e))?
            };
            timer.record(get_size_start.elapsed());
            apply_offset(size as u64, offset)
        }
        SeekFrom::Current(offset) => apply_offset(current, offset),
    }
}

// OPFS(FileSystemSyncAccessHandle)はブラウザのWorker専用APIであり、
// ネイティブターゲットのcargo testでは実体を作れない(このクレート自体、
// pcv-wasmはwasm32-unknown-unknown専用。`crates/pcv-wasm/Cargo.toml`の
// ドキュメント参照)。そのため`OpfsScratchFs`自体の単体テストはここには
// 書けない。ただし「プールを使い切ったら分かるエラーになること」(M4-11の
// 受け入れ条件)は、`FileSystemSyncAccessHandle`に一切触れない部分
// (`take_free_pool_slot`)として切り出してあるので、下記`#[cfg(test)]
// mod tests`でネイティブに検証できる。
//
// `ReadCache`(範囲読みのブロックキャッシュ)はOPFS自体に触れない純粋な
// Rustのロジック(LRUの追い出し)なので、ネイティブで単体テストできる
// (下記`#[cfg(test)] mod tests`)。
//
// 「メモリ上のScratchFsを使った変換の統合テスト」は
// `crates/pcv-wasm/tests/memory_scratch_conversion.rs`にある(ネイティブで
// 実行できる。`copc_writer::MemoryScratchFs`を使い、このモジュールが
// 使うのと同じ`SpillWriter`→`write_copc_from_spill_with_fs`の経路を検証する)。
// 「一度にメモリに持つ一時ファイルの量が点数に比例しないこと」自体の回帰
// テストは`vendor/copc-writer/tests/scratch_read_is_bounded.rs`にある
// (`ScratchReader::read_at`の呼び出し単位を直接計測するため、OPFSより
// 汎用的な`MemoryScratchFs`越しに検証する)。

#[cfg(test)]
mod tests {
    use super::*;

    /// M4-12: `OpfsIoTimer`は累積するだけ(クローンした先でも同じ合計を
    /// 共有する)。`web_sys`に触れない純粋なロジックなので、`Instant`では
    /// なく既知の`Duration`を直接`record`してネイティブで検証する。
    #[test]
    fn opfs_io_timer_accumulates_across_clones() {
        let timer = OpfsIoTimer::default();
        assert_eq!(timer.total(), Duration::ZERO);

        timer.record(Duration::from_millis(10));
        let cloned = timer.clone();
        cloned.record(Duration::from_millis(5));

        assert_eq!(timer.total(), Duration::from_millis(15));
        assert_eq!(cloned.total(), Duration::from_millis(15));
    }

    /// M4-13: `OpfsReadCounters`は`OpfsIoTimer`と同じく累積し、クローンした
    /// 先でも同じ合計を共有する。`web_sys`に触れない純粋なロジックなので、
    /// ネイティブで検証する。
    #[test]
    fn opfs_read_counters_accumulate_across_clones() {
        let counters = OpfsReadCounters::default();
        counters.record_call();
        counters.record_call();
        counters.record_hit();
        let cloned = counters.clone();
        cloned.record_call();
        cloned.record_miss(1024, Duration::from_millis(3));

        let stats = counters.snapshot();
        assert_eq!(stats.read_at_calls, 3);
        assert_eq!(stats.cache_hits, 1);
        assert_eq!(stats.cache_misses, 1);
        assert_eq!(stats.bytes_read_from_opfs, 1024);
        assert_eq!(stats.read_time, Duration::from_millis(3));
        assert_eq!(cloned.snapshot().read_at_calls, 3, "クローン先からも同じ合計が見える");
    }

    /// M4-11の受け入れ条件: プールを使い切ったら、黙って壊れたファイルを
    /// 作るのではなく分かるエラーを返す。
    #[test]
    fn take_free_pool_slot_returns_clear_error_when_exhausted() {
        let mut free: Vec<usize> = Vec::new();
        let err = take_free_pool_slot(&mut free, 256, "order")
            .expect_err("空のプールから借りようとしたらエラーになるはず");
        let message = err.to_string();
        assert!(
            message.contains("256"),
            "プールのサイズがエラーメッセージに含まれるはず: {message}"
        );
        assert!(
            message.contains("order"),
            "要求元のラベルがエラーメッセージに含まれるはず: {message}"
        );
    }

    /// 空いている間は借りられ、返すたびにまた借りられる(通常経路の回帰)。
    #[test]
    fn take_free_pool_slot_succeeds_while_slots_remain() {
        let mut free: Vec<usize> = vec![0, 1, 2];
        assert_eq!(take_free_pool_slot(&mut free, 3, "partition").unwrap(), 2);
        assert_eq!(take_free_pool_slot(&mut free, 3, "partition").unwrap(), 1);
        assert_eq!(take_free_pool_slot(&mut free, 3, "partition").unwrap(), 0);
        assert!(take_free_pool_slot(&mut free, 3, "partition").is_err());
    }

    #[test]
    fn read_cache_returns_cached_block_on_hit() {
        let mut cache = ReadCache::new();
        cache.insert(3, vec![1, 2, 3]);
        assert_eq!(cache.get(3), Some(&[1, 2, 3][..]));
        assert_eq!(cache.get(5), None, "未登録のブロックはNone");
    }

    #[test]
    fn read_cache_evicts_least_recently_used_block_when_full() {
        let mut cache = ReadCache::new();
        for i in 0..READ_CACHE_MAX_BLOCKS as u64 {
            cache.insert(i, vec![i as u8]);
        }
        // ブロック0を触って「最近使った」扱いにする。
        assert!(cache.get(0).is_some());
        // 新しいブロックを1つ足すと、上限を超えるので最も使われていない
        // (直前に触っていない)ブロック1が追い出されるはず(0は直前に
        // 触ったので残る)。
        cache.insert(READ_CACHE_MAX_BLOCKS as u64, vec![0xff]);
        assert!(cache.get(0).is_some(), "直前に使ったブロックは残るはず");
        assert!(
            cache.get(1).is_none(),
            "最も使われていなかったブロックは追い出されるはず"
        );
        assert_eq!(
            cache.blocks.len(),
            READ_CACHE_MAX_BLOCKS,
            "上限を超えないはず"
        );
    }

    #[test]
    fn read_cache_never_exceeds_max_blocks_regardless_of_insert_count() {
        let mut cache = ReadCache::new();
        // 上限の100倍挿入しても、保持するブロック数は上限のまま
        // (点数・ファイルサイズが増えてもキャッシュのメモリ使用量が
        // 増え続けないことの確認)。
        for i in 0..(READ_CACHE_MAX_BLOCKS as u64 * 100) {
            cache.insert(i, vec![0u8; READ_CACHE_BLOCK_BYTES as usize]);
            assert!(cache.blocks.len() <= READ_CACHE_MAX_BLOCKS);
        }
        assert_eq!(cache.blocks.len(), READ_CACHE_MAX_BLOCKS);
    }
}
