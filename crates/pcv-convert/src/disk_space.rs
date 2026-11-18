use std::io;
use std::path::Path;

pub const TEMP_SIZE_FACTOR: f64 = 11.0;

pub fn required_free_bytes(input_len: u64) -> u64 {
    (input_len as f64 * TEMP_SIZE_FACTOR).ceil() as u64
}

pub fn has_enough_free_space(input_len: u64, available_free_bytes: u64) -> bool {
    available_free_bytes >= required_free_bytes(input_len)
}

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
    // SAFETY: `wide` is NUL-terminated UTF-16 that outlives the call; the two unused out-params are optional and may be null.
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

    // SAFETY: `statvfs` is plain old data, so all-zero bytes are a valid value.
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    // SAFETY: `c_path` is NUL-terminated and outlives the call; `stat` is a valid stack value.
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
        assert_eq!(required_free_bytes(3), 33);
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
        #[cfg(windows)]
        {
            let free = free_bytes_at(Path::new(".")).expect("空き容量の取得に失敗した");
            assert!(free > 0);
        }
    }
}
