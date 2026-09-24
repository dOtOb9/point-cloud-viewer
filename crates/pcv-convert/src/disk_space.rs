//! M4-3: 変換の前に空き容量を確かめる。
//!
//! `ADR-0006-conversion-strategy.md`の実測(sofi.copc.laz: 入力2.03GB、
//! 一時ファイルのピーク使用量21.864GB、比は約10.75倍。M4-1bの表の
//! 「ピーク一時ディスク」行を参照)を根拠に、安全側へ切り上げて
//! **11倍**を必要な空き容量の見積もりとする。
//!
//! 実際の空き容量の取得(`free_bytes_at`)はOS依存の実装を2つ持つ。
//! Windows(デスクトップ)は`GetDiskFreeSpaceExW`、それ以外のUnix系
//! (Android・Linux・macOS)は`statvfs(2)`を使う。ADR-0006の追記どおり
//! Androidも変換対象になったため、Androidだけ未実装のまま残さない
//! (AndroidはLinuxカーネルの上で動くため、`statvfs`はJNIを介さず
//! 素のRustから呼べる。特別扱いが要らない)。

use std::io;
use std::path::Path;

/// 一時ファイルの合計が入力サイズの何倍になりうるか。
///
/// 計算根拠: sofi.copc.laz 2.03GB(`TaskSheets/TEST-DATA.md`。GB=10^9換算で
/// およそ2,030,000,000バイト) → 一時ファイルピーク21.864GB
/// (21,864,486,524バイト。`M4-import-and-conversion.md` M4-1bの表)。
/// 比 ≈ 21,864,486,524 / 2,030,000,000 ≈ 10.77倍。安全マージンを見て
/// 11倍を採用する(ADR-0006本文の概算「約11倍」とも一致する)。
pub const TEMP_SIZE_FACTOR: f64 = 11.0;

/// 入力サイズから、変換に必要な空き容量を見積もる。
pub fn required_free_bytes(input_len: u64) -> u64 {
    (input_len as f64 * TEMP_SIZE_FACTOR).ceil() as u64
}

/// 空き容量が足りているか。ファイルI/Oをしない純粋関数
/// (`available_free_bytes`は呼び出し側が`free_bytes_at`等で取得して渡す)。
pub fn has_enough_free_space(input_len: u64, available_free_bytes: u64) -> bool {
    available_free_bytes >= required_free_bytes(input_len)
}

/// `path`があるドライブの空き容量を取得する。`path`自体が実在しなくてもよい
/// (実在する祖先ディレクトリまで遡ってから問い合わせる。出力先・一時ファイル
/// 置き場所はこの時点でまだ作られていないことがあるため)。
#[cfg(windows)]
pub fn free_bytes_at(path: &Path) -> io::Result<u64> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;

    let mut dir = path;
    while !dir.exists() {
        match dir.parent() {
            Some(parent) if !parent.as_os_str().is_empty() => dir = parent,
            _ => break,
        }
    }
    let wide: Vec<u16> = dir
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let mut free_bytes_available_to_caller: u64 = 0;
    // SAFETY: `wide`はヌル終端されたUTF-16文字列で、呼び出しが終わるまで生存する。
    // 出力引数のうち使わない2つ(合計容量・全体の空き容量)には`null`を渡す
    // (Win32 APIの仕様上、個別にoptionalでnullを許容する)。
    let ok = unsafe {
        GetDiskFreeSpaceExW(
            wide.as_ptr(),
            &mut free_bytes_available_to_caller,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(free_bytes_available_to_caller)
}

/// Unix系(Android・Linux・macOS)向け。`statvfs(2)`の`f_bavail`(非特権プロセスが
/// 使える残りブロック数)× `f_frsize`(ブロックサイズ)を返す。`f_bavail`を
/// 使うのは、Windows版の`GetDiskFreeSpaceExW`が返す
/// 「呼び出し元が使える空き容量」(クォータ等を考慮した値)と揃えるため
/// (`f_bfree`は特権プロセス向けの、クォータを考慮しない値)。
#[cfg(unix)]
pub fn free_bytes_at(path: &Path) -> io::Result<u64> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let mut dir = path;
    while !dir.exists() {
        match dir.parent() {
            Some(parent) if !parent.as_os_str().is_empty() => dir = parent,
            _ => break,
        }
    }
    let c_path = CString::new(dir.as_os_str().as_bytes())
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))?;

    // SAFETY: `c_path`はヌル終端されたバイト列で、呼び出しが終わるまで生存する。
    // `stat`はスタック上に確保し、有効なポインタとして渡す。
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    let result = unsafe { libc::statvfs(c_path.as_ptr(), &mut stat) };
    if result != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(u64::from(stat.f_bavail) * u64::from(stat.f_frsize))
}

#[cfg(not(any(windows, unix)))]
pub fn free_bytes_at(_path: &Path) -> io::Result<u64> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "空き容量の確認はWindows/Unix系専用の実装のみ持つ",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn required_free_bytes_multiplies_by_factor() {
        assert_eq!(required_free_bytes(1_000), 11_000);
    }

    #[test]
    fn required_free_bytes_rounds_up() {
        // 1001 * 11.0 = 11011.0 (割り切れる例。端数が出る例も足す)
        assert_eq!(required_free_bytes(3), 33);
        // 端数が出るケース: TEMP_SIZE_FACTORは整数なのでu64入力では基本割り切れるが、
        // ceil()を呼んでいること自体を確認する回帰テストとして残す。
        assert_eq!(required_free_bytes(0), 0);
    }

    #[test]
    fn has_enough_free_space_true_when_exactly_enough() {
        assert!(has_enough_free_space(1_000, 11_000));
    }

    #[test]
    fn has_enough_free_space_false_when_short_by_one_byte() {
        assert!(!has_enough_free_space(1_000, 10_999));
    }

    #[test]
    fn free_bytes_at_current_dir_returns_a_positive_number_on_windows() {
        // 開発機・CI(windows-latest)はどちらもWindowsなので、このテストは
        // 実際にWin32 APIを呼ぶ(モックしない)。カレントディレクトリの
        // ドライブには通常わずかでも空きがあるはず。
        #[cfg(windows)]
        {
            let free = free_bytes_at(Path::new(".")).expect("空き容量の取得に失敗した");
            assert!(free > 0);
        }
    }
}
