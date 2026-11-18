use std::cell::Cell;
use std::rc::Rc;

#[derive(Clone, Default)]
pub struct BytesReadCounter(Rc<Cell<u64>>);

impl BytesReadCounter {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn add(&self, bytes: u64) {
        self.0.set(self.0.get() + bytes);
    }

    pub fn total(&self) -> u64 {
        self.0.get()
    }
}
