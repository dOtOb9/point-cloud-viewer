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

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
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

// --- M4-14: 複数ファイル(マージ変換)の指紋。「同じ選択を二度変換しない」。 ---
//
// 単一ファイルの`SourceFingerprint`(サイズ+更新日時)をそのまま複数個持つのでは
// なく、1つの`u64`ハッシュへまとめる。**選択した順序に依存しない**ことが要件
// (「同じファイル集合なら、選ぶ順番が変わっても同じキャッシュに当たる」)
// なので、ハッシュに入れる前に(ファイル名, サイズ, 更新日時)の組を昇順に
// ソートする。ソートしてから1本のハッシュに畳み込むだけなので、
// XOR等で各ファイルのハッシュを個別に合成する案(順序に依存しないが、
// 同じファイルを2回選ぶと打ち消し合う欠点がある)より素直で正しい。

/// 複数ファイルの「指紋」。`combined_hash`はソート済みの(ファイル名, サイズ,
/// 更新日時)列を1つの`DefaultHasher`に順番に食わせた結果(`DefaultHasher`は
/// 乱数化されない決定的なハッシュ関数。`output_path.rs`の`hash_path`と同じ
/// 前提)。`file_count`/`total_bytes`も併せて比較することで、ハッシュの衝突
/// (起こり得るが稀)がそのまま誤ったキャッシュ命中にはならないようにする。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MultiSourceFingerprint {
    pub combined_hash: u64,
    pub file_count: u64,
    pub total_bytes: u64,
}

/// 複数の元ファイルの現在の指紋を読む。1つでも読めなければ`Err`
/// (単一ファイル版の`fingerprint_of`と同じく、呼び出し側へそのまま伝える)。
pub fn multi_fingerprint_of_paths(paths: &[PathBuf]) -> io::Result<MultiSourceFingerprint> {
    let mut entries: Vec<(String, u64, u128)> = Vec::with_capacity(paths.len());
    let mut total_bytes = 0u64;
    for path in paths {
        let fp = fingerprint_of(path)?;
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default()
            .to_string();
        total_bytes += fp.len;
        entries.push((name, fp.len, fp.modified_unix_nanos));
    }
    // 選択順に依存しないキーにする(ファイル名→サイズ→更新日時の順でソート)。
    entries.sort();

    let mut hasher = DefaultHasher::new();
    for (name, len, nanos) in &entries {
        name.hash(&mut hasher);
        len.hash(&mut hasher);
        nanos.hash(&mut hasher);
    }
    Ok(MultiSourceFingerprint {
        combined_hash: hasher.finish(),
        file_count: paths.len() as u64,
        total_bytes,
    })
}

/// 複数ファイル版の`needs_reconversion`。
pub fn needs_remerge(
    source: MultiSourceFingerprint,
    cached: Option<MultiSourceFingerprint>,
) -> bool {
    cached != Some(source)
}

/// 複数ファイル版のサイドカーパス(単一ファイル版と同じ命名規則、
/// `<出力>.meta`)。出力ファイル名自体が入力集合から決まる(`output_path.rs`の
/// `multi_output_file_name`)ため、単一ファイル版と同じ`sidecar_path`を
/// そのまま使ってよい(形式(3行のテキスト)だけが違う)。
pub fn write_multi_sidecar(output: &Path, fingerprint: MultiSourceFingerprint) -> io::Result<()> {
    std::fs::write(
        sidecar_path(output),
        format!(
            "{}\n{}\n{}\n",
            fingerprint.combined_hash, fingerprint.file_count, fingerprint.total_bytes
        ),
    )
}

/// 複数ファイル版のサイドカーを読む。壊れている・存在しない場合は`None`。
pub fn read_multi_sidecar(output: &Path) -> Option<MultiSourceFingerprint> {
    let text = std::fs::read_to_string(sidecar_path(output)).ok()?;
    let mut lines = text.lines();
    let combined_hash: u64 = lines.next()?.trim().parse().ok()?;
    let file_count: u64 = lines.next()?.trim().parse().ok()?;
    let total_bytes: u64 = lines.next()?.trim().parse().ok()?;
    Some(MultiSourceFingerprint {
        combined_hash,
        file_count,
        total_bytes,
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

    fn write_files(dir: &Path, names: &[&str]) -> Vec<PathBuf> {
        names
            .iter()
            .map(|name| {
                let path = dir.join(name);
                std::fs::write(&path, format!("content-of-{name}")).unwrap();
                path
            })
            .collect()
    }

    /// 受け入れ条件: 同じファイル集合なら、選ぶ順番が変わっても同じ
    /// キャッシュキー(指紋)になる。
    #[test]
    fn multi_fingerprint_is_order_independent() {
        let dir = tempfile::tempdir().unwrap();
        let paths = write_files(dir.path(), &["a.las", "b.las", "c.las"]);
        let reversed: Vec<PathBuf> = paths.iter().rev().cloned().collect();

        let forward = multi_fingerprint_of_paths(&paths).unwrap();
        let backward = multi_fingerprint_of_paths(&reversed).unwrap();

        assert_eq!(forward, backward);
    }

    #[test]
    fn multi_fingerprint_differs_when_file_set_differs() {
        let dir = tempfile::tempdir().unwrap();
        let paths_a = write_files(dir.path(), &["a.las", "b.las"]);
        let paths_b = write_files(dir.path(), &["a.las", "b.las", "c.las"]);

        let fp_a = multi_fingerprint_of_paths(&paths_a).unwrap();
        let fp_b = multi_fingerprint_of_paths(&paths_b[..2]).unwrap();
        let fp_c = multi_fingerprint_of_paths(&paths_b).unwrap();

        // 同じ2ファイルなら一致する。
        assert_eq!(fp_a, fp_b);
        // 3ファイル目が増えれば(ファイル数も中身も違うので)一致しない。
        assert_ne!(fp_a, fp_c);
    }

    #[test]
    fn multi_sidecar_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let output = dir.path().join("09LD2626 ほか2ファイル.copc.laz");
        let paths = write_files(dir.path(), &["a.las", "b.las"]);
        let fingerprint = multi_fingerprint_of_paths(&paths).unwrap();

        assert!(needs_remerge(fingerprint, read_multi_sidecar(&output)));
        write_multi_sidecar(&output, fingerprint).unwrap();
        assert!(!needs_remerge(fingerprint, read_multi_sidecar(&output)));
    }
}
