# G2-1 / G2-3: section points as (s, z) and the 2D cross-section panel

Record of steps G2-1 and G2-3 of `G1-raster-and-dtm.md` section 8. Written in English per CLAUDE.md
(owner decision 2026-10-15: new `TaskSheets/` files are English). The book chapter
(`docs/book/src/flows/point-cloud-tools.md`, 3-D) is in Japanese.

## What was built

| Part | Where |
|---|---|
| G2-1 Rust: section layer -> `(s, z)` + colour, capped and thinned | `crates/pcv-core/src/profile.rs` (+ `CopcFile::read_node_points` in `copc.rs`) |
| Desktop entry: Tauri command `read_section_profile` (binary response, `spawn_blocking`, `catch_unwind`) | `src-tauri/src/copc_state.rs`, registered in `lib.rs` |
| Web entry: `WasmCopcFile.readSectionProfile`, Worker message `sectionProfile`, `WebSource.readSectionProfile` | `crates/pcv-wasm/src/lib.rs`, `src/datasource/copc.worker.ts`, `web-protocol.ts`, `web.ts` |
| Buffer decoder and types | `src/datasource/section-profile.ts` |
| Section info kept on the layer (`ViewerLayer.section`: A, B, up, thickness) | `src/state/layers.ts`, `src/app/open-files.ts` (`addOpenedLayer` 5th argument), `src/state/useLayerTool.ts`, `src/app/point-cloud-tools.ts` |
| Panel state (`useState` only) | `src/state/useSectionView.ts` |
| Steps (open / close / resize / wheel zoom / pointer input) | `src/app/section-view.ts` (uses `section-math.ts`: `zoomAt`, `panBy`, `fitView`, `classifyRightPress`, `classifyOneFinger`, `twoFingerStep`) |
| Drawing (ImageData + axes) | `src/renderer/section-2d.ts` |
| Panel UI | `src/ui/section/SectionPanel.tsx`, mounted in `AppShell.tsx` |

New blocks are marked `// --- G2: cross-section view ---` where they sit inside existing files (so they can be told apart
from the parallel rasterize work, W1).

## Design decisions

- **Buffer layout** (little endian): 24-byte header `u32 count, u32 flags, f32 sMin, sMax, zMin, zMax`, then 12 bytes per
  point `f32 s, f32 z, u8 r, g, b, classification`. 24 is a multiple of 4, so the browser views the records as
  `Float32Array` / `Uint32Array` with stride 3 without copying. The 4th byte is the classification, not a colour:
  for a cloud without RGB the browser colours by `classificationToColor` (`colormap.ts`), so the ASPRS palette is not
  copied into Rust. `flags` bit 0 = thinned, bit 1 = has colour.
- **s and z**: `s` = dot(P - A, along), with `along` = A->B with its `up` component removed (same construction as
  `sectionBox`); `z` = dot(P, up_unit). `z` is the absolute height (what GL will mean in G2-6), not relative to A.
- **Thinning**: if the layer has at most `cap` (default 2,000,000) points, every point is returned. Otherwise a grid of at most
  `cap` cells over the layer's bounding box in `(s, z)` keeps the FIRST point of each cell. The number of kept points is
  at most the number of cells, so the cap holds by construction; the plan's "then stride if still over" cannot trigger and
  was not written. Memory = grid of `cap` x 12 B (about 24 MB), independent of the point count.
  Rejected: sampling every n-th point (no spatial guarantee: a dense wall would hide a sparse tree), and keeping the highest
  point per cell (hides the ground under trees in a thin section, and costs a compare per point for no clear gain).
- **Colour depth**: `CopcFile::read_node_points` (split out of `read_node`, which now calls it) returns 8-bit colour with
  the file-wide 8/16-bit decision already applied, so a section of an 8-bit-in-16-bit file is not drawn black.
- **View is `null` until the user moves it**: `null` means "fit all points into the panel", computed at render time from
  the panel size and the points (`effectiveSectionView`). This avoids React state that has to be set in the right order
  between "points arrived" and "panel was laid out". "全体表示" sets it back to `null`.
- **Gesture tracking** lives in a plain object (`SectionGesture`) created once in the hook, like `toolLock`: pointer moves come
  at 60+ Hz and the tracked pointers are not something to display.
  A right press stays "click" until it moves more than 5 px or is held 300 ms; the movement made before it became a pan
  is not lost (the pan anchor is still the press position).
- **Stale reads**: `token.generation` is bumped on every open and on close, so a read that finishes after a newer open
  or after closing is dropped. `openSectionPanel` reads only getters, setters and the token from its context, because
  the tool calls it long after the context was built.
- **Right click / one-finger long press** call `showGroundLevelAt()`, an empty function with a `TODO(G2-6)` (G2-6 gives it
  `(ctx, screen)`). The line itself (G2-4), editing (G2-5) and GL / slope (G2-6) are not in this step.
- **Rejected for drawing**: a second WebGPU pipeline and SVG (see plan 8.3).
- Draw cost: when a section has up to 300,000 points a point is 2x2 pixels (so a sparse section stays visible), above that 1 pixel.
  300,000 is a guess, not measured against looks.

## Tests

- Rust `cargo test -p pcv-core profile`: s/z values of a wall along x and of a wall in the plane x = 5 seen along +y
  (A and B at different heights; `up` not unit length), colour and classification carried over, no colour -> flag clear,
  thinning to a 200 x 200 wall with cap 1,000 (never above the cap, still covers the whole wall, flag set), cap equal to the
  point count does not thin, vertical A-B is an error, grid size never above the cell count for extreme spans.
- TS: `section-profile.test.ts` (decoder), `section-view.test.ts` (fake context: open ok / failure / refused layer /
  closed during read / replaced during read; fit and resize; wheel zoom keeps the point under the cursor; right-drag pan including
  the first pixels and long press; left button does nothing; right click moves nothing; two-finger pinch + pan; cancel),
  `section-2d.test.ts` (pixels, classification colours, edges, ticks), `point-cloud-tools.test.ts` (panel opens for a section only).

## Measured (commands and output)

Draw time of 2,000,000 points, `fillSectionPixels` into a 1200 x 800 buffer, random scatter (worst case for the cache),
1 pixel per point, Node 22 / V8, `npx vitest run src/renderer/section-2d.test.ts --disableConsoleIntercept`:

```
fillSectionPixels 2,000,000 points into 1200x800: 25.6, 27.3, 22.0, 19.7, 20.8 ms      (second run)
fillSectionPixels 2,000,000 points into 1200x800: 26.1, 25.0, 25.1, 48.1, 32.5 ms      (first run)
```

So the pixel fill is about 20 to 50 ms for the maximum 2,000,000 points. Not measured: `putImageData` and the axes for a
2,000,000-point section in the browser (the biggest real section tried was 827,754 points, below).

In the real page (Web build, headed Chromium, `adapter.info` = vendor nvidia, architecture lovelace, i.e. a real GPU, not SwiftShader)
the canvas carries `data-draw-ms` / `data-fill-ms` (whole draw / fill only), read with Playwright:

| Section (autzen-classified.copc.laz, 10,653,336 points) | points drawn | draw | fill |
|---|---|---|---|
| 1 m thick, wide screen 1280 x 800 | 8,345 | 1.6 ms | 0.7 ms |
| 2,000 m thick (8,061,470 points in the layer), after "全体表示" | 827,754 (thinned) | 6.1 ms | 5.7 ms |

The thick section was thinned from 8,061,470 to 827,754 points (the grid had empty cells, so fewer than the 2,000,000 cap).
Loading that section into the panel took longer than 2.5 s (the panel still said "読み込み中" at that time; not timed).

## Screens (real GPU, Web build via `vite preview`, headed Chromium)

Flags: `--enable-unsafe-webgpu --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows`.
Port 4391 (`vite preview --port 4391 --strictPort`), stopped afterwards.
Screenshots (outside the repo, in the session's scratchpad `.../scratchpad/shots/`): `wide-3-panel.png` (panel bottom right, source layer unticked),
`wide-4-zoomed.png` (after wheel zoom), `wide-5-panned.png` (after right-drag), `wide-6-reset.png`, `narrow-3-panel.png` (400 x 800,
full width at the bottom), `thick-6-reset.png` (thinning notice).

Seen: the panel appears bottom right with the points and a grid in m; the source layer's checkbox is off, the new layer's is on;
the wheel zooms about the cursor; the right-button drag pans; "全体表示" returns to the fit; the narrow layout puts the panel full width at the bottom.

## Not verified

- Touch on a real device (pinch, two-finger pan, one-finger long press): only the unit tests with a fake context.
- The desktop (Tauri) build: the command compiles (`cargo check` / clippy), but it was not called from a running app.
- Android.
- Light theme and the non-glass (mobile) tint of the panel.
- On a narrow screen the panel covers the layer drawer's open button (bottom left) while it is open; "閉じる" gives it back.
- The profile of very large sections in the browser (memory is bounded by construction and by the Rust test, but a 2,000,000-point
  section was not drawn on screen).

## How the owner can check

1. `npm run build`, `npx vite preview`, open the page, open `autzen-classified.copc.laz` (or any COPC).
2. "断面": click two points on the cloud, press "作る". The panel opens bottom right with the section seen from the side.
3. Wheel over the panel zooms about the cursor. Right button held and dragged pans (a quick right click does nothing yet).
   "全体表示" fits everything; "閉じる" closes the panel (the source layer stays hidden).
4. Try a very thick section (for example 2000 m) to see the "間引いて表示" notice.
5. On a phone: pinch zooms, two fingers drag pans.
