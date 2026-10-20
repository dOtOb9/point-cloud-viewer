# G2-2: 断面図の2Dの計算（`src/app/section-math.ts`）

計画 `G1-raster-and-dtm.md` 8節 G2-2 の実装記録。純粋な関数だけ。UI・React・renderer は触っていない。
テストは `src/app/section-math.test.ts`（36 件）。

## 関数

| 分類 | 関数 | 内容 |
|---|---|---|
| 画面 | `sectionToScreen` / `screenToSection` | `(s, z)` と画面 px の相互変換。`screenX = offsetX + s*scale`、`screenY = offsetY - z*scale`。縦横で倍率は1つ（縦の強調なし、Q12） |
| 画面 | `fitView(panel, sRange, zRange, padding)` | 範囲全体が余白つきで収まり、中央に来る表示。幅ゼロの範囲でも倍率が有限 |
| 画面 | `zoomAt(view, 画面の点, factor)` | その点の下の断面上の位置を動かさずに拡大縮小。ホイール（カーソル）とピンチ（中点）で共用 |
| 画面 | `panBy`, `clampScale` | 平行移動、倍率の上下限（`MIN_SCALE` 1e-5〜`MAX_SCALE` 1e5 px/単位） |
| 線 | `interpolateZ`, `slopeAt`, `nearestOnLine` | 補間、傾き（度と %）、クリックした `s` に GL の印を置く点 |
| 編集 | `traceToFunction`, `replaceRange` | なぞった線を `s` の関数にし、断面線の該当範囲と置き換える |
| 履歴 | `newHistory`, `pushEdit`, `undo`, `redo`, `canUndo`, `canRedo` | `{ past, present, future }`。線を丸ごと積む（差分にしない） |
| 操作 | `classifyRightPress`, `classifyOneFinger`, `twoFingerStep` | 右ボタン・1本指・2本指の分類（数値だけ。DOM の型なし） |

## 決めたこと（所有者に関わるもの）

1. **なぞった線の整理**: 描いた順の点を `s` で安定ソートし、**同じ `s` が複数あれば最後に描いた点だけ残す**。
   行ったり来たりしたときは、両方の通り道の点を `s` 順に並べた結果になる（平均も平滑化もしない）。
   理由: いちばん単純で予測しやすい。折り返して同じ場所を描き直したときは、描き直した方が勝つ。
   `s` がちょうど同じになるのは稀なので、細かく往復すると前の通りの点が残ってギザギザになりうる（未確認。画面で確かめて変えるならここ）。
2. **置き換える範囲**: なぞった点の `s` の最小〜最大（両端を含む）。範囲内の既存の点を消し、なぞった点を入れる。
   線の端を越えてなぞると線が伸びる。1本の線分の中だけなぞると点が増える。空のなぞり（有限でない値のみ含む）は何もしない。
3. **傾きの定義**: `s` を含む線分の傾き。**頂点の上ではその頂点から右へ伸びる線分**、最後の頂点では最後の線分。
   2線分の平均にしない（値が一意で、丸め誤差に左右されない）。線の外、または点が2つ未満なら `null`。
   度は `atan2(dz, ds)`（B 向きに上がると正）、% は `100*dz/ds`。
4. **GL の印**: `nearestOnLine` は `s` を線の範囲に丸めてその高さを返す（線の外をクリックしても端に印が付く）。
   線の外では何も出したくないなら、呼ぶ側で `interpolateZ` が `null` か見る。
5. **操作のしきい値**（書き出して定数にした。変えるときはここ）:
   - `DRAG_THRESHOLD_PX = 5`: これより動けばドラッグ。
   - `LONG_PRESS_MS = 300`: 右ボタンをこれ以上押し続けると平行移動（計画の「約300 ms」）。
   - `TOUCH_LONG_PRESS_MS = 500`: 1本指がこれ以上動かなければ GL・傾き。マウスより長いのは、タッチで誤って出ないように。値は推定で、実機で確かめていない。
   - 右ボタン: 動いた、または 300 ms 以上 → `"pan"`。短くて動かない → `"click"`。
   - 1本指: 動いた → `"trace"`（いつでも）。動かず 500 ms 以上 → `"longpress"`。どちらでもない間は `"pending"`（離したらただのタップで何もしない）。
   - 2本指: `twoFingerStep` が中点・距離の比・中点の移動量を返す。`zoomAt(view, center, zoomFactor)` のあと `panBy(view, dx, dy)` を呼ぶ。

## 確かめたこと

`npm test`（67 ファイル・647 件、うち本件 36 件）、`npm run lint`、`npm run typecheck` は通った。
CI の `invariants` ジョブ（規約2・3・5）と同じ grep も、問題なし。画面での確認は無い（UI は G2-3 以降）。

## 残り（G2-3 / G2-5 / G2-6）

- G2-3: `useSectionView.ts` に `SectionView`（と履歴）を持たせ、パネルの大きさが変わったら `fitView`、ホイールで `zoomAt`、右ボタンのドラッグで `panBy`。
  右ボタンの時間・移動量は、押した時刻と最大移動量を UI 側（ポインタイベント）で測って `classifyRightPress` に渡す。
- G2-5: ポインタの軌跡を `screenToSection` で `(s, z)` に直して `replaceRange`、結果を `pushEdit`。「元に戻す」「やり直す」は `undo` / `redo`（ボタンの無効化は `canUndo` / `canRedo`）。
  なぞっている最中の表示（描きかけの線）は別途必要。1本指の分類は `classifyOneFinger` を使う。
- G2-6: クリックした画面位置 → `screenToSection` → `nearestOnLine` で印、`slopeAt` で傾き。表示の単位（m / ft）への換算は呼ぶ側。
- 履歴の件数に上限は付けていない（線が小さいので、まず単純に）。長時間の編集で気になれば G2-5 で上限を決める。
