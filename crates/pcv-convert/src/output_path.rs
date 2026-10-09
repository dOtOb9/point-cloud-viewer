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

/// M4-14: 複数ファイル(マージ変換)の出力ファイル名。
///
/// `sorted_file_names`は**ファイル名の昇順にソート済み**であること(選択した
/// 順序に依存しない名前にするため。呼び出し側=`src-tauri/src/conversion.rs`
/// が`collect_input_paths`相当のソートを済ませてから渡す)。
///
/// 表示名は「<先頭ファイルの拡張子抜きの名前> ほか<残り件数>ファイル」
/// (要件の例「09LD2626 ほか54ファイル」のとおり)。**衝突を避けるハッシュ等は
/// 付けない**: 違うファイル集合が同じ先頭ファイル名+件数になる(例: 別の
/// フォルダの同名ファイルを先頭に55個選ぶ)可能性はあるが、キャッシュの
/// 正しさは`cache::MultiSourceFingerprint`(サイドカー)が担保するので、
/// ファイル名が衝突しても「キャッシュが外れて作り直すだけ」で済む
/// (`resolve_output_path`が元ファイルの指紋だけで安全性を保つのと同じ考え方)。
pub fn multi_output_file_name(sorted_file_names: &[String]) -> String {
    debug_assert!(!sorted_file_names.is_empty(), "呼び出し側が空でないことを保証する");
    if sorted_file_names.len() == 1 {
        return copc_output_file_name(&sorted_file_names[0]);
    }
    let first = copc_output_file_name(&sorted_file_names[0]);
    let first_stem = first.strip_suffix(".copc.laz").unwrap_or(&first);
    let rest = sorted_file_names.len() - 1;
    format!("{first_stem} ほか{rest}ファイル.copc.laz")
}

/// M4-14: 複数ファイルの出力先を決める。単一ファイル版(`resolve_output_path`)
/// と違い、**常に`fallback_dir`(アプリのキャッシュディレクトリ)に置く**
/// (入力が複数のディレクトリに散らばっている場合「元ファイルの隣」という
/// 概念が定まらないため。単純さを優先した割り切り)。
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
        // 呼び出し側がソート済みの配列を渡す前提なので、同じ集合なら常に
        // 同じ名前になる(受け入れ条件「同じ選択を二度変換しない」の一部)。
        let mut names = vec!["b.las".to_string(), "a.las".to_string(), "c.las".to_string()];
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

        // どちらも実在しない親を持つので必ずフォールバックへ落ちる。
        let out_a = resolve_output_path(a, &fallback).unwrap();
        let out_b = resolve_output_path(b, &fallback).unwrap();

        assert_ne!(out_a, out_b, "元パスが違えば衝突しない名前になるはず");
    }
}
