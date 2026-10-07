//! M4-6: メモリ確保の失敗を検知し、devtoolsのconsoleへメッセージを出す。
//!
//! # なぜ必要か
//!
//! `TaskSheets/M4-import-and-conversion.md`のM4-6b追記・`init_panic_hook`
//! (`lib.rs`)は、Rustの**panic**をconsoleへ出す。しかし
//! `vec![0u8; huge_len]`のような大きな確保が失敗したとき、Rustは
//! panic機構を通さずに`std::alloc::handle_alloc_error`を呼び、これは
//! wasm32-unknown-unknownでは`unreachable`命令で即座にトラップする
//! (標準の`#[alloc_error_handler]`はnightly限定の不安定機能で、この
//! プロジェクトが使っているstableツールチェーンでは使えない)。つまり
//! **panicフックが有効でも、メモリ確保の失敗だけはメッセージを残さず
//! `unreachable`で落ちる**(実際にM4-6のOPFS不具合がこの形で発生した。
//! `opfs.rs`のモジュールドキュメント参照)。
//!
//! # やっていること
//!
//! `#[global_allocator]`で`std::alloc::System`を薄くラップし、
//! `alloc`/`alloc_zeroed`/`realloc`がnull(確保失敗)を返した瞬間に
//! `web_sys::console::error_1`でメッセージを出してから、そのままnullを
//! 返す(失敗という結果自体は変えない。すぐ後に`handle_alloc_error`が
//! 呼ばれ、今までどおり`unreachable`でトラップする)。
//!
//! ## 再入(リエントランス)について
//!
//! `web_sys::console::error_1`の呼び出し自体、wasm-bindgenの文字列
//! マーシャリング(`JsValue::from_str`)を通じて小さなアロケーションを伴う。
//! 直前の失敗が「数GBの一度きりの確保」であれば、この程度の小さい
//! アロケーションは通常成功する(大きな確保の失敗はwasm32の4GiBという
//! アドレス空間の天井にぶつかっただけで、その時点でメモリが実際に
//! 使われたわけではないため)。万一この小さな確保も失敗して再帰的に
//! この関数へ入った場合に備え、`thread_local`の真偽値で「今まさに
//! 報告中」かどうかを見て、再帰時は何もせず戻る(無限再帰を防ぐ。
//! wasm32-unknown-unknown(atomics無効)はシングルスレッドなので
//! `thread_local`で十分)。
//!
//! ## ネイティブターゲットでの扱い
//!
//! このクレートは`crate-type = ["cdylib", "rlib"]`で、`cargo test
//! --manifest-path crates/pcv-wasm/Cargo.toml`はネイティブターゲットでも
//! このrlibをコンパイル・リンクする。`web_sys`のJSバインディングは
//! 実際のJSホスト(ブラウザ)が無いと動かないため、ネイティブでは
//! メッセージを出す処理自体を行わない(`report_allocation_failure`の
//! ネイティブ版は何もしない)。`System`への委譲自体はどの対象でも
//! そのまま通るので、ネイティブのテストの挙動(確保の成功・失敗)は
//! 変えない。

use std::alloc::{GlobalAlloc, Layout, System};

/// `System`をそのまま使う(確保の挙動自体は変えない)。確保失敗(null)だけを
/// 検知してメッセージを出す。
struct ReportingAllocator;

unsafe impl GlobalAlloc for ReportingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let ptr = unsafe { System.alloc(layout) };
        if ptr.is_null() {
            report_allocation_failure();
        }
        ptr
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let ptr = unsafe { System.alloc_zeroed(layout) };
        if ptr.is_null() {
            report_allocation_failure();
        }
        ptr
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let new_ptr = unsafe { System.realloc(ptr, layout, new_size) };
        if new_ptr.is_null() {
            report_allocation_failure();
        }
        new_ptr
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) }
    }
}

#[global_allocator]
static ALLOCATOR: ReportingAllocator = ReportingAllocator;

// 2026-10-07追記: `report_allocation_failure`が確保失敗を検知したメッセージを
// consoleに出すのと同時にここへ残す。
//
// なぜ必要か: メモリ確保の失敗は直後に`handle_alloc_error`→`unreachable`で
// wasm命令レベルのトラップに落ち、JS側には`WebAssembly.RuntimeError`
// (メッセージは単に`"unreachable"`)としてしか伝わらない。画面のエラー表示
// (`src/datasource/copc.worker.ts`の`convert-failed`)はこの`unreachable`しか
// 受け取れず、所有者はdevtoolsのconsoleを開かないと詳細が見えなかった。
// `unreachable`のトラップ自体はこの関数(まだ正常に実行できている時点)の
// **後**で起きるため、ここに残した値は、呼び出し元の変換用Workerがcatch
// ブロックで`last_allocation_failure_message()`(このファイル下部)を呼んで
// 読み出せる(トラップはこの関数を呼び出した特定の処理を異常終了させるだけで、
// wasmインスタンス自体やこの`thread_local`の値を破壊しない。
// wasm32-unknown-unknownはatomics無効のシングルスレッドなので`thread_local`で
// 十分)。
#[cfg(target_arch = "wasm32")]
thread_local! {
    static LAST_FAILURE_MESSAGE: std::cell::RefCell<Option<String>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(target_arch = "wasm32")]
fn report_allocation_failure() {
    use std::cell::Cell;

    thread_local! {
        /// 再入防止(モジュールドキュメント「再入について」参照)。
        static REPORTING: Cell<bool> = const { Cell::new(false) };
    }

    let already_reporting = REPORTING.with(|flag| flag.replace(true));
    if already_reporting {
        return;
    }
    const MESSAGE: &str = "pcv-wasm: メモリの確保に失敗しました。入力が大きすぎて、ブラウザの \
         メモリ上限(wasm32は最大4GiB)を超えた可能性があります。";
    LAST_FAILURE_MESSAGE.with(|cell| *cell.borrow_mut() = Some(MESSAGE.to_string()));
    web_sys::console::error_1(&wasm_bindgen::JsValue::from_str(MESSAGE));
    REPORTING.with(|flag| flag.set(false));
}

/// ネイティブ(`cargo test`)では何もしない。モジュールドキュメント
/// 「ネイティブターゲットでの扱い」参照。
#[cfg(not(target_arch = "wasm32"))]
fn report_allocation_failure() {}

/// 直前にメモリ確保の失敗が起きていれば、そのメッセージを返す
/// (`lib.rs`の`last_allocation_failure_message`経由でJS側に公開する)。
/// 2回目以降呼んでも同じ値を返す(`unreachable`トラップの直後は
/// どうせWorkerを終了させる前提なので、一度読んだら消す必要はない)。
#[cfg(target_arch = "wasm32")]
pub(crate) fn last_allocation_failure_message() -> Option<String> {
    LAST_FAILURE_MESSAGE.with(|cell| cell.borrow().clone())
}

#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn last_allocation_failure_message() -> Option<String> {
    None
}
