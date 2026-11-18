use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::io;
use std::path::{Path, PathBuf};

pub fn copc_output_file_name(source_file_name: &str) -> String {
    let lower = source_file_name.to_ascii_lowercase();
    let stem_len = if lower.ends_with(".laz") || lower.ends_with(".las") {
        source_file_name.len() - 4
    } else {
        source_file_name.len()
    };
    format!("{}.copc.laz", &source_file_name[..stem_len])
}

pub fn resolve_output_path(source: &Path, fallback_dir: &Path) -> io::Result<PathBuf> {
    let file_name = source.file_name().and_then(|n| n.to_str()).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "元ファイル名にファイル名部分が無い",
        )
    })?;
    let output_name = copc_output_file_name(file_name);

    if let Some(parent) = source.parent().filter(|p| !p.as_os_str().is_empty()) {
        if dir_is_writable(parent) {
            return Ok(parent.join(output_name));
        }
    }

    std::fs::create_dir_all(fallback_dir)?;
    Ok(fallback_dir.join(format!("{:016x}-{output_name}", hash_path(source))))
}

pub fn multi_output_file_name(sorted_file_names: &[String]) -> String {
    debug_assert!(
        !sorted_file_names.is_empty(),
        "呼び出し側が空でないことを保証する"
    );
    if sorted_file_names.len() == 1 {
        return copc_output_file_name(&sorted_file_names[0]);
    }
    let first = copc_output_file_name(&sorted_file_names[0]);
    let first_stem = first.strip_suffix(".copc.laz").unwrap_or(&first);
    let rest = sorted_file_names.len() - 1;
    format!("{first_stem} ほか{rest}ファイル.copc.laz")
}

pub fn resolve_multi_output_path(
    sorted_file_names: &[String],
    fallback_dir: &Path,
) -> io::Result<PathBuf> {
    std::fs::create_dir_all(fallback_dir)?;
    Ok(fallback_dir.join(multi_output_file_name(sorted_file_names)))
}

fn dir_is_writable(dir: &Path) -> bool {
    tempfile::Builder::new()
        .prefix(".pcv-write-probe.")
        .tempfile_in(dir)
        .is_ok()
}

fn hash_path(path: &Path) -> u64 {
    let mut hasher = DefaultHasher::new();
    path.hash(&mut hasher);
    hasher.finish()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_las_and_laz_extensions_case_insensitively() {
        assert_eq!(copc_output_file_name("beer.laz"), "beer.copc.laz");
        assert_eq!(copc_output_file_name("scan.LAS"), "scan.copc.laz");
        assert_eq!(copc_output_file_name("mixed.LaZ"), "mixed.copc.laz");
    }

    #[test]
    fn appends_when_extension_is_neither_las_nor_laz() {
        assert_eq!(
            copc_output_file_name("no-extension"),
            "no-extension.copc.laz"
        );
    }

    #[test]
    fn resolves_next_to_source_when_parent_is_writable() {
        let dir = tempfile::tempdir().expect("tempdir");
        let source = dir.path().join("beer.laz");
        std::fs::write(&source, b"dummy").unwrap();
        let fallback = dir.path().join("fallback");

        let output = resolve_output_path(&source, &fallback).unwrap();

        assert_eq!(output, dir.path().join("beer.copc.laz"));
        assert!(
            !fallback.exists(),
            "書き込めるのにフォールバックを使ってはいけない"
        );
    }

    #[test]
    fn falls_back_when_parent_does_not_exist() {
        let dir = tempfile::tempdir().expect("tempdir");
        let source = dir.path().join("does-not-exist").join("beer.laz");
        let fallback = dir.path().join("fallback");

        let output = resolve_output_path(&source, &fallback).unwrap();

        assert!(output.starts_with(&fallback));
        assert!(output
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .ends_with("-beer.copc.laz"));
        assert!(fallback.is_dir(), "フォールバック先ディレクトリを作るはず");
    }

    #[test]
    fn multi_output_file_name_for_single_file_matches_single_file_naming() {
        assert_eq!(
            multi_output_file_name(&["09LD2626.las".to_string()]),
            "09LD2626.copc.laz"
        );
    }

    #[test]
    fn multi_output_file_name_shows_first_name_and_remaining_count() {
        let names: Vec<String> = (26..=29).map(|n| format!("09LD26{n}.las")).collect();
        assert_eq!(
            multi_output_file_name(&names),
            "09LD2626 ほか3ファイル.copc.laz"
        );
    }

    #[test]
    fn multi_output_file_name_is_order_independent_given_sorted_input() {
        let mut names = vec![
            "b.las".to_string(),
            "a.las".to_string(),
            "c.las".to_string(),
        ];
        names.sort();
        assert_eq!(multi_output_file_name(&names), "a ほか2ファイル.copc.laz");
    }

    #[test]
    fn resolve_multi_output_path_always_uses_fallback_dir() {
        let dir = tempfile::tempdir().expect("tempdir");
        let fallback = dir.path().join("converted");
        let names = vec!["a.las".to_string(), "b.las".to_string()];

        let output = resolve_multi_output_path(&names, &fallback).unwrap();

        assert_eq!(output, fallback.join("a ほか1ファイル.copc.laz"));
        assert!(fallback.is_dir());
    }

    #[test]
    fn fallback_names_differ_for_different_source_paths_with_same_basename() {
        let dir = tempfile::tempdir().expect("tempdir");
        let fallback = dir.path().join("fallback");
        let a = Path::new("/one/does-not-exist/beer.laz");
        let b = Path::new("/two/does-not-exist/beer.laz");

        let out_a = resolve_output_path(a, &fallback).unwrap();
        let out_b = resolve_output_path(b, &fallback).unwrap();

        assert_ne!(out_a, out_b, "元パスが違えば衝突しない名前になるはず");
    }
}
