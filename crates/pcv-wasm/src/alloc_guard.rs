use std::alloc::{GlobalAlloc, Layout, System};

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

#[cfg(target_arch = "wasm32")]
thread_local! {
    static LAST_FAILURE_MESSAGE: std::cell::RefCell<Option<String>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(target_arch = "wasm32")]
fn report_allocation_failure() {
    use std::cell::Cell;

    thread_local! {
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

#[cfg(not(target_arch = "wasm32"))]
fn report_allocation_failure() {}

#[cfg(target_arch = "wasm32")]
pub(crate) fn last_allocation_failure_message() -> Option<String> {
    LAST_FAILURE_MESSAGE.with(|cell| cell.borrow().clone())
}

#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn last_allocation_failure_message() -> Option<String> {
    None
}
