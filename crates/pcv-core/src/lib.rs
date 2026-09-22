//! pcv-core: COPC読込・octree走査・解析アルゴリズムを担う crate。
//!
//! この crate は tauri に依存しない。ネイティブ (x86_64-pc-windows-msvc など) と
//! wasm32-unknown-unknown の両方でビルドできることが Web 版バックエンドを成立させる条件
//! (ADR-0001 参照)。M0 時点では中身は空。

/// M0 時点のプレースホルダ。wasm ターゲットでもビルドが通ることの確認用。
pub fn placeholder() -> &'static str {
    "pcv-core"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn placeholder_returns_name() {
        assert_eq!(placeholder(), "pcv-core");
    }
}
