# G2-1 / G2-3: 断面の点を (s, z) にすることと、2D の断面図パネル

`G1-raster-and-dtm.md` 8節の手順 G2-1 と G2-3 の実装記録。G シリーズのタスクシートは日本語で書く
（所有者の指示。CLAUDE.md の英語の決まりは、このシリーズでは所有者の指示が優先される）。
設計書の章（`docs/book/src/flows/point-cloud-tools.md` の 3-D）も日本語。

## 作ったもの

| 部分 | 場所 |
|---|---|
| G2-1 Rust: 断面レイヤーの点を `(s, z)` と色にし、上限まで間引く | `crates/pcv-core/src/profile.rs`（と `copc.rs` の `CopcFile::read_node_points`） |
| デスクトップの入口: Tauri コマンド `read_section_profile`（バイナリで返す、`spawn_blocking`、`catch_unwind`） | `src-tauri/src/copc_state.rs`、`lib.rs` に登録 |
| Web の入口: `WasmCopcFile.readSectionProfile`、Worker のメッセージ `sectionProfile`、`WebSource.readSectionProfile` | `crates/pcv-wasm/src/lib.rs`、`src/datasource/copc.worker.ts`・`web-protocol.ts`・`web.ts` |
| バッファのデコーダと型 | `src/datasource/section-profile.ts` |
| レイヤーに持たせる断面の情報（`ViewerLayer.section`: A・B・上方向・厚み） | `src/state/layers.ts`、`src/app/open-files.ts`（`addOpenedLayer` の5番目の引数）、`src/state/useLayerTool.ts`、`src/app/point-cloud-tools.ts` |
| パネルの状態（`useState` だけ） | `src/state/useSectionView.ts` |
| 手順（開く・閉じる・大きさ・ホイールの拡大縮小・ポインタ入力） | `src/app/section-view.ts`（`section-math.ts` の `zoomAt`・`panBy`・`fitView`・`classifyRightPress`・`classifyOneFinger`・`twoFingerStep` を使う） |
| 描画（ImageData と軸） | `src/renderer/section-2d.ts` |
| パネルの UI | `src/ui/section/SectionPanel.tsx`、`AppShell.tsx` に置く |

既存のファイルの中に足したところには `// --- G2: cross-section view ---` を付けた（並行して進んでいるラスタ化（W1）の変更と見分けるため）。

## 決めたこと

- **バッファの形**（リトルエンディアン）: 24 バイトのヘッダー `u32 count, u32 flags, f32 sMin, sMax, zMin, zMax`、
  続いて1点 12 バイト `f32 s, f32 z, u8 r, g, b, 分類`。24 は 4 の倍数なので、ブラウザはコピーせずに
  レコードを `Float32Array` / `Uint32Array`（1点が3語）として見られる。4バイト目は色ではなく分類。
  RGB が無い点群ではブラウザが `colormap.ts` の `classificationToColor` で塗るので、ASPRS の色表を Rust に写さない。
  `flags` の bit 0 = 間引いた、bit 1 = 色がある。
- **s と z**: `s` = dot(P - A, along)。`along` は A→B から `up` 方向の成分を除いたもの（`sectionBox` と同じ作り方）。
  `z` = dot(P, 単位の up)。`z` は A からの相対ではなく絶対の高さ（G2-6 の GL がそのまま指す値）。
- **間引き**: レイヤーの点が `cap`（既定 2,000,000）以下なら全部返す。超えるときは、レイヤーの境界箱の `(s, z)` 上に
  セル数が `cap` 以下の格子を作り、各セルの最初の1点だけ残す。残る点はセル数以下なので、上限は作りからして守られる。
  計画の「それでも超えたら一定間隔で間引く」は起こりえないので書かなかった。
  メモリは `cap` × 12 B（約 24 MB）の格子で、点数に比例しない。
  採らなかった案: n 点おきの間引き（空間の保証が無く、密な壁が疎な木を隠しうる）、セルごとに最も高い点を残す（薄い断面で
  木の下の地面が消える。点ごとの比較も増えるが、得は見えない）。
- **色のビット深度**: `CopcFile::read_node_points`（`read_node` から切り出した。`read_node` はこれを呼ぶ）は、ファイル全体で決めた
  8/16 bit の判定を適用した 8bit の色を返す。8bit 値を 16bit 欄に入れたファイルの断面が真っ黒にならない。
- **表示は、ユーザーが動かすまで `null`**: `null` は「全部がパネルに収まるように合わせる」で、描くときにパネルの大きさと点から計算する
  （`effectiveSectionView`）。点が届く順とパネルが配置される順を、React の状態で正しく並べる必要がなくなる。
  「全体表示」は表示を `null` に戻す。
- **ジェスチャーの追跡**は、フックで1回だけ作る素のオブジェクト（`SectionGesture`）に置く（`toolLock` と同じ）。ポインタの移動は毎秒 60 回以上
  届くうえ、追跡中のポインタは画面に出すものではないため。
  右ボタンは、5 px より動くか 300 ms 押し続けるまで「クリック」のまま。平行移動になる前の動きは失わない（移動の基準がまだ押した位置のため）。
- **古い読み込み**: 開くたび・閉じるたびに `token.generation` を進め、あとから開き直した・閉じたあとに終わった読み込みは捨てる。
  `openSectionPanel` はコンテキストから getter・setter・token だけを読む（ツールが、コンテキストを作った後で長い時間をおいて呼ぶため）。
- **右クリック・1本指の長押し**は `showGroundLevelAt()` を呼ぶ。中身は空で `TODO(G2-6)`（G2-6 が `(ctx, screen)` を受け取る形にする）。
  断面線（G2-4）、編集（G2-5）、GL と傾斜角（G2-6）はこの手順に入れていない。
- **描画で採らなかった案**: WebGPU の2つ目のパイプライン、SVG（計画 8.3 のとおり）。
- 描画の重さ: 点が 300,000 以下なら1点を 2×2 ピクセル（疎な断面でも見えるように）、それを超えたら1ピクセル。300,000 は見た目で決めた推定値で、測っていない。

## 追記: 画面確認のあとの直し（コーディネーターの指摘）

- **狭い画面で、パネルがレイヤードロワーの開閉ボタン（左下）を覆っていた** → 狭い画面のパネルを、ボタンの上（`bottom-28`）・
  ドロワー（z-10）の下（`z-[5]`）に置いた。左右には 8 px の余白（`inset-x-2`）、高さは 38vh。
  理由: ボタンを前に出す案はグラフの左下を隠し、パネルを左に寄せる案は幅を 64 px 失う。パネルを上げるだけなら、
  どちらも使えるままで、クラスを足すだけで済む。ドロワーを開くとパネルはドロワーとスクリムの下に回る。
- **広い画面で、縦軸のいちばん上の目盛りの文字が上の縁で切れていた** → 目盛りの線から 14 px 以内の上下の縁に当たる文字は描かない
  （線は引く）。下の縁では横軸の文字と重ならない。

## テスト

- Rust `cargo test -p pcv-core profile`: x 方向の壁と、平面 x = 5 を +y 向きに見た壁（A と B の高さが違う。`up` が単位ベクトルでない）の
  s / z の値、色と分類を引き継ぐこと、色が無ければフラグが立たないこと、200 × 200 の壁を上限 1,000 に間引いたとき
  （上限を超えない・壁全体に広がる・フラグが立つ）、上限と点数が同じなら間引かないこと、A-B が鉛直ならエラー、
  極端な範囲でも格子のセル数が指定を超えないこと。
- TS: `section-profile.test.ts`（デコーダ）、`section-view.test.ts`（偽のコンテキストで、開く成功・失敗・拒否されるレイヤー・
  読み込み中に閉じた・読み込み中に開き直した、全体表示と大きさの変化、ホイールでカーソルの下の点が動かないこと、
  右ドラッグの平行移動（最初の数ピクセルを含む）と長押し、左ボタンでは何も起きないこと、右クリックで動かないこと、2本指のピンチと平行移動、キャンセル）、
  `section-2d.test.ts`（ピクセル、分類の色、端、目盛り）、`point-cloud-tools.test.ts`（断面のときだけパネルが開く）。

## 測ったこと（コマンドと出力）

2,000,000 点の描画時間。`fillSectionPixels` を 1200 × 800 のバッファに、ランダムに散らした点（キャッシュに最も不利）で1点1ピクセル、
Node 22 / V8、`npx vitest run src/renderer/section-2d.test.ts --disableConsoleIntercept`:

```
fillSectionPixels 2,000,000 points into 1200x800: 25.6, 27.3, 22.0, 19.7, 20.8 ms      （2回目の実行）
fillSectionPixels 2,000,000 points into 1200x800: 26.1, 25.0, 25.1, 48.1, 32.5 ms      （1回目の実行）
```

上限の 2,000,000 点でもピクセルへの書き込みは 20〜50 ms ほど。測っていないこと: 2,000,000 点の断面での `putImageData` と軸の描画
（実際に試した最大の断面は下の 827,754 点）。

実際のページ（Web ビルド、画面つきの Chromium、`adapter.info` は vendor nvidia・architecture lovelace、つまり SwiftShader ではなく実 GPU）では、
canvas に `data-draw-ms`（描画全体）と `data-fill-ms`（書き込みだけ）が付いていて、Playwright で読んだ。

| 断面（autzen-classified.copc.laz、10,653,336 点） | 描いた点 | 描画 | 書き込み |
|---|---|---|---|
| 厚さ 1 m、画面 1280 × 800 | 8,345 | 1.6 ms | 0.7 ms |
| 厚さ 2,000 m（レイヤーは 8,061,470 点）、「全体表示」のあと | 827,754（間引き） | 6.1 ms | 5.7 ms |

厚い断面は 8,061,470 点から 827,754 点に間引かれた（空のセルがあるので、上限の 2,000,000 より少ない）。
この断面をパネルに読み込むには 2.5 秒より長くかかった（その時点のパネルは「読み込み中」。時間は測っていない）。

## 画面（実 GPU、`vite preview` の Web ビルド、画面つきの Chromium）

フラグ: `--enable-unsafe-webgpu --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows`。
ポート 4391（`vite preview --port 4391 --strictPort`）。終わったら止めた。
スクリーンショット（リポジトリの外。セッションの scratchpad の `.../scratchpad/shots/` と、直したあとの `.../scratchpad/shots2/`）:
`wide-3-panel.png`（右下のパネル、元のレイヤーのチェックが外れている）、`wide-4-zoomed.png`（ホイールの拡大のあと）、`wide-5-panned.png`（右ドラッグのあと）、
`wide-6-reset.png`、`narrow-3-panel.png`（400 × 800、下に横幅いっぱい）、`thick-6-reset.png`（間引きの案内）。
直したあと（`shots2/`）: `narrow-3-panel.png`（パネルが開いていて、左下のボタンが見えて押せる）、`narrow-7-drawer.png`（ボタンでドロワーを開いた）、
`wide-3-panel.png`（縦軸の文字が切れない）。

見えたこと: 点と m の格子つきのパネルが右下に出る。元のレイヤーのチェックは外れ、新しいレイヤーのチェックが付く。
ホイールでカーソルを中心に拡大縮小する。右ボタンのドラッグで平行移動する。「全体表示」で合わせた表示に戻る。
狭い画面ではパネルが下に横幅いっぱいで出て、ドロワーの開閉ボタンはパネルの下に隠れない。

## 確かめていないこと

- 実機のタッチ（ピンチ・2本指の移動・1本指の長押し）: 偽のコンテキストを使った単体テストだけ。
- デスクトップ（Tauri）のビルド: コマンドはコンパイルでき clippy も通るが、動いているアプリから呼んでいない。
- Android。
- ライトテーマと、モバイルのぼかし無しの面（不透明の tint）。
- 実際のブラウザで、とても大きな断面（2,000,000 点ぴったり）を画面に出すこと（メモリが上限で抑えられることは作りと Rust のテストで確かめたが、画面には出していない）。

## 所有者の確認手順

1. `npm run build`、`npx vite preview`、ページを開き、`autzen-classified.copc.laz`（または好きな COPC）を開く。
2. 「断面」: 点群の上の2点をクリックし、「作る」を押す。右下に、横から見た断面が出る。
3. パネルの上でホイールを回すとカーソルを中心に拡大縮小する。右ボタンを押したまま動かすと平行移動する（動かさない短い右クリックは、今は何も起きない）。
   「全体表示」で全体に合わせ、「閉じる」でパネルを閉じる（元のレイヤーは非表示のまま）。
4. とても厚い断面（たとえば 2000 m）で、「間引いて表示」の案内を確かめる。
5. スマホ: ピンチで拡大縮小、2本指のドラッグで平行移動。狭い画面でパネルを開いたまま左下のボタンでドロワーを開けること。
