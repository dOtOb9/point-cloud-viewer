# R3: Ribbon → Toolbar, one component per button, flat row

Owner decision (2026-10-17): rename the top "ribbon" to **Toolbar** and lay its buttons out
**flat** (no group headings), the way the owner's earlier Unreal Engine version did it
(a `HorizontalBox` holding one concrete `ToolbarButton` subclass per button).

## Why

Today `Ribbon.tsx` computes `hasPointCloud` / `selectedPointCloudCount` / `toolRunning` and passes
them through `RibbonToolsGroup` into `RibbonButton`. To learn "when is the 断面 button disabled"
the owner has to read three files. With one component per button, each button file answers
"what it shows, when it can be pressed, what pressing does" on its own.

React has no widget inheritance; the UE "base class + concrete subclass" maps to
**composition**: `ToolbarButton` is the plain look (base), and each concrete button is a small
component that renders `<ToolbarButton ...>` with its own props (the "overrides").

## Target layout

```
src/ui/toolbar/
  Toolbar.tsx               // the HorizontalBox: lists the concrete buttons in order, separators between former groups
  ToolbarButton.tsx         // was RibbonButton.tsx (look only, no app state)
  ToolbarSeparator.tsx      // thin vertical line (replaces the group border)
  toolbar-styles.ts         // was ribbon-styles.ts (drop the GROUP_* classes that become unused)
  useToolbarDragScroll.ts   // was useRibbonDragScroll.ts
  toolbar-drag.ts / toolbar-drag.test.ts   // was ribbon-drag.*
  toolbar-state.ts          // small shared helpers, e.g. hasPointCloud(viewer), isToolRunning(viewer)
  buttons/
    OpenFileButton.tsx      // was RibbonFileGroup (Web: <label> + hidden <input type="file">, Tauri: pickLocalFiles)
    MeasureButton.tsx       // kind = "distance" | "height" | "area" (one component, used 3 times)
    SelectPointsButton.tsx
    SectionButton.tsx
    MergeLayersButton.tsx
    SettingsButton.tsx
```

`Toolbar.tsx` renders, in this order:
OpenFile | separator | Measure(distance), Measure(height), Measure(area), SelectPoints, Section, MergeLayers | separator | Settings.

Each concrete button takes only the state it needs as props (`viewer`, `measure`, `layerTool`,
`onOpenSettings`). No React Context, no config-object array with `isEnabled(ctx)` callbacks.

## Acceptance criteria

1. `src/ui/ribbon/` no longer exists; the files above exist under `src/ui/toolbar/`. Use `git mv` so history follows.
2. No group headings ("ファイル" / "ツール" / "設定") are rendered; separators sit where group borders were.
3. Behaviour is unchanged: same labels, tooltips (`title`), `active` / `disabled` conditions, click actions,
   narrow-viewport placement, drag-scroll, glass surface. Compare against the old `RibbonToolsGroup.tsx` /
   `RibbonFileGroup.tsx` line by line.
4. `data-testid="ribbon"` stays on the Toolbar root (renaming it is out of scope; grep e2e/ and src/ for users).
   `data-testid="file-input"` stays on the `<input type="file">`. Update the CLAUDE.md table row for `file-input`
   to the new path `src/ui/toolbar/buttons/OpenFileButton.tsx`.
5. Rule 2 of CLAUDE.md: only `src/datasource/tauri.ts` imports the Tauri packages; do not write the package name
   in comments either.
6. Comments in touched files are English (CLAUDE.md, 2026-10-15). Keep ADR references (ADR-0017, ADR-0018, L2-F, M4-14 ...)
   that explain *why*.
7. Every other reference is updated: `AppShell.tsx` and other `src/` imports, and the mdBook
   (`docs/book/src/frontend/ui-shell.md` and the `flows/*.md` pages that mention `Ribbon*` files) — the book stays Japanese.
   `grep -rn "Ribbon\|ribbon" src docs/book e2e` should show only the kept `data-testid="ribbon"` and its users
   (and prose where "リボン" is replaced by "ツールバー").
8. `npm run typecheck` (or `npx tsc --noEmit`), `npm run lint` if present, and `npx vitest run` pass. Record the commands and output below.
9. Commits: one concern per commit, message first line `♻️ refactor: ...` / `📝 docs(book): ...` in Japanese,
   ending with the Co-Authored-By line.

## Not verified by the agent (owner checks)

The agent cannot see the screen. Owner: `npm run dev` (or the desktop app), confirm the toolbar shows
開く | 距離 高さ 面積 点の選択 断面 複数レイヤー | 設定 in one row with separators, each button enables/disables as before,
and drag/wheel scrolling still works on a narrow window.

## Record (filled in by the implementer)


- Files touched:
  - `git mv` (history kept): `src/ui/ribbon/*` -> `src/ui/toolbar/` (`Toolbar.tsx`, `ToolbarButton.tsx`, `toolbar-styles.ts`,
    `useToolbarDragScroll.ts`, `toolbar-drag.ts`, `toolbar-drag.test.ts`); `RibbonFileGroup` -> `buttons/OpenFileButton.tsx`,
    `RibbonToolsGroup` -> `buttons/MeasureButton.tsx`, `RibbonSettingsGroup` -> `buttons/SettingsButton.tsx`.
  - New: `ToolbarSeparator.tsx`, `toolbar-state.ts`, `buttons/SelectPointsButton.tsx`, `buttons/SectionButton.tsx`, `buttons/MergeLayersButton.tsx`.
  - Reference updates (rename only, comments): `src/ui/shell/AppShell.tsx`, `src/ui/layers/LayerActions.tsx`, `src/ui/layers/LayerPanel.tsx`,
    `src/ui/settings/SettingsModal.tsx`, `src/ui/dialogs/Dialog.tsx`, `src/ui/dialogs/dialog-styles.ts`, `src/ui/tools/LayerToolOverlay.tsx`,
    `src/state/{useMeasureTool,useNarrowViewport,viewer-types}.ts`.
  - Docs: `docs/book/src/frontend/ui-shell.md`, `docs/book/src/frontend/state.md`, `docs/book/src/flows/{measure,open-file,point-cloud-tools,settings}.md`,
    `CLAUDE.md` (`file-input` row now points to `src/ui/toolbar/buttons/OpenFileButton.tsx`; it went into the docs(book) commit).
  - Not changed: `data-testid="ribbon"` on the Toolbar root; ADR file names (`ADR-0017-ui-shell-ribbon.md`) and older task sheets (history).
  - Dropped: `TOOLBAR_GROUP_CLASS` and `TOOLBAR_GROUP_LABEL_CLASS` (unused after removing groups).
- Behaviour notes: the enable/disable conditions are copied from the old `RibbonToolsGroup` (measure: `!hasPointCloud && !active`;
  select/section: that or `toolRunning`; merge: `count < 2 || toolRunning`). Spacing differs slightly: the old layout used `gap-3` +
  `pr-3` between groups, now `gap-1` plus `mx-2` on each separator. Stale comments were corrected on the way (the narrow-viewport
  "hamburger menu" in the book, "active is unused" in `ToolbarButton`).
- Commands run and output (in the worktree):
  - `npx tsc --noEmit` -> no output (pass), run after commit 1 and again after commit 2.
  - `npm run lint` (`eslint .`) -> no output after the banner (pass).
  - `npx vitest run` -> `Tests  553 passed (553)`.
  - `grep -rn ibbon src` -> only `data-testid="ribbon"` in `src/ui/toolbar/Toolbar.tsx`.
- Alternatives not taken and why:
  - A config array of `{icon, label, isEnabled(ctx)}` rendered by one loop: it brings back the "read three files to learn when a button is disabled" problem.
  - React Context for viewer/measure/layerTool: each button needs only 1-2 props, so Context would hide where the data comes from.
  - A separate file per measure kind: the three buttons differ only in a lookup-table entry, so one `MeasureButton` with a `kind` prop is simpler.
  - Renaming `data-testid="ribbon"`: out of scope (E2E and docs refer to it).
- Not verified (owner): the screen. See "Not verified by the agent" above.
