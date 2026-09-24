//! M4-3: 「同じファイルを二度変換しない」の判定。
//!
//! 変換結果(COPC)の隣に、変換した時点の元ファイルの指紋(サイズ・更新日時)を
//! 記録したサイドカーファイル(`<出力>.meta`)を置く。次に同じ元ファイルを
//! 開こうとしたとき、今の指紋と記録された指紋を比べ、違っていれば
//! (サイズが変わった、または更新日時が変わった)作り直す。
//!
//! 判定そのもの(`needs_reconversion`)はファイルI/Oを一切しない純粋関数にして
//! テストする(受け入れ条件のとおり)。ファイルから指紋を読み取る部分
//! (`fingerprint_of`)とサイドカーの読み書きは別関数に分けてある。

use std::io;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// 元ファイルの「指紋」。サイズと更新日時の組。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SourceFingerprint {
    pub len: u64,
    /// UNIXエポックからのナノ秒。`SystemTime`は文字列化が面倒なので、
    /// サイドカーへの保存にはこちらの整数表現を使う(退屈だが読める形)。
    pub modified_unix_nanos: u128,
}

impl SourceFingerprint {
    fn from_metadata(metadata: &std::fs::Metadata) -> io::Result<Self> {
        let modified = metadata.modified()?;
        // エポックより前の更新日時は現実的にありえないので0に丸める
        // (`unwrap_or`で握りつぶしても、その場合は指紋が一致しづらくなり
        // 「余分に作り直す」方向にしか転ばない。安全側)。
        let nanos = modified
            .duration_since(SystemTime::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        Ok(Self {
            len: metadata.len(),
            modified_unix_nanos: nanos,
        })
    }
}

/// 元ファイルの現在の指紋を読む。
pub fn fingerprint_of(path: &Path) -> io::Result<SourceFingerprint> {
    SourceFingerprint::from_metadata(&std::fs::metadata(path)?)
}

/// 開いた`File`から指紋を読む。Androidの`content://` URIは`std::fs::metadata`
/// (パス文字列前提)では読めないため、`tauri-plugin-fs`で既に開いた`File`
/// (`src-tauri/src/copc_state.rs`の`open_uri_reader`と同じ経路)から直接読む。
pub fn fingerprint_of_file(file: &std::fs::File) -> io::Result<SourceFingerprint> {
    SourceFingerprint::from_metadata(&file.metadata()?)
}

/// 変換をやり直す必要があるかどうか。ファイルI/Oをしない純粋関数。
///
/// `cached`が`None`(変換結果がまだ無い、またはサイドカーが読めなかった)なら
/// 常にやり直す。安全側に倒す(疑わしきは作り直す)。
pub fn needs_reconversion(source: SourceFingerprint, cached: Option<SourceFingerprint>) -> bool {
    cached != Some(source)
}

/// 出力(`<name>.copc.laz`)に対応するサイドカーのパス(`<name>.copc.laz.meta`)。
pub fn sidecar_path(output: &Path) -> PathBuf {
    let mut name = output.file_name().unwrap_or_default().to_os_string();
    name.push(".meta");
    output.with_file_name(name)
}

/// 変換が成功した直後に呼ぶ。元ファイルの指紋をサイドカーへ書く。
pub fn write_sidecar(output: &Path, fingerprint: SourceFingerprint) -> io::Result<()> {
    std::fs::write(
        sidecar_path(output),
        format!("{}\n{}\n", fingerprint.len, fingerprint.modified_unix_nanos),
    )
}

/// サイドカーを読む。壊れている・存在しない場合は`None`
/// (呼び出し側は`needs_reconversion`でこれを「作り直す」側に倒す)。
pub fn read_sidecar(output: &Path) -> Option<SourceFingerprint> {
    let text = std::fs::read_to_string(sidecar_path(output)).ok()?;
    let mut lines = text.lines();
    let len: u64 = lines.next()?.trim().parse().ok()?;
    let modified_unix_nanos: u128 = lines.next()?.trim().parse().ok()?;
    Some(SourceFingerprint {
        len,
        modified_unix_nanos,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fp(len: u64, nanos: u128) -> SourceFingerprint {
        SourceFingerprint {
            len,
            modified_unix_nanos: nanos,
        }
    }

    #[test]
    fn no_cache_needs_reconversion() {
        assert!(needs_reconversion(fp(10, 1), None));
    }

    #[test]
    fn matching_fingerprint_does_not_need_reconversion() {
        assert!(!needs_reconversion(fp(10, 1), Some(fp(10, 1))));
    }

    #[test]
    fn different_len_needs_reconversion() {
        assert!(needs_reconversion(fp(20, 1), Some(fp(10, 1))));
    }

    #[test]
    fn different_modified_time_needs_reconversion() {
        assert!(needs_reconversion(fp(10, 2), Some(fp(10, 1))));
    }

    #[test]
    fn sidecar_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let output = dir.path().join("beer.copc.laz");
        let fingerprint = fp(123_456, 789_000_000_001);

        write_sidecar(&output, fingerprint).unwrap();
        let read_back = read_sidecar(&output);

        assert_eq!(read_back, Some(fingerprint));
    }

    #[test]
    fn missing_sidecar_reads_as_none() {
        let dir = tempfile::tempdir().unwrap();
        let output = dir.path().join("beer.copc.laz");
        assert_eq!(read_sidecar(&output), None);
    }

    #[test]
    fn corrupt_sidecar_reads_as_none() {
        let dir = tempfile::tempdir().unwrap();
        let output = dir.path().join("beer.copc.laz");
        std::fs::write(sidecar_path(&output), "not-a-number\n").unwrap();
        assert_eq!(read_sidecar(&output), None);
    }

    #[test]
    fn fingerprint_of_reflects_actual_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("source.las");
        std::fs::write(&path, b"0123456789").unwrap();

        let fingerprint = fingerprint_of(&path).unwrap();

        assert_eq!(fingerprint.len, 10);
    }

    #[test]
    fn fingerprint_of_file_matches_fingerprint_of_path() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("source.las");
        std::fs::write(&path, b"0123456789").unwrap();

        let file = std::fs::File::open(&path).unwrap();

        assert_eq!(
            fingerprint_of_file(&file).unwrap(),
            fingerprint_of(&path).unwrap()
        );
    }
}
