use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::io;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SourceFingerprint {
    pub len: u64,
    pub modified_unix_nanos: u128,
}

impl SourceFingerprint {
    fn from_metadata(metadata: &std::fs::Metadata) -> io::Result<Self> {
        let modified = metadata.modified()?;
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

pub fn fingerprint_of(path: &Path) -> io::Result<SourceFingerprint> {
    SourceFingerprint::from_metadata(&std::fs::metadata(path)?)
}

pub fn fingerprint_of_file(file: &std::fs::File) -> io::Result<SourceFingerprint> {
    SourceFingerprint::from_metadata(&file.metadata()?)
}

pub fn needs_reconversion(source: SourceFingerprint, cached: Option<SourceFingerprint>) -> bool {
    cached != Some(source)
}

pub fn sidecar_path(output: &Path) -> PathBuf {
    let mut name = output.file_name().unwrap_or_default().to_os_string();
    name.push(".meta");
    output.with_file_name(name)
}

pub fn write_sidecar(output: &Path, fingerprint: SourceFingerprint) -> io::Result<()> {
    std::fs::write(
        sidecar_path(output),
        format!("{}\n{}\n", fingerprint.len, fingerprint.modified_unix_nanos),
    )
}

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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MultiSourceFingerprint {
    pub combined_hash: u64,
    pub file_count: u64,
    pub total_bytes: u64,
}

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

pub fn needs_remerge(
    source: MultiSourceFingerprint,
    cached: Option<MultiSourceFingerprint>,
) -> bool {
    cached != Some(source)
}

pub fn write_multi_sidecar(output: &Path, fingerprint: MultiSourceFingerprint) -> io::Result<()> {
    std::fs::write(
        sidecar_path(output),
        format!(
            "{}\n{}\n{}\n",
            fingerprint.combined_hash, fingerprint.file_count, fingerprint.total_bytes
        ),
    )
}

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

        assert_eq!(fp_a, fp_b);
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
