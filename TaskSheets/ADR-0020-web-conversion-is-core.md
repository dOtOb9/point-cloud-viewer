# ADR-0020: In-browser conversion is a core feature of the Web build

Status: accepted (owner, 2026-10-18).

## Context

On 2026-10-18 the owner, reading `src/state/useFileOpen.ts` and the Rust crates, asked whether the codebase had grown too large
"to make a Tauri app work on the Web". The coordinator measured it (line counts of non-test `.ts` / `.rs` files, comments
included; `wc -l`, 2026-10-18, at c869afb):

| part | lines |
|---|---|
| whole app (`src/`, `crates/`, `src-tauri/`, `vendor/copc-writer/`) | about 43,000 |
| Web-only conversion, TypeScript (`web.ts`, `opfs.ts`, `copc.worker.ts`, `web-protocol.ts`, `laz-decompress.worker.ts`, `decompress-partition.ts`, `point-count-estimate.ts`, `copc-header.ts`, `useOpfsStorage.ts`) | about 3,800 |
| Web-only conversion, Rust (`crates/pcv-wasm`: `convert`, `opfs`, `pcd_import`, `ply_import`, `e57_import`, `point_file_import`, `file_reader`, `alloc_guard`, `write_metadata`, `extract`) | about 4,550 |
| Web viewing only (`crates/pcv-wasm`: `lib`, `http_reader`, `range_math`, `dto`) | about 650 |

So viewing COPC on the Web costs little (the renderer and UI are WebGPU and React on both builds, ADR-0001). **Converting in the
browser** costs about 8,400 lines, about a fifth of the app. It is expensive because it meets every browser limit at once: no
file paths, OPFS as the only writable place, one Worker and no `SharedArrayBuffer` on GitHub Pages (conversion is driven in small
batches from TypeScript), and `pcv-wasm` cannot depend on `pcv-convert` (readers are duplicated).

The coordinator suggested making the Web build view-only, with a toolbar button to the GitHub Releases page for conversion.

## Decision

**Keep conversion (and the tools that write new COPC files) in the Web build.** The owner's reason: at construction companies,
installing a desktop app often does not get security approval, so people want the browser version. Their data is LAS/LAZ/E57,
not COPC. For them a Web build that cannot convert opens nothing, and a "download the desktop app" button does not help.

This confirms the owner decision of 2026-10-17 ("the Web and desktop builds do the same things") with its reason and cost written down.

## Consequences

- The ~8,400 lines are a necessary cost, not bloat. Do not propose removing Web conversion to shrink the codebase.
- Reduce the **accidental** part instead:
  - the Rust readers duplicated between `crates/pcv-convert` and `crates/pcv-wasm` (PCD/PLY/E57, scale/offset choice,
    `write_metadata.rs`; the two `write_metadata.rs` already differ in CRS handling — check whether that is intended),
  - the remaining `instanceof WebSource` branches in `useConversionSession.ts` and `usePointCloudTools.ts` (R9 removed the ones in `useFileOpen.ts`),
  - code nothing calls (R10).
- A link to the desktop release still fits **as a fallback** when the Web build hits its limits (wasm 4 GB address space, OPFS
  quota, a browser without OPFS or WebGPU), for people who are allowed to install. Not decided; a separate task if wanted.
- Security reviews: the Web build converts inside the browser and does not upload point data. This is how it is designed; network
  traffic has not been inspected to confirm it. Confirm before telling a customer.

## Rejected alternative

**View-only Web build with a link to GitHub Releases.** It would remove about 8,400 lines, the Web OPFS settings page and the Web
conversion E2E (ADR-0016), but it removes the only way the main Web users can open their data.

## Not verified (risks for the target users)

- Corporate PCs may have WebGPU disabled (old Edge, GPU driver blocklists, admin policy). Then the Web build cannot even display.
- Corporate networks may block `github.io`. Then the build must be hostable elsewhere (another domain or an internal server).

Neither has been tried in a real company environment.
