# R10: Remove TypeScript code that nothing calls

Owner decision (2026-10-18): "Code that nothing calls is deleted." Scope of this task: TypeScript under `src/` only.
Rust (`pub` items no one uses) is not checked yet and is out of scope.

## How the list was made

`node scripts/find-unused-ts.cjs <repo root>` (added with this sheet; the header explains what it checks and its limits), run by
the coordinator on 2026-10-18 at c869afb, then `grep` over `e2e/`, `scripts/` and `docs/book/` for each name, because calls made
through a string are invisible to the language service.

## Delete

No reference anywhere (code, tests, e2e, scripts):

- `src/state/useLayers.ts`: `resetView` (in `Layers`, the `Pick` list in `viewer-types.ts`, the assembly in `useCopcViewer.ts`).
  `docs/book/src/flows/layers.md` already says nothing calls it.
- `src/state/useDisplaySettings.ts`: the global `pointShape` / `setPointShape` (the per-layer shape, `setLayerPointShape`, is
  used and stays). Same three places as above.
- `src/state/useLayerTool.ts`: `start` in `LayerToolState`; `src/state/useMeasureTool.ts`: `start` in `MeasureToolState`
  (AppShell uses `toggle` and `stop`).
- `src/datasource/tauri.ts`: `pickLocalFile` (the single-file picker; `pickLocalFiles` replaced it).
- `src/datasource/tools.ts`: `EMPTY_SELECTION_MESSAGE`.
- `src/datasource/node-format.ts`: `NODE_FLAG_INTENSITY`, `NODE_FLAG_CLASSIFICATION`. If a comment there documents the binary
  format with these flags, keep the explanation in the comment.
- `src/renderer/point-cloud-renderer.ts` (`PointCloudRenderer`): `getLayerColorMode`, `getLayerPointShape`, `getLayerPointSize`,
  `isCameraAnimating`, `debugCameraState`, `getAnimationEnabled`, `getBackgroundMode`, `getGridEnabled`, `setEdlStrength`,
  `getEdlStrength`, `setEdlRadiusPx`, `getEdlRadiusPx`, `getCenterPriorityStrength`, `getMinCenterPriorityWeight`.
- `src/renderer/node-cache.ts` (`NodeCache`): `get`, `values`.
- `src/renderer/colormap.ts`: `COLOR_MODES`, `DEFAULT_COLOR_MODE`. `src/renderer/scene-bounds.ts`: `mergeValueRanges`.
  `src/renderer/edl.ts`: the type `Vec3`.

### Follow-ups (cascade)

After a deletion, what it alone used may become unused. Delete that too, in the same commit, and list it in the Record. Expected:
- `renderer.resetView` (only `useLayers.resetView` calls it, per `flows/layers.md` line 54) — check; delete if nothing else calls it.
- `renderer.setPointShape` (only `useDisplaySettings.setPointShape` calls it). **Careful:** the renderer's global point shape may
  still be read as the default for layers added without a shape (`point-cloud-renderer.ts` around line 169 and 319). If the field
  is still read, keep what is read and remove only the setter; say what you found.
- Private fields or helpers that only a deleted method used (e.g. EDL strength / radius state, if nothing else sets or reads it).
  If a value becomes a constant, keep it as a named constant with its comment.
- Re-run `node scripts/find-unused-ts.cjs .` at the end and list what it still reports.

## Keep (do not delete)

- `PointCloudRenderer` getters that `scripts/igpu-bench/bench.mjs` calls by name: `getPointBudget`, `getAutoPointBudgetEnabled`,
  `getAutoPointBudgetMax`, `getEdlEnabled`, `getIsMobile`, `getPointShape`, `getRenderScale`. Add a short English comment above
  each (or one above the group) saying the bench script calls them by name, so the next search does not delete them.
- Everything the script reports as TEST-ONLY: these are mostly CPU copies of shader math (`edlShadingFactor`, `linearizeDepth`,
  `elevationToColor`, ...) kept so the WGSL logic can be unit-tested, plus test helpers. Out of scope; list them in the Record unchanged.
- Hook members the script reports only because they are passed between hooks inside `useCopcViewer.ts` (`*Deps` fields,
  `layersStateRef`, `commitLayers`, `nextLayerId`, `extraSelectedIds`, `addOpenedLayer`, `openFile`, `onStats`, ...). They are used.
- All Tauri commands (each of the 9 is invoked from `src/`).

## Acceptance criteria

1. Every name under "Delete" is gone (`grep -rn "<name>" src` shows no definition or use; a same-named different symbol is fine — say so).
2. The bench getters carry the comment. `scripts/igpu-bench/bench.mjs` is unchanged.
3. `docs/book/` no longer describes deleted code: at least `frontend/datasource.md` (mentions `EMPTY_SELECTION_MESSAGE` and
   `pickLocalFile`), `flows/layers.md` (the 視点のリセット row and step 3), `flows/settings.md` if it lists the deleted EDL setters.
   Japanese.
4. `npx tsc --noEmit`, `npm run lint`, `npx vitest run` and the Playwright E2E specs pass (free `PCV_E2E_PORT`, stop only your own
   processes; ADR-0016). CI green after push (give the run id). If E2E fails with "Target crashed" during "一時ファイルを開いています",
   that is a known, separate problem (see below): rerun once, and report it with the run id; do not try to fix it here.
5. Commits, one concern each, with `♻️ refactor` for deletions (the CLAUDE.md table has no separate type for removal), for example:
   `♻️ refactor: 呼ばれていない resetView を消す`, `♻️ refactor: 呼ばれていない全体の点の形の設定を消す`,
   `♻️ refactor: 呼ばれていないツールの start を消す`, `♻️ refactor: datasource の使われていない関数と定数を消す`,
   `♻️ refactor: レンダラの使われていない getter と EDL の設定を消す`, `📝 docs(book): ...`, `📝 docs: R10 の記録を書く`.

## Known separate problem (not this task)

CI run 39051736460, attempt 1: two Web conversion E2E specs failed with "Target crashed" (the browser tab crashed) and
"WebGPU device lost", both during the preparation step "一時ファイルを開いています(54/256)" / "(32/256)". The same step as the
phone crashes in M4-11 (`TaskSheets/M4-import-and-conversion.md`, "M4-6 追記4"). The coordinator will investigate it separately.

## Owner checks

- The app opens a file, and layers can be shown/hidden, recoloured, resized, focused, removed (nothing user-facing is meant to change).
- Measurement (距離・高さ・面積) and 点の選択・断面 still start and stop from the toolbar.
- EDL on/off and point budget settings still work.

## Record (filled in by the implementer)

- Files touched:
- Deleted (including cascades):
- Kept although listed, and why:
- What `find-unused-ts.cjs` still reports at the end:
- `renderer.setPointShape` / the global shape: what was found:
- Commands run and their results (tsc, lint, vitest counts, E2E, CI run id):
- Not checked:
