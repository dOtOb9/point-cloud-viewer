# ADR-0019: Carry point records through the LOD partition, finish small subtrees in memory

Status: accepted (coordinator, 2026-10-15). Implementation: task L3-B.

## Context

Measurements (`BENCH-conversion-profile.md`, L2-H report):

| stage (s) | 0.35B pts | 0.73B pts | 1.06B pts |
|---|---|---|---|
| LOD index | 208 | 631 | 915 |
| node compression | 63 | 1655 | 3481 |

Node compression throughput falls from 5.5M to 0.3M points/s once the spill (18.5 GB → 38.6 GB → 56 GB)
no longer fits in RAM (31.8 GiB). During compression of the 0.73B run the disk read 200–500 MB/s for
~1400 s, i.e. roughly **490 GB read from a 38.6 GB spill** (about 13×).

Cause: the current pipeline (`vendor/copc-writer/src/lod.rs`, `writer.rs`) partitions **point indices**,
not points. The LOD stage and the compression stage both fetch each point from the mmapped spill through its
index. A node's points are scattered over the spill in input (scan-line) order, so every point touches a
different 4 KB page. Once the spill exceeds RAM, each point costs a disk page read. Reordering the nodes
depth-first (tried in L2-H) only cut compression by 16%, because the scatter is *within* each node.

The owner also wants 10 billion points on the current machine (about 227 GB free, no external disk), so the
temporary disk use per point must shrink as well (task L3-A measures the spill layout).

## Decision

Make every pass over the data sequential:

1. **Runs carry records, not indices.** The root run is the spill itself. Partitioning a run reads it
   sequentially and appends each point's full record to one of 8 child run files (buffered, sequential
   writes). Points chosen for the parent node are appended to that node's own record list.
2. **Sampling stays as M4-16 decided.** The parent's points are taken evenly across the whole run (not from
   its start). This needs the per-child counts first, so a partition is two sequential reads of the run
   (count, then route). The selected set must be the same rule as today, so outputs stay comparable.
3. **Small subtrees are finished in memory.** When a run fits a memory budget (a parameter; default about
   1 GiB on desktop, much smaller on Web/mobile), load it, build the rest of that subtree in memory, and
   compress its nodes straight from memory. No spill reads happen in the compression of those nodes.
4. **Delete a run as soon as it has been partitioned**, so the disk peak is about two copies of the data at
   the top levels, not one copy per level.
5. Node chunks are written in subtree order. COPC does not require any chunk order; the hierarchy records
   each node's offset. Subtrees can be processed in parallel with a bounded number of in-memory subtrees at
   a time, so memory stays bounded and does not scale with the point count.

Expected cost (estimate, unverified): with a 1 GiB budget and 53 bytes/point, 1B points need two 8-way disk
levels; total sequential I/O is a few hundred GB at SSD speed, i.e. minutes, not an hour.

## Alternatives not taken

- **Depth-first node order only** (L2-H): measured, 16% on compression; does not fix the scatter.
- **Sort indices within a node before fetching**: still one page per point when points are spread over a
  38 GB file.
- **Spatial bucketing during the first spill write** (Untwine/PotreeConverter 2 style): similar effect, but
  needs the bounds before the first pass and changes the input stage too. Carrying records through the
  existing partition keeps the current structure and sampling rule and is easier to follow.
- **Bigger RAM / external disk**: not available.

## Consequences

- The LOD index file (`order`) of point indices disappears for records handled this way; the spill is read
  sequentially a small number of times.
- Disk peak becomes about 2× the record data at the top levels plus the output. Shrinking the record size
  (L3-A's numbers) lowers it further.
- Web uses the same code through `ScratchFs`; the in-memory budget must be small there.
