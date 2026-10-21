# G2-T13: 断面図の2D画面で、なぞって断面線を直す（G2-5）

計画: [G1-raster-and-dtm.md](./G1-raster-and-dtm.md) の 8.4 の G2-5。所有者の指摘（2026-10-22）:「断面図の2D画面で左クリックで断面線の修正ができない」。

## 今あるもの（作り直さない）

- `src/app/section-math.ts`: `traceToFunction`・`replaceRange`（なぞった線で断面線の範囲を置き換える）、
  `History<T>`・`newHistory`・`pushEdit`・`undo`・`redo`・`canUndo`・`canRedo`、`classifyOneFinger`（1本指の `"trace"`）、
  `screenToSection`（画面 → `(s, z)`）。どれも単体テスト済み
- `src/app/section-view.ts`: パネルのポインター処理。左ボタンと1本指のなぞりはまだ何もしない（コメントに「G2-5」とある所）
- `src/state/layers.ts` の `SectionLineState { original, current }`。`current` を断面図（`SectionPanel.tsx`）と
  3D の断面線（`SectionLineOverlay.tsx`）、GL の読み取り（`section-view.ts` の `findOpenSectionLine` 付近）が読む
- `src/app/section-3d.ts` の `groundLineToProfile`（`SectionGroundLine` の点 → `ProfileLine`）

## やること

1. **履歴を状態に持つ**: `SectionLineState` を `{ original: SectionGroundLine; history: History<SectionGroundLine> }` にする。
   `current` を読んでいた所は `history.present` を読む。`setLayerSectionLineInList` は `newHistory(line)` で始める。
   `src/state/layers.ts` に「レイヤーの断面線の履歴を置き換える」純粋関数を1つ足す（`setLayerSectionLineHistoryInList` など）
2. **なぞる（マウス）**: 左ボタンを押して `DRAG_THRESHOLD_PX` を超えて動いたら、なぞり。動いた点を `screenToSection` で `(s, z)` にして溜める。
   離したら `replaceRange(今の線, なぞった点)` を `SectionGroundLine` に戻し、`pushEdit` で履歴に積む。
   動かずに離した左クリックは何もしない。右ボタン（平行移動・GL）の今の動きは変えない
3. **なぞる（タッチ）**: 1本指で `classifyOneFinger` が `"trace"` になったら同じ。2本指（拡大・平行移動）になったら、そのなぞりは捨てる。
   長押しの GL は今のまま
4. **なぞっている線を見せる**: なぞっている間の点を `SectionViewState` に `trace: ProfilePoint[] | null` として持ち（setter はコンテキストで渡す）、
   `SectionPanel.tsx` の `SectionMarks`（SVG）に折れ線で描く。離したら null
5. **ボタン**: 断面図のパネルに「元に戻す」「やり直す」「計算した線に戻す」の3つ。`canUndo`／`canRedo` で押せるかを決める。
   「計算した線に戻す」は `pushEdit(history, original)`（これも元に戻せる）。
   `data-testid` は `section-undo`・`section-redo`・`section-reset-line`。Ctrl+Z は付けない（所有者の回答 11）
6. 処理は `src/app/section-view.ts` の普通の関数に書く（ADR-0021。フックに足さない）。`src/ui/` はそれを呼ぶだけ
7. 断面線がまだ無い（計算中・失敗）ときは、なぞりもボタンも何もしない／押せない

## `SectionGroundLine` に戻すときの注意

`SectionGroundLine` の中身（`src/datasource/section-line.ts`）と `groundLineToProfile` を読み、逆向きの変換を
`section-3d.ts` に純粋関数で足す（往復で値が変わらないことを単体テストにする）。中身に `s, z` 以外（どの方法で作ったか等）があれば
「編集した」と分かるように残す（計画 8.x の「DTM から作ったか／編集したか」）。

## 完了の条件

- 単体テスト: (a) 左ドラッグで `replaceRange` の結果が履歴に積まれる (b) 動かない左クリックでは履歴が変わらない
  (c) 右ボタンの平行移動・GL が今のまま (d) 1本指のなぞりが積まれ、2本指になったら捨てられる
  (e) 元に戻す・やり直す・計算した線に戻す (f) 線が無いときは何もしない (g) 変換の往復
- `npm run typecheck`・`npm run lint`・`npx vitest run` が通る
- 設計書の断面の章（`docs/book/` の断面のページ）に、なぞりと3つのボタンを書く
- この文書の末尾に、実行したコマンドと出力、触ったファイル、確かめていないことを書く

## 所有者の確認手順（画面は未確認になる）

1. デスクトップか Web で点群を開き、断面ツールで断面を作る。右下に断面図と断面線が出るのを待つ
2. 断面図の上で左ボタンを押したままなぞる → 離すと、なぞった範囲の断面線がなぞった形に変わる。3D の断面線も同じに変わる
3. 「元に戻す」→ 元の形、「やり直す」→ なぞった形、「計算した線に戻す」→ 計算した線
4. 右クリックの GL・右ドラッグの平行移動・スクロールの拡大縮小が、前と同じに動く
5. スマホ: 1本指でなぞる、2本指で拡大・平行移動、長押しで GL
