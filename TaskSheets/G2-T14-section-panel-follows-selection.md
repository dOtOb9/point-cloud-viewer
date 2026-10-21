# G2-T14: 断面図のパネルを選択に合わせて開閉し、「拡大」で中央に大きく出す

所有者の要望（2026-10-22）:

> 閉じるボタンはいらなくて、全画面表示は Window を中央に拡大して表示する感じ。
> 断面レイヤーを選択したら自動的に Window が右下に開いて、選択を外すと消える感じかな

G2-T13（なぞって断面線を直す）の後に、同じ `SectionPanel.tsx`・`section-view.ts` を触るので続けて行う。

## 今の動き

- 断面ツールが断面のレイヤーを作った直後に、`src/app/point-cloud-tools.ts` が `ctx.openSectionView(layerId)` でパネルを開く
- パネルの見出しに「全体表示」（`resetSectionView`: 点が全部入る表示に戻す）と「閉じる」（`closeSectionPanel`）がある
- 一度閉じると、もう一度開く方法が無い

## やること

1. **選択に合わせて開閉する**: 選択中のレイヤー（`selectedLayerId`）が断面のレイヤー（`layer.section` がある）なら、そのレイヤーのパネルを開く。
   断面でないレイヤー・選択なしになったら閉じる。断面のレイヤー A から B に選択を移したら、B を開き直す。
   - 手順は `src/app/section-view.ts` の普通の関数に書く（例: `followSelectedLayer(ctx, selectedLayerId)`）。
     すでに同じレイヤーが開いていれば何もしない（点を読み直さない）
   - 呼ぶきっかけは、`selectedLayerId` が変わったときの `useEffect` 1つだけにする（中身はこの関数を呼ぶだけ）。
     選択を変える場所は多い（レイヤーの一覧のクリック、複数選択、ツールが作ったレイヤーの自動選択、レイヤーの削除）ので、
     全部の場所に呼び出しを足すより、選択の値を1か所で見る方が漏れない。この理由をコメントに書く
   - 断面ツールが作ったレイヤーが選択されるなら、`point-cloud-tools.ts` の `openSectionView` の呼び出しは要らなくなるので消す
     （選択されない作りなら、選択する方に直す）。どちらだったかを記録に書く
   - 開いているレイヤーが消されたら閉じる（選択が外れるので 1 で閉じるはず。テストで確かめる）
2. **「閉じる」ボタンを消す**（`data-testid="section-panel-close"` を使っている所が他に無いか `e2e/` と `src/` を確かめる）
3. **「拡大」**: 見出しに「拡大」ボタンを足す。押すとパネルが画面の中央に大きく出る（目安: 幅・高さとも画面の 80〜90%）、
   もう一度押す（ラベルは「縮小」）と右下に戻る。状態は `SectionViewState` に `enlarged: boolean` として持つ（setter はコンテキスト）。
   パネルを閉じたら `enlarged` は false に戻す。大きさが変わると `setSectionPanelSize` が呼ばれる（ResizeObserver）ので、表示はそのまま追従するはず。
   - 狭い画面（スマホ）でも同じ（中央に大きく）。レイヤーの引き出しやツールバーとの重なり（z の順）に注意し、どう決めたかを記録に書く
   - `data-testid="section-panel-enlarge"`
4. 「全体表示」（点が全部入る表示に戻す）はそのまま残す。拡大と取り違えないよう、ラベルを「全体を表示」に変えるのは可

## 完了の条件

- 単体テスト: (a) 断面のレイヤーを選ぶと開く (b) 断面でないレイヤー・選択なしで閉じる (c) A→B で B に切り替わる
  (d) 同じレイヤーのままなら点を読み直さない (e) 拡大・縮小の切り替えと、閉じたら縮小に戻る
- `npm run typecheck`・`npm run lint`・`npx vitest run` が通る
- 設計書の断面の章を、この動きに書き直す
- この文書の末尾に、実行したコマンドと出力、触ったファイル、確かめていないことを書く

## 所有者の確認手順（画面は未確認になる）

1. 断面を作る → 右下に断面図が出る
2. 元の点群のレイヤーを選ぶ → 断面図が消える。断面のレイヤーを選び直す → 右下に出る
3. 断面を2つ作り、交互に選ぶ → 選んだ方の断面図に切り替わる
4. 「拡大」→ 画面の中央に大きく出る。なぞり・右クリックの GL・拡大縮小がそのまま使える。「縮小」→ 右下に戻る
5. スマホでも 1〜4

## 実施記録（実装エージェント）

### 実行したコマンド（実際の出力）

- `npm run typecheck`: エラー無し
- `npm run lint`: エラー無し
- `npx vitest run`: `Test Files 77 passed (77)` / `Tests 766 passed (766)`（G2-T13 のあとの 760 から、G2-T14 のテスト 7 件を足した。`point-cloud-tools.test.ts` の「パネルを開く」テスト 2 件は役目が `followSelectedLayer` に移ったので消し、「失敗したら断面線を計算しない」1 件に作り直した。760 + 7 - 2 + 1 = 766）

### 触ったファイル

- `src/app/section-view.ts`: `followSelectedLayer`・`toggleSectionEnlarged` を追加。`SectionViewState.enlarged`、コンテキストに `setEnlarged`。`closeSectionPanel` が `enlarged` を false に戻す
- `src/state/useSectionView.ts`: `enlarged` の state
- `src/state/useCopcViewer.ts`: `selectedLayerId` を見る `useEffect` 1つ（中身は `followSelectedLayer` を呼ぶだけ）。`openSectionView` の配線を消した
- `src/app/point-cloud-tools.ts`・`src/state/usePointCloudTools.ts`: `openSectionView` と、断面ツールの最後の呼び出しを消した
- `src/ui/section/SectionPanel.tsx`: 「閉じる」を消し、「拡大／縮小」（`section-panel-enlarge`）を足した。「全体表示」を「全体を表示」に変えた。拡大時の置き場所
- テスト: `src/app/section-view.test.ts`（(a)-(e)）、`src/app/point-cloud-tools.test.ts`・`src/app/raster-window.test.ts`（`openSectionView` の削除に合わせた）
- 設計書: `docs/book/src/flows/point-cloud-tools.md`

### 決めたこと

- **`openSectionView` の呼び出しは消した。** `addOpenedLayer` が使う `addLayerToState` は新しいレイヤーを選択する（`selectedLayerId: layer.id`）ので、断面ツールが作ったレイヤーは選択され、effect がパネルを開く。選択する方に直す必要は無かった。
- `section-panel-close` を使っている所は、`src/` にも `e2e/` にも他に無かった（grep で確認）。
- effect の依存配列は `[layers.selectedLayerId]` だけにし、`react-hooks/exhaustive-deps` を理由つきで無効にした（context は毎回作り直されるが、選択が変わったときだけ動かしたい）。その render の context で呼ばれるので、`ctx.openLayerId`（同じレイヤーなら読み直さない判定）は最新の値になる。
- 開くのに失敗するとパネルは閉じ、選択はそのまま。選択が変わらない限り再試行はしない（無限に読み直さない）。
- 拡大したままで別の断面レイヤーに切り替えたときは、拡大のまま（閉じていないので）。閉じたときだけ縮小に戻す。
- 重なり: 拡大時は `z-[25]`。レイヤーの引き出し（z-10）・その開閉ボタン・狭い画面の通常のパネル（z-5）・広い画面の通常のパネル（z-20）より前、進捗の表示（z-30）とダイアログ（z-40、z-50）より後ろ。`h-[85%] w-[90%]` で中央（`left-1/2 top-1/2` と `-translate-*`）。スマホも同じ。

### 確かめていないこと（未確認）

- 実際の画面での、開閉・切り替え・拡大／縮小の見た目、拡大時の他の部品との重なり（ツールバーが隠れる範囲）は未確認。
- 拡大したあとの `ResizeObserver` による描き直し・拡大中のなぞり・右クリックの GL が実際に動くかは未確認（座標は `getBoundingClientRect` の相対なので動くはずという推定）。
- 選択の変え方ごと（一覧のクリック、Ctrl/Shift、レイヤーの削除、ツールの自動選択）に実際の React で effect が動くかは未確認。単体テストは `followSelectedLayer` の関数までで、effect の配線は見ていない。
- スマホでの確認、E2E は実行していない。
