# G2-8 / G2-6 (T12): 断面線を 3D の画面にも出し、断面図と同期する。GL と傾斜角

- 日付: 2026-10-21
- 計画: `TaskSheets/G1-raster-and-dtm.md` 8.7 節（所有者の要望。これが正）、8.3〜8.5 節
- 使ったもの: G2-T5 の `section-math.ts`（`interpolateZ`・`screenToSection`）、G2-T8 のパネル、G2-T9 の `section.line.current`、L2-D の `MeasureOverlay` の方式

## 作ったもの

| 部分 | 場所 |
|---|---|
| 純粋な関数: `sectionAxes`・`sectionToWorld`・`groundLineToWorld`・`groundLevelAt`・`groundLevelLabel`、定数 `SLOPE_HALF_WINDOW_M = 1`（m） | `src/app/section-3d.ts`（テスト `section-3d.test.ts` 13件） |
| 手順: `showGroundLevelAt(ctx, x)`（右クリック・長押しの先。以前は空の `TODO(G2-6)`）、`sectionPointerLeave`、マウスの `s` を `cursorS` に入れる | `src/app/section-view.ts`（テストは `section-view.test.ts` に5件足した） |
| 状態: `cursorS`・`groundLevel`（`useState` だけ） | `src/state/useSectionView.ts` |
| パネル: 案内文「右クリック（長押し）で GL と傾斜角」、カーソルの縦線と点、GL の点と文字（SVG） | `src/ui/section/SectionPanel.tsx` |
| 3D: 断面線の折れ線、カーソルの点、GL の印と文字（SVG。毎フレーム投影） | `src/ui/section/SectionLineOverlay.tsx`、`AppShell.tsx` に1行 |
| 設計書 | `docs/book/src/flows/point-cloud-tools.md` の 3-D の 7 |

## 決めたこと・他の案

- **座標の戻し方**: Rust の `SectionAxes`（`crates/pcv-core/src/profile.rs`）と同じ式を TS に書いた（`sectionAxes`。`tool-math.ts` の `sectionBox` とも同じ作り方）。
  `z` は Rust の `project` が `dot(p, up)`（世界の原点から測った高さ）なので、A からの高さは `z − dot(A, up)`。3D の点 = A + s×向き + (z − dot(A, up))×上。
  テスト `round-trips ...` で、A を原点以外にして `(s, z)` に戻せることを確かめた。
- **3D の描き方**: 計測の線と同じ（毎フレーム `getViewSnapshot().viewProj` で投影して SVG）。理由は計画 8.7 のとおり（文字に DOM が要る、計測と仕組みを揃える、renderer に触らない）。線は点群に隠れず、いつも手前（受け入れ済み）。カメラの後ろの点は線を切る（`projectPoint` が null の所で折れ線を分ける）。
  採らない案: WebGPU の線のパイプライン（隠れる線が要るなら G1-9 のメッシュと一緒に）。
- **線は状態から読む**: `SectionLineOverlay` と `showGroundLevelAt` は毎回 `layer.section.line.current` を読む。コピーを持たないので、G2-5 の編集・元に戻すが `current` を変えれば、3D・パネル・GL の読みがそのまま追随する（GL の印は、線を直したあとの再計算はまだしない。G2-5 で必要なら足す）。
- **カーソルの状態**: マウスの位置から `s` を出して `cursorS`（React の状態）に入れる関数は `section-view.ts`。パネルは `onPointerLeave` で消す。タッチはホバーが無いので出ない。高さは見ないので、線の範囲の外では点が出ない。
- **傾斜角**: `s − 1 m`・`s + 1 m` の線の高さ（補間）を結ぶ。窓が線の端を超えるときは端で止める（端では窓が短くなる）。窓の幅の m → ファイルの単位は、`csf-params.ts` と同じく CRS の水平の係数。鉛直と水平の単位が違うときは `垂直/水平` の比で上げ幅を直す。単位が不明なときはそのまま（警告は出していない。CSF と違い、読み取りだけで結果を書き換えないため）。
  既存の `slopeAt`（線分の傾き）は使わなかった。計画で「0.5 m 間隔の点は凹凸で暴れるので ±1 m」と決めているため。`interpolateZ` は再利用した。
- **表示**: `GL 128.15 m / 傾斜 +0.2° (+0.4%)`。GL は鉛直の係数で m / ft（`formatLength`）。パーセントを足したのは計画 8.3 の「度と %」に合わせたため。
- **採らない案**: 右クリックの位置に断面線から一番近い点を探す（`nearestOnLine`）。傾き・GL は `s` だけで決まる（線は `s` の関数）ので不要。

## テスト・コマンド

- `npx vitest run`: 75 ファイル 731 件成功（rebase 後）。`npx tsc --noEmit`、`npx eslint src`: 出力なし（React Compiler の規則で `useMemo` は使えず、外した）。
- `section-3d.test.ts`: `(s, z)` → 3D（x 向き・斜め・y 上・A が原点でない・退化の null）、GL の補間、±1 m の傾き（折れ曲がり・端・範囲外・フィート・単位が違うとき）、ラベル。
- `section-view.test.ts`: 右クリックで GL と 45°、長押し、フィートの窓、範囲外・線なしで消す、`cursorS` の追従と消去。

## 画面（Web ビルド、実 GPU）

`GITHUB_PAGES_BUILD=true npm run build`、`vite preview --port 4521 --strictPort`、画面つき Chromium（`channel: "chromium"`、`--enable-unsafe-webgpu` ほか）。
`adapter.info` は `{"vendor":"nvidia","arch":"lovelace"}`（SwiftShader ではない）。終わったあと、自分が起動した preview のプロセス4つだけを止めた（コマンドラインを確かめてから）。ポート 4521 は終了後に待ち受け無し。
`autzen-classified.copc.laz`（CRS はフィートのファイル）で、画面の (570,600)→(820,600) の2点で断面を作り（標準）、線が出るまで待った。スクリーンショット（リポジトリの外）:

- `C:\tmp\g2shots\e-03b-orbit.png`: カメラを上から見る向きに回し、元の点群を表示にした画面。オレンジの断面線が、2点を結ぶ地面の上に載っている（右下が断面図）
- `C:\tmp\g2shots\e-05-gl.png`: 断面図の中央で右クリック。パネルと 3D の両方に黄色の点と `GL 128.15 m / 傾斜 +0.2° (+0.4%)`。3D の点は線の真ん中あたり
- `C:\tmp\g2shots\d-04-cursor1.png`: パネルのマウスを `s ≈ 250`（A から 27%）に置いた画面。パネルに縦線と白い点、3D の線の上の同じ割合の所（A から約 27%）に白い点。この画面は断面の正面を見る向きで、A が右、B が左になっている（`sectionYaw` の向きのため）
- `C:\tmp\g2shots\d-03-line.png`: 断面を作った直後の正面の画面。案内文の位置の修正前（下に出ていて軸の数字と重なっていた。のちに左上へ移した）

位置の一致は、画面上の割合（27%）と、パネルの `s` の読みから目で見て確かめた。ピクセルの誤差は測っていない。

## 確かめていないこと

- デスクトップ（Tauri）のアプリでの実行（TS だけの変更なので同じ経路のはずだが、動かしていない）。
- 渋谷のデータでの確認（autzen のみ）。
- G2-5 の編集・元に戻すを通した同期（G2-5 はまだ無い。線は `section.line.current` から読んでいるが、その値を変える操作では試していない）。
- スマホ（タッチの長押し）の実機。長押しは単体テストだけ。
- 傾斜角の値が正しいかを、別の道具で突き合わせていない（単体テストの手計算だけ。画面の +0.2° はほぼ平らな所で、もっともらしいが検証ではない）。
- 3D の線がカメラの近くを通るときの切れ方の画面確認。

## 所有者の確認手順

1. `npm run build`、`npx vite preview`、`autzen-classified.copc.laz` を開く。
2. 「断面」で2点をクリックして「作る」。断面図と線が出るまで待つ。
3. 元の点群のチェックを入れ、ドラッグして上から見る。オレンジの線が2点を結ぶ地面に載っていること。
4. 断面図の上でマウスを動かす。パネルの縦線と点に合わせて、3D の線の上の白い点が同じ位置に動くこと。
5. 断面図で右クリック（スマホは長押し）。パネルと 3D の両方に黄色の点と `GL … / 傾斜 …°` が出ること。斜面の所と平らな所で角度が変わること。線の外では何も出ないこと。
6. 表示の単位をフィートにすると、GL が ft になること。
