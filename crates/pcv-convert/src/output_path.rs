//! M4-3: 変換結果(COPC)をどこに書くかを決める。
//!
//! 受け入れ条件どおり、出力名は`<元ファイル名>.copc.laz`。まず元ファイルの
//! 隣に書くことを試み、書き込み権限が無い等で失敗する場合は
//! `fallback_dir`(呼び出し側=`src-tauri`がアプリのキャッシュディレクトリを渡す)
//! に置く。フォールバック時は複数の元ファイルが同じベース名を持つ場合の
//! 衝突を避けるため、元パス全体のハッシュをファイル名に前置する。

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::io;
use std::path::{Path, PathBuf};

/// "foo.las"/"foo.laz"(大文字小文字を問わない) → "foo.copc.laz"。
/// どちらの拡張子でもない場合は末尾にそのまま付け足す(呼び出し側は事前に
/// .las/.lazだけを対象にしている想定だが、何が来ても壊れない形にしておく)。
pub fn copc_output_file_name(source_file_name: &str) -> String {
    let lower = source_file_name.to_ascii_lowercase();
    let stem_len = if lower.ends_with(".laz") || lower.ends_with(".las") {
        source_file_name.len() - 4
    } else {
        source_file_name.len()
    };
    format!("{}.copc.laz", &source_file_name[..stem_len])
}

/// 出力先を決める。まず元ファイルの隣を試し、書き込めなければ`fallback_dir`
/// (実在しなければ作る)に置く。
///
/// 「書き込めるか」は実際に一時ファイルを作って消すことで確かめる
/// (OSごとに権限APIの意味が食い違うため、実際に試すのが確実)。
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
        // 呼び出し側は.las/.lazだけを渡す想定だが、壊れないことだけ確認する。
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
        // 存在しないディレクトリは`tempfile_in`が失敗する(=書き込めない)ため、
        // 実際に権限を落とす面倒な仕込みをせずに「書き込めない」経路を再現できる。
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
    fn fallback_names_differ_for_different_source_paths_with_same_basename() {
        let dir = tempfile::tempdir().expect("tempdir");
        let fallback = dir.path().join("fallback");
        let a = Path::new("/one/does-not-exist/beer.laz");
        let b = Path::new("/two/does-not-exist/beer.laz");

        // どちらも実在しない親を持つので必ずフォールバックへ落ちる。
        let out_a = resolve_output_path(a, &fallback).unwrap();
        let out_b = resolve_output_path(b, &fallback).unwrap();

        assert_ne!(out_a, out_b, "元パスが違えば衝突しない名前になるはず");
    }
}
