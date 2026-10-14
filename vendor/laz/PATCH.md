# Why this crate is in vendor/

A copy of [`laz` 0.12.2](https://crates.io/crates/laz) (laz-rs, Apache-2.0) with **one change**.

- Upstream: https://github.com/tmontaigu/laz-rs
- Taken from the crates.io 0.12.2 package; `examples/`, `tests/`, `benches/` and the dev-dependencies
  were removed so that the vendored copy has nothing extra to resolve.

## What was changed

`src/laszip/sequential/decompression.rs`, `LasZipDecompressor::seek`. After finding the chunk that holds the
wanted point, the old code decoded `point_idx % chunk_point_count` points inside that chunk:

```rust
let delta = point_idx % chunk_table[self.current_chunk].point_count;
```

That is right only when every chunk has the same number of points. COPC files use **variable-size chunks**
(laszip VLR `chunk_size = 0xFFFFFFFF`; one chunk per octree node), so after a seek the decoder was at the
wrong point. The new code uses the real offset inside the chunk:

```rust
let points_before_chunk: u64 = (0..self.current_chunk).map(|i| chunk_table[i].point_count).sum();
let delta = point_idx - points_before_chunk;
```

For fixed-size chunks both give the same value, so nothing changes there.

## Why we need it

The Web conversion/merge splits a file into point ranges and each Worker does `las::Reader::seek(start)`
(`crates/pcv-wasm/src/convert.rs`, `RangeDecompressorCore`). With a COPC input (autzen-classified.copc.laz,
10,653,336 points) the ranges started at the wrong points. Some of them then ran past the end of their chunk
and read the next chunk's bytes as a layer size, and `Vec::resize` with that garbage size panicked with
`capacity overflow` on wasm32 (the same read on a 64-bit machine returns
`IoError: failed to fill whole buffer` instead of panicking). Sequential reads were always right.

The regression test is `range_of_variable_chunk_copc_matches_the_same_slice_of_a_full_read` in
`crates/pcv-wasm/src/convert.rs`.

## When can this be removed

When a laz release computes the offset inside a variable-size chunk correctly. Check that the test above
passes without the `[patch.crates-io]` entry before removing it.
