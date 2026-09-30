//! M4-6a調査: ファイルシステムに触れる操作(一時ファイルの作成・読み書き・
//! シーク・出力ファイルの確定)を1つのトレイトにまとめる。
//!
//! # なぜこの改修をするか
//!
//! `wasm32-unknown-unknown`には`tempfile`(OSの一時ファイル)も`memmap2`
//! (メモリマップ)も無い。しかし`copc-writer`本体のアルゴリズム
//! (spill・LOD構築・チャンク圧縮・出力の書き出し)は、どちらも
//! 「読み書き・シークできる何か」としてしか使っていない。その「何か」を
//! 作る・確定する・読み出す操作をこのモジュールの3つのトレイトに
//! まとめれば、アルゴリズム側のコード(`spill.rs`・`lod.rs`・`writer.rs`)を
//! 変えずに、裏側の実装(OS一時ファイル+mmapか、メモリ上のバッファか)
//! だけを差し替えられる。
//!
//! # 2つの実装
//!
//! - [`NativeScratchFs`](本モジュール。`native-fs`フィーチャで有効。既定で
//!   オン): 今までどおり`tempfile::NamedTempFile`(一時ファイル。成功時だけ
//!   本来の場所へアトミックにrename)と`memmap2::Mmap`(読み出し)を使う。
//!   **振る舞いは変えていない**
//!   (`TaskSheets/M4-import-and-conversion.md`のM4-6a参照。改修前後で
//!   小さな合成LASの変換結果がバイト同一であることを確認済み)。
//! - [`MemoryScratchFs`][]: OS一時ファイルもmmapも使わない、`Vec<u8>`だけの
//!   実装。`wasm32-unknown-unknown`向けのビルド可否を確かめるために
//!   用意した(M4-6a調査。OPFSへの実際の保存はM4-6bの範囲。ここでは
//!   「ファイルシステムを一切使わずに変換のアルゴリズムを最後まで
//!   走らせられるか」だけを確かめる)。
//!
//! `native-fs`フィーチャを切ると`tempfile`/`memmap2`への依存自体が
//! 外れる(`Cargo.toml`で`optional = true`)。`cargo build --no-default-features
//! --target wasm32-unknown-unknown`で、この2クレートに一切触れずに
//! ビルドできるかを確かめられる。

use std::io::{self, Read, Seek, SeekFrom, Write};
use std::sync::Arc;

use copc_core::{Error, Result};

/// 一時ファイル・出力ファイルの作成をまとめるトレイト。
///
/// 呼び出し側(`spill.rs`・`lod.rs`・`writer.rs`)はこのトレイトのオブジェクト
/// (`&dyn ScratchFs`)だけを見て書かれており、具体的な実装
/// (`NativeScratchFs`か`MemoryScratchFs`か)を知らない。
pub trait ScratchFs: Send + Sync {
    /// 一時ファイル(spill・LOD索引)を新規に作る。`label`はデバッグ用の
    /// 識別名(ネイティブ実装ではファイル名のprefixに使う。
    /// 例: `"spill"`・`"root"`・`"partition"`・`"order"`)。
    fn create_temp(&self, label: &str) -> Result<Box<dyn ScratchWriter>>;

    /// 出力ファイル(COPC本体)を新規に作る。`final_path`は書き込み完了後に
    /// 確定させたい最終的な置き場所を表す(ネイティブ実装では実際の
    /// ファイルパス。メモリ実装では識別子として扱うだけ)。
    fn create_output(&self, final_path: &std::path::Path) -> Result<Box<dyn ScratchWriter>>;
}

/// 書き込み中のハンドル。`Write`/`Seek`で書き込み、書き終えたら
/// `finish_temp`(一時ファイル→読み出し用ハンドルへ)か`finish_output`
/// (出力ファイル→最終確定)のどちらか一方を呼ぶ
/// (`ScratchFs::create_temp`で作ったものは`finish_temp`、
/// `ScratchFs::create_output`で作ったものは`finish_output`)。
pub trait ScratchWriter: Write + Seek + Send + Sync {
    /// 一時ファイルとして確定し、読み出し用ハンドルを返す。
    fn finish_temp(self: Box<Self>) -> Result<Box<dyn ScratchReader>>;

    /// 出力ファイルとして確定する(ネイティブ実装: 一時名から本来のパスへ
    /// アトミックにrename)。
    fn finish_output(self: Box<Self>) -> Result<()>;
}

/// 書き終えた一時ファイルへの読み出し専用アクセス。
pub trait ScratchReader: Send + Sync {
    /// 指定バイト位置から読める新しい順次読み出しストリームを開く
    /// (同じ内容を複数回・複数オフセットから読む用途。LOD索引の構築が
    /// これを多用する)。
    fn open_at(&self, offset: u64) -> Result<Box<dyn Read + Send>>;

    /// 内容全体を、ランダムアクセスできる連続領域として取得する
    /// (spillのmmapランダムアクセス相当)。**ネイティブ実装はmmapした
    /// ページをそのまま返す(コピーしない)。** ADR-0006が指摘した
    /// 「ファイルに裏付けられたメモリは足りなくなればOSが捨てて読み直せる」
    /// という性質(プライベートメモリを増やさない)を保つため。
    fn as_bytes(&self) -> Result<Arc<dyn AsRef<[u8]> + Send + Sync>>;
}

// ===========================================================================
// メモリ上の実装(常に利用可能。wasm32-unknown-unknownでもビルドできることを
// M4-6aで確認した)
// ===========================================================================

/// `wasm32-unknown-unknown`でも動く、メモリだけで完結する実装。
///
/// 一時ファイルは`Vec<u8>`。出力ファイルは、このインスタンスが内部に持つ
/// マップへ`final_path`をキーとして格納する([`MemoryScratchFs::take_output`]
/// で取り出せる)。OPFSへの実際の保存はM4-6bの範囲で、ここでは
/// 「ファイルシステムを一切使わずに変換アルゴリズムを最後まで走らせられるか」
/// だけを確かめる。
#[derive(Clone, Default)]
pub struct MemoryScratchFs {
    outputs: Arc<std::sync::Mutex<std::collections::HashMap<String, Vec<u8>>>>,
}

impl MemoryScratchFs {
    pub fn new() -> Self {
        Self::default()
    }

    /// `create_output`で書かれた内容を取り出す(テスト・検証用)。
    pub fn take_output(&self, final_path: &std::path::Path) -> Option<Vec<u8>> {
        self.outputs
            .lock()
            .expect("MemoryScratchFsのロックが汚染されていない")
            .remove(&output_key(final_path))
    }
}

fn output_key(final_path: &std::path::Path) -> String {
    final_path.to_string_lossy().into_owned()
}

impl ScratchFs for MemoryScratchFs {
    fn create_temp(&self, _label: &str) -> Result<Box<dyn ScratchWriter>> {
        Ok(Box::new(MemoryScratchWriter {
            buffer: Vec::new(),
            pos: 0,
            output: None,
        }))
    }

    fn create_output(&self, final_path: &std::path::Path) -> Result<Box<dyn ScratchWriter>> {
        Ok(Box::new(MemoryScratchWriter {
            buffer: Vec::new(),
            pos: 0,
            output: Some((output_key(final_path), Arc::clone(&self.outputs))),
        }))
    }
}

type OutputSink = (
    String,
    Arc<std::sync::Mutex<std::collections::HashMap<String, Vec<u8>>>>,
);

struct MemoryScratchWriter {
    buffer: Vec<u8>,
    pos: usize,
    /// `Some`なら出力ファイル(`finish_output`で確定)、`None`なら一時ファイル
    /// (`finish_temp`で確定)。
    output: Option<OutputSink>,
}

impl Write for MemoryScratchWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let end = self.pos + buf.len();
        if end > self.buffer.len() {
            self.buffer.resize(end, 0);
        }
        self.buffer[self.pos..end].copy_from_slice(buf);
        self.pos = end;
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl Seek for MemoryScratchWriter {
    fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
        let new_pos = match pos {
            SeekFrom::Start(offset) => offset as i64,
            SeekFrom::End(offset) => self.buffer.len() as i64 + offset,
            SeekFrom::Current(offset) => self.pos as i64 + offset,
        };
        if new_pos < 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "seek before byte 0",
            ));
        }
        self.pos = new_pos as usize;
        Ok(self.pos as u64)
    }
}

impl ScratchWriter for MemoryScratchWriter {
    fn finish_temp(self: Box<Self>) -> Result<Box<dyn ScratchReader>> {
        if self.output.is_some() {
            return Err(Error::InvalidInput(
                "finish_temp called on an output-scoped scratch file".into(),
            ));
        }
        let bytes: Arc<dyn AsRef<[u8]> + Send + Sync> = Arc::new(self.buffer);
        Ok(Box::new(SharedBytesReader { bytes }))
    }

    fn finish_output(self: Box<Self>) -> Result<()> {
        let Some((key, outputs)) = self.output else {
            return Err(Error::InvalidInput(
                "finish_output called on a temp-scoped scratch file".into(),
            ));
        };
        outputs
            .lock()
            .expect("MemoryScratchFsのロックが汚染されていない")
            .insert(key, self.buffer);
        Ok(())
    }
}

/// `Arc<dyn AsRef<[u8]>>`を共有するだけの読み出し専用ハンドル。ネイティブ・
/// メモリ両実装の`ScratchReader`が共通してこれを使う(削除(RAII)の要否だけが
/// 実装ごとに違う。メモリ実装は普通のRustの解放で十分)。
struct SharedBytesReader {
    bytes: Arc<dyn AsRef<[u8]> + Send + Sync>,
}

impl SharedBytesReader {
    fn open_at_impl(&self, offset: u64) -> Result<Box<dyn Read + Send>> {
        let pos = usize::try_from(offset)
            .map_err(|_| Error::InvalidInput("read offset exceeds usize range".into()))?;
        Ok(Box::new(ArcBytesCursor {
            bytes: Arc::clone(&self.bytes),
            pos,
        }))
    }
}

impl ScratchReader for SharedBytesReader {
    fn open_at(&self, offset: u64) -> Result<Box<dyn Read + Send>> {
        self.open_at_impl(offset)
    }

    fn as_bytes(&self) -> Result<Arc<dyn AsRef<[u8]> + Send + Sync>> {
        Ok(Arc::clone(&self.bytes))
    }
}

/// `Arc<dyn AsRef<[u8]>>`の一部をシーケンシャルに読む`Read`実装。コピーせず、
/// 参照カウントだけ増やして共有する(ネイティブ実装ではmmapのページを
/// コピーしない)。
struct ArcBytesCursor {
    bytes: Arc<dyn AsRef<[u8]> + Send + Sync>,
    pos: usize,
}

impl Read for ArcBytesCursor {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let data = self.bytes.as_ref().as_ref();
        if self.pos >= data.len() {
            return Ok(0);
        }
        let available = &data[self.pos..];
        let n = available.len().min(buf.len());
        buf[..n].copy_from_slice(&available[..n]);
        self.pos += n;
        Ok(n)
    }
}

// ===========================================================================
// ネイティブ既定実装: 一時ファイル + メモリマップ(今までと同じ振る舞い)
// ===========================================================================

#[cfg(feature = "native-fs")]
mod native {
    use std::io::{self, Seek, SeekFrom, Write};
    use std::path::{Path, PathBuf};
    use std::sync::Arc;

    use copc_core::{Error, Result};
    use memmap2::Mmap;
    use tempfile::{NamedTempFile, TempPath};

    use super::{ScratchFs, ScratchReader, ScratchWriter, SharedBytesReader};

    /// ネイティブの既定実装。`temp_dir`に一時ファイルを作る(呼び出し側が
    /// `spill_dir`かOS既定の一時ディレクトリかを選ぶ。今までの
    /// `SpillWriter::create(spill_dir, ..)`/`lod.rs`の`new_index_tempfile()`と
    /// 同じ選び方は呼び出し側(`writer.rs`)が担う)。`create_output`は
    /// `final_path`の親ディレクトリを使うため、この`temp_dir`の影響を
    /// 受けない。
    pub struct NativeScratchFs {
        temp_dir: PathBuf,
    }

    impl NativeScratchFs {
        pub fn new(temp_dir: impl Into<PathBuf>) -> Self {
            Self {
                temp_dir: temp_dir.into(),
            }
        }
    }

    impl ScratchFs for NativeScratchFs {
        fn create_temp(&self, label: &str) -> Result<Box<dyn ScratchWriter>> {
            let prefix = format!(".copc-writer-{label}.");
            let file = tempfile::Builder::new()
                .prefix(&prefix)
                .suffix(".part")
                .tempfile_in(&self.temp_dir)
                .map_err(|e| Error::io("create temp file", e))?;
            Ok(Box::new(NativeScratchWriter { file, output: None }))
        }

        fn create_output(&self, final_path: &Path) -> Result<Box<dyn ScratchWriter>> {
            let file_name = final_path.file_name().ok_or_else(|| {
                Error::InvalidInput(format!(
                    "output path {} has no file name",
                    final_path.display()
                ))
            })?;
            let mut prefix = std::ffi::OsString::from(".");
            prefix.push(file_name);
            prefix.push(".");
            let parent = final_path
                .parent()
                .filter(|parent| !parent.as_os_str().is_empty())
                .unwrap_or_else(|| Path::new("."));
            let file = tempfile::Builder::new()
                .prefix(&prefix)
                .suffix(".part")
                .tempfile_in(parent)
                .map_err(|e| Error::io("create temporary output file", e))?;
            Ok(Box::new(NativeScratchWriter {
                file,
                output: Some(final_path.to_path_buf()),
            }))
        }
    }

    struct NativeScratchWriter {
        file: NamedTempFile,
        /// `Some`なら出力ファイル(`finish_output`で確定)、`None`なら一時
        /// ファイル(`finish_temp`で確定)。
        output: Option<PathBuf>,
    }

    impl Write for NativeScratchWriter {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.file.write(buf)
        }

        fn flush(&mut self) -> io::Result<()> {
            self.file.flush()
        }
    }

    impl Seek for NativeScratchWriter {
        fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
            self.file.seek(pos)
        }
    }

    impl ScratchWriter for NativeScratchWriter {
        fn finish_temp(self: Box<Self>) -> Result<Box<dyn ScratchReader>> {
            if self.output.is_some() {
                return Err(Error::InvalidInput(
                    "finish_temp called on an output-scoped scratch file".into(),
                ));
            }
            self.file
                .as_file()
                .sync_all()
                .map_err(|e| Error::io("sync temp file", e))?;
            let mmap_file = self
                .file
                .reopen()
                .map_err(|e| Error::io("open temp file for mmap", e))?;
            let temp_path = self.file.into_temp_path();
            let len = mmap_file
                .metadata()
                .map_err(|e| Error::io("stat temp file", e))?
                .len();
            let bytes: Arc<dyn AsRef<[u8]> + Send + Sync> = if len == 0 {
                Arc::new(Vec::<u8>::new())
            } else {
                let mmap =
                    unsafe { Mmap::map(&mmap_file) }.map_err(|e| Error::io("mmap temp file", e))?;
                Arc::new(mmap)
            };
            Ok(Box::new(NativeScratchReader {
                _path: temp_path,
                shared: SharedBytesReader { bytes },
            }))
        }

        fn finish_output(self: Box<Self>) -> Result<()> {
            let Some(final_path) = self.output else {
                return Err(Error::InvalidInput(
                    "finish_output called on a temp-scoped scratch file".into(),
                ));
            };
            self.file
                .as_file()
                .sync_all()
                .map_err(|e| Error::io("sync output file", e))?;
            self.file
                .persist(&final_path)
                .map_err(|e| Error::io("persist output file", e.error))?;
            sync_parent_directory(&final_path)
        }
    }

    #[cfg(unix)]
    fn sync_parent_directory(path: &Path) -> Result<()> {
        let parent = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        std::fs::File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|e| Error::io("sync output directory", e))
    }

    #[cfg(not(unix))]
    fn sync_parent_directory(_path: &Path) -> Result<()> {
        Ok(())
    }

    /// 一時ファイル用の読み出しハンドル。`_path`を保持し続けることで、
    /// Drop時に一時ファイルが削除される(`tempfile`のRAII。今までと同じ)。
    struct NativeScratchReader {
        _path: TempPath,
        shared: SharedBytesReader,
    }

    impl ScratchReader for NativeScratchReader {
        fn open_at(&self, offset: u64) -> Result<Box<dyn std::io::Read + Send>> {
            self.shared.open_at(offset)
        }

        fn as_bytes(&self) -> Result<Arc<dyn AsRef<[u8]> + Send + Sync>> {
            self.shared.as_bytes()
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::io::Read;

        #[test]
        fn temp_file_is_removed_from_disk_after_reader_is_dropped() {
            let dir = tempfile::tempdir().unwrap();
            let fs = NativeScratchFs::new(dir.path());
            let mut writer = fs.create_temp("spike").unwrap();
            writer.write_all(b"hello").unwrap();
            let reader = writer.finish_temp().unwrap();

            // ディレクトリの中に一時ファイルが実在することを確認してから、
            // readerをdropして消えることを確かめる(パスそのものは
            // `ScratchReader`の外から見えない設計なので、ディレクトリの
            // エントリ数で判定する)。
            let entries_while_open: Vec<_> = std::fs::read_dir(dir.path())
                .unwrap()
                .filter_map(|e| e.ok())
                .collect();
            assert_eq!(entries_while_open.len(), 1, "一時ファイルが1つあるはず");

            let mut buf = Vec::new();
            reader.open_at(0).unwrap().read_to_end(&mut buf).unwrap();
            assert_eq!(buf, b"hello");

            drop(reader);
            let entries_after_drop: Vec<_> = std::fs::read_dir(dir.path())
                .unwrap()
                .filter_map(|e| e.ok())
                .collect();
            assert_eq!(
                entries_after_drop.len(),
                0,
                "readerをdropしたら一時ファイルが消えるはず"
            );
        }

        #[test]
        fn unfinalized_temp_writer_is_removed_from_disk_on_drop() {
            let dir = tempfile::tempdir().unwrap();
            let fs = NativeScratchFs::new(dir.path());
            {
                let mut writer = fs.create_temp("spike").unwrap();
                writer.write_all(b"partial").unwrap();
                // finish_temp/finish_outputを呼ばずにdropする。
            }
            let entries: Vec<_> = std::fs::read_dir(dir.path())
                .unwrap()
                .filter_map(|e| e.ok())
                .collect();
            assert_eq!(
                entries.len(),
                0,
                "finishを呼ばずにdropしたら一時ファイルが消えるはず"
            );
        }

        #[cfg(unix)]
        #[test]
        fn temp_file_is_private_on_unix() {
            use std::os::unix::fs::PermissionsExt;

            let dir = tempfile::tempdir().unwrap();
            let fs = NativeScratchFs::new(dir.path());
            let _writer = fs.create_temp("spike").unwrap();
            let entry = std::fs::read_dir(dir.path())
                .unwrap()
                .next()
                .unwrap()
                .unwrap();
            let mode = entry.metadata().unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }

        #[test]
        fn output_file_is_renamed_into_place_only_on_finish_output() {
            let dir = tempfile::tempdir().unwrap();
            let fs = NativeScratchFs::new(dir.path());
            let final_path = dir.path().join("out.bin");

            let mut writer = fs.create_output(&final_path).unwrap();
            writer.write_all(b"payload").unwrap();
            assert!(
                !final_path.exists(),
                "finish_outputを呼ぶまで最終パスにファイルが無いはず"
            );

            writer.finish_output().unwrap();
            assert!(final_path.exists(), "finish_output後は最終パスに実在する");
            assert_eq!(std::fs::read(&final_path).unwrap(), b"payload");
        }
    }
}

#[cfg(feature = "native-fs")]
pub use native::NativeScratchFs;

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    #[test]
    fn memory_temp_round_trips_bytes() {
        let fs = MemoryScratchFs::new();
        let mut writer = fs.create_temp("spike").unwrap();
        writer.write_all(b"hello world").unwrap();
        let reader = writer.finish_temp().unwrap();

        let mut buf = Vec::new();
        reader.open_at(0).unwrap().read_to_end(&mut buf).unwrap();
        assert_eq!(buf, b"hello world");

        let mut tail = Vec::new();
        reader.open_at(6).unwrap().read_to_end(&mut tail).unwrap();
        assert_eq!(tail, b"world");

        let bytes = reader.as_bytes().unwrap();
        assert_eq!(bytes.as_ref().as_ref(), b"hello world");
    }

    #[test]
    fn memory_output_is_stored_under_final_path_only_after_finish() {
        let fs = MemoryScratchFs::new();
        let final_path = std::path::Path::new("/virtual/out.bin");
        let mut writer = fs.create_output(final_path).unwrap();
        writer.write_all(b"payload").unwrap();
        assert!(
            fs.take_output(final_path).is_none(),
            "finish_outputを呼ぶまでは取り出せないはず"
        );

        writer.finish_output().unwrap();
        assert_eq!(fs.take_output(final_path).unwrap(), b"payload");
        assert!(
            fs.take_output(final_path).is_none(),
            "take_outputは1回取り出したら消えるはず"
        );
    }

    #[test]
    fn memory_writer_supports_seek_like_the_output_header_patch() {
        // writer.rsはCOPC info VLRと最初のEVLRオフセットを、末尾まで書いた後で
        // 先頭近くへシークして上書きする。メモリ実装でも同じことができるかを
        // 確かめる。
        let fs = MemoryScratchFs::new();
        let mut writer = fs.create_temp("spike").unwrap();
        writer.write_all(&[0u8; 16]).unwrap();
        writer.seek(SeekFrom::Start(4)).unwrap();
        writer.write_all(b"PATCH").unwrap();
        writer.seek(SeekFrom::End(0)).unwrap();
        writer.write_all(b"!").unwrap();

        let reader = writer.finish_temp().unwrap();
        let bytes = reader.as_bytes().unwrap();
        let data: &[u8] = bytes.as_ref().as_ref();
        assert_eq!(&data[4..9], b"PATCH");
        assert_eq!(data.len(), 17);
        assert_eq!(data[16], b'!');
    }
}
