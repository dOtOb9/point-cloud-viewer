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
//! ## プールの個数について
//!
//! `lod.rs`の`assign`(再帰関数)を読むと、ある時点で「まだ使い終わっていない
//! (dropされていない)」一時ファイルの数は、**再帰の深さ×8(1ノードが最大8個の
//! 子に分かれるため)+ `partition_index_run`が新しい8個を作っている間の
//! 一時的な重なり**にとどまる(兄弟ノードは深さ優先で1つずつ順番に処理され、
//! 全部同時に開いたままにはならない)。`copc-writer`の深さの上限は30
//! (`lod.rs`の`MAX_OCTREE_DEPTH`)だが、そこまで深くなるのは同一座標の点が
//! 大量に重なるような病的なデータだけで、実用的なデータでは遥かに浅い
//! (`max_points_per_node`が既定10万点なら、数億点でも深さ5〜10程度)。
//! 安全側に倒し、`OPFS_SCRATCH_POOL_SIZE`は深さ上限30×8+予備を見込んだ値にする。
//! 使い切った場合は(黙って壊れたファイルを作るのではなく)エラーを返す。
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

use std::cell::RefCell;
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::rc::Rc;

use copc_core::{Error, Result};
use copc_writer::{ScratchFs, ScratchReader, ScratchWriter};
use wasm_bindgen::JsValue;
use web_sys::{FileSystemReadWriteOptions, FileSystemSyncAccessHandle};

/// プールの既定サイズ。モジュールのドキュメント参照
/// (再帰の深さ上限30×8+予備、安全側に倒した値)。
pub const OPFS_SCRATCH_POOL_SIZE: usize = 600;

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

/// OPFS上で動く`ScratchFs`。詳細はモジュールドキュメント参照。
pub struct OpfsScratchFs {
    pool: Rc<RefCell<Pool>>,
    /// 出力ファイル用のハンドル。`create_output`は変換につき1回しか
    /// 呼ばれない想定(`copc-writer`は1回の変換で1つの出力しか作らない)ため、
    /// `Option`で「まだ使われていない」を表す。
    output: Rc<RefCell<Option<FileSystemSyncAccessHandle>>>,
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
        }
    }
}

impl ScratchFs for OpfsScratchFs {
    fn create_temp(&self, label: &str) -> Result<Box<dyn ScratchWriter>> {
        let index = {
            let mut pool = self.pool.borrow_mut();
            pool.free.pop().ok_or_else(|| {
                Error::InvalidInput(format!(
                    "OPFS一時ファイルの枠({}個)を使い切りました(要求元: {label})。\
                     max_points_per_nodeを増やすか、点密度の偏りが極端なデータでないか確認してください",
                    pool.handles.len()
                ))
            })?
        };
        {
            let pool = self.pool.borrow();
            pool.handles[index]
                .truncate_with_u32(0)
                .map_err(|e| js_copc_err("OPFS scratch truncate", e))?;
        }
        Ok(Box::new(OpfsTempWriter {
            pool: self.pool.clone(),
            index,
            pos: 0,
        }))
    }

    fn create_output(&self, _final_path: &Path) -> Result<Box<dyn ScratchWriter>> {
        let handle = self
            .output
            .borrow_mut()
            .take()
            .ok_or_else(|| Error::InvalidInput("OPFS出力ハンドルは既に使用済みです".into()))?;
        handle
            .truncate_with_u32(0)
            .map_err(|e| js_copc_err("OPFS output truncate", e))?;
        Ok(Box::new(OpfsOutputWriter { handle, pos: 0 }))
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
}

impl Write for OpfsTempWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let written = {
            let pool = self.pool.borrow();
            pool.handles[self.index]
                .write_with_u8_array_and_options(buf, &at(self.pos))
                .map_err(|e| js_io_err("OPFS scratch write", e))?
        };
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
        self.pos = resolve_seek(&self.pool, self.index, self.pos, pos)?;
        Ok(self.pos)
    }
}

impl ScratchWriter for OpfsTempWriter {
    fn finish_temp(self: Box<Self>) -> Result<Box<dyn ScratchReader>> {
        let len = {
            let pool = self.pool.borrow();
            pool.handles[self.index]
                .get_size()
                .map_err(|e| js_copc_err("OPFS scratch get_size", e))?
        };
        Ok(Box::new(OpfsTempReader {
            pool: self.pool,
            index: self.index,
            len: len as u64,
            cache: RefCell::new(ReadCache::new()),
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
}

impl Drop for OpfsTempReader {
    fn drop(&mut self) {
        self.pool.borrow_mut().free.push(self.index);
    }
}

impl OpfsTempReader {
    /// OPFSから`[start, start + buf.len())`をちょうど読み切る
    /// (1回の`read()`で全バイトを読み切れる保証は仕様上無いため、
    /// 読み切るまで繰り返す)。
    fn read_opfs_exact(&self, start: u64, buf: &mut [u8]) -> Result<()> {
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
        Ok(())
    }
}

impl ScratchReader for OpfsTempReader {
    fn open_at(&self, offset: u64) -> Result<Box<dyn Read + Send>> {
        Ok(Box::new(OpfsSeqReader {
            pool: self.pool.clone(),
            index: self.index,
            pos: offset,
        }))
    }

    /// `offset`から`buf.len()`バイトを範囲読みする。ファイル全体を一度も
    /// メモリに載せない(モジュールドキュメント「範囲読みについて」参照)。
    /// `READ_CACHE_BLOCK_BYTES`単位のブロックキャッシュを介するため、
    /// 実際にOPFSへ`read`を発行する回数はキャッシュのヒット率に応じて
    /// 減る。キャッシュ自体のメモリ使用量は
    /// `READ_CACHE_BLOCK_BYTES * READ_CACHE_MAX_BLOCKS`(4MiB)で固定。
    fn read_at(&self, offset: u64, buf: &mut [u8]) -> Result<()> {
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
}

impl Read for OpfsSeqReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let n = {
            let pool = self.pool.borrow();
            pool.handles[self.index]
                .read_with_u8_array_and_options(buf, &at(self.pos))
                .map_err(|e| js_io_err("OPFS scratch read", e))?
        };
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
}

impl Write for OpfsOutputWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let written = self
            .handle
            .write_with_u8_array_and_options(buf, &at(self.pos))
            .map_err(|e| js_io_err("OPFS output write", e))?;
        let written = written as u64;
        self.pos += written;
        Ok(written as usize)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.handle
            .flush()
            .map_err(|e| js_io_err("OPFS output flush", e))
    }
}

impl Seek for OpfsOutputWriter {
    fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
        self.pos = match pos {
            SeekFrom::Start(p) => p,
            SeekFrom::End(offset) => {
                let size = self
                    .handle
                    .get_size()
                    .map_err(|e| js_io_err("OPFS output get_size", e))?;
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
        self.handle
            .flush()
            .map_err(|e| js_copc_err("OPFS output finish flush", e))
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
) -> io::Result<u64> {
    match pos {
        SeekFrom::Start(p) => Ok(p),
        SeekFrom::End(offset) => {
            let size = {
                let pool = pool.borrow();
                pool.handles[index]
                    .get_size()
                    .map_err(|e| js_io_err("OPFS scratch get_size", e))?
            };
            apply_offset(size as u64, offset)
        }
        SeekFrom::Current(offset) => apply_offset(current, offset),
    }
}

// OPFS(FileSystemSyncAccessHandle)はブラウザのWorker専用APIであり、
// ネイティブターゲットのcargo testでは実体を作れない(このクレート自体、
// pcv-wasmはwasm32-unknown-unknown専用。`crates/pcv-wasm/Cargo.toml`の
// ドキュメント参照)。そのため`OpfsScratchFs`自体の単体テストはここには
// 書けない。プール貸し出し・添字再利用のロジックは`OpfsScratchFs`自体に
// 埋め込まれた`Vec<usize>`の`push`/`pop`だけで完結する自明な操作であり、
// 独立してテストするほどの複雑さは無いと判断した。
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
