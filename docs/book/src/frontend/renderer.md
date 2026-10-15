# src/renderer: WebGPU 描画

`src/renderer/` は点群の WebGPU 描画を担います。[規約3](../conventions.md#規約3-srcrenderer-は-react-を知らない) により
React を知らず、`<canvas>` と `DataSource` だけを受け取ります。もとは
`point-cloud-renderer.ts` という1,055行のファイルに全部入っていましたが、
性質の違う3つの関心事が同居して実装を追いにくくなっていたため、3ファイルに
分割されています（[`TaskSheets/ARCHITECTURE.md`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ARCHITECTURE.md) の「`src/renderer/` の内部構成」）。

## フレームループ: `point-cloud-renderer.ts`

[`PointCloudRenderer`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/renderer/point-cloud-renderer.ts) クラスがオーケストレーション役です。`requestAnimationFrame`・
カメラ・統計・点予算の自動調整（止まったら上限まで上げる HQ-2 を含む）の呼び出し、ノードローダーとの接続を持ち、
`src/state/` の hook（`useRendererLifecycle`・`useDisplaySettings`・`useLayers` など）が使う唯一の入り口（公開 API）になっています。
実際に WebGPU の API を叩くことはせず、毎フレーム「今何を描くか」を
`gpu-resources.ts` に渡すだけです。毎フレームの手順は[毎フレームの描画](../flows/render-frame.md)に番号つきで書きました。

### 複数レイヤーと `focusLayer`

renderer は**複数のレイヤー**を持ちます（`Map<string, Layer>`。挿入順がレイヤーの並び順）。
`DataSource` も `cloudId` も知らず、`addLayer(layerId, input)` の `LayerInput.readNode` が `cloudId` を閉じ込めた関数として渡されます。

- **レイヤーごとに持つもの**: ノード階層・着色モード・標高の範囲（LAS ヘッダーの実データ範囲）・強度の範囲（届いたノードで広げる）・点の形と大きさ（`style`）・着色設定の uniform バッファ。
- **全レイヤーで共有するもの**: 点予算、ノードキャッシュ、ノードローダー。キャッシュ・ローダーのキーは `"<通し番号>:<ノードキー>"`（`layer-key.ts`）でレイヤーごとに分かれる。
- 操作: `addLayer`・`removeLayer`・`setLayerVisible`・`setLayerColorMode`・`setLayerPointShape`・`setLayerPointSize`。非表示のレイヤーはノード選択・読み込み・描画の対象外。
- **`focusLayer(layerId, orientation?)`**: そのレイヤーへカメラを移す（視点移動のアニメーション。向きは今のまま）。グリッドの高さ・大きさもそのレイヤーに合わせる。
  `addLayer` も最初のレイヤーは即座に、二つ目以降は `focusLayer` と同じ動きで移る。`focusBox(min, max)` は計測レイヤー（renderer の外にある）用、`resetView(layerId?)` は向きも初期に戻す。
  範囲の計算は `layer-focus.ts`（`layerFocusBounds`・`focusGoalFor`）。
- デバイス消失から復帰すると、各レイヤーの着色 uniform バッファは古いデバイスのものなので `null` にして、次に使うとき作り直す。

### ピック（画面の点 → 3D の点）

`pickPoint(cssX, cssY)` は、点が CPU に無いので**描いた深度を GPU から読み戻して**逆射影します。段階1で粗い距離を取り、
段階2でその距離を挟む狭い near/far で小窓だけ描き直して精度を取り戻す二段階です（式は `pick-math.ts`、読み戻しは `gpu-resources.ts` の
`readDepthWindow`／`renderDepthWindow`）。`getViewSnapshot()` は計測の線を重ねるために直近の `viewProj` と上方向を返します
（[計測](../flows/measure.md)）。

## どのノードを描くか: `node-selection.ts`

[`selectNodesForLayers()`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/renderer/node-selection.ts) が、クラスのフィールドに一切触らない**純粋関数**として
「このフレームで描くノード」を決めます（1レイヤー・キー前置きなしのときの結果は、従来の `selectNodesForFrame()` と同じです）。

1. 見えているレイヤーごとに、octree の根から子へたどる。視錐台の外のノードの部分木には降りない（`frustum.ts` の `aabbIntersectsFrustum`）
2. **LOD A**: 点間隔が `MIN_NODE_SPACING_PIXELS`（0.5px）を下回ったノードの子孫は候補に入れない（画素より細かい点は、読んでも見た目が変わらないため）
3. 残ったノードに [`screenSpaceError()`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/renderer/screen-space-error.ts) と中央優先度の重みで優先度を付け、
   **全レイヤーを一つのリストにして**優先度の高い順に並べる
4. 点予算を超えるまでノードを採用し、超えたら残りは諦める（点予算は全レイヤーで一つを分け合う）
5. 採用したノードのうち、キャッシュ済みのものは `toDraw`、未取得のものは `wanted`
   （ロードキューに渡す）に振り分ける

キャッシュへのアクセスは `NodeSelectionCache` という最小限のインターフェース
越しに受け取るため、WebGPU を一切起動せずに `vitest` で検証できます。

### 画面空間誤差の式（次元を直した経緯）

`screenSpaceError()` は「ノードがどれだけ粗く見えているか」を数値にします。

```
点間隔 = (体積 / 点数) ^ (1/3)                 … 長さの次元
ピクセル/ワールド単位 = sizePixels / ワールド対角長
誤差 = 点間隔 × ピクセル/ワールド単位
```

旧式は `画面上の大きさ ÷ (点数/体積)` という、次元の合わない式でした。これだと
1レベル深くなるごとに誤差が約1/16に落ちてしまい、深いレベルのノードが事実上
読み込まれなくなる不具合がありました。詳細な診断と実測は
[ADR-0010](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0010-lod-priority-and-point-budget.md) を参照してください。

## 点予算の自動調整: `point-budget.ts`

[`point-budget.ts`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/renderer/point-budget.ts) は、フレーム時間の閉ループで点予算を自動調整する純粋関数群です。
目標はフレーム時間であって fps ではなく、上げるときはゆっくり、下げるときは
速く、という [ADR-0009](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0009-adaptive-render-settings.md) の方針を実装しています。

現在の実装は「vsync に間に合っているか」を信号にした AIMD（Additive Increase /
Multiplicative Decrease）です。これは当初の実装（`requestAnimationFrame` の
コールバック間隔をそのまま「重さ」として使う）が、60Hz 環境では**予算が下がる
一方で二度と増えないラチェット**になっていた不具合を受けて書き直されたもので、
その経緯（見つかった不具合は3段階あり、最後は推定ロジック自身に潜んでいた逆向きの
ラチェットでした）は [ADR-0010 の追記](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0010-lod-priority-and-point-budget.md) に詳しく記録されています。
[落とし穴と教訓](../pitfalls.md)でも取り上げています。

### 止まったら上限まで: `idle-boost.ts`（HQ-2）

[`idle-boost.ts`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/renderer/idle-boost.ts) の `stepIdleBoost` は、カメラが 500ms 止まったら点予算を上限まで上げ、
動き出したら**描く前に**元の値へ戻す判定です（純粋関数）。上げる前の値は一度だけ保存し、止まっている間は AIMD を呼ばないので、
一方向に張り付く形（ADR-0010 で何度も失敗した形）になりません。

## WebGPU を直接叩くところ: `gpu-resources.ts`

[`gpu-resources.ts`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/renderer/gpu-resources.ts)（1,000行超）が、デバイス・パイプライン・テクスチャの初期化、
リサイズ、1フレーム分の描画コマンドのエンコード（`drawFrame`）を持ちます。
**`src/renderer/` の中でも WebGPU の API を直接叩くのはこのファイルだけ**です。

描画パイプラインは EDL のオン/オフと点の形（丸/四角）で切り替わります。

- EDL オン: 点群を独立したオフスクリーンの色+深度テクスチャに描き、その後
  空・グリッドをスワップチェーンへ描いてから、EDL 合成パス（[`edl.ts`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/renderer/edl.ts)）が
  オフスクリーンを読んで陰影を掛けながら合成する、2パス構成
- EDL オフ: オフスクリーンを経由せず、背景を描いた同じパスの中で点群を
  スワップチェーンへ直接描く、1パス構成（モバイルでの GPU 負荷削減のため）

点の形（丸/四角）と大きさは**レイヤーごと**で、描くときに `DrawFrameOptions.nodeStyle(node)`
（`PointCloudRenderer` が、ノードのキーの前置きからレイヤーを引いて返す）で決まります。着色は、ノードの bind group が
**そのレイヤーの着色 uniform バッファ**を指しているので、レイヤーごとに別の着色モード・範囲で描けます。

点の形（丸/四角）は、実行時の `if` 分岐で `discard` を迂回するのではなく、
`fs_main_round`/`fs_main_square` という別々のフラグメントエントリポイントを
持つ別々のパイプラインとして用意されています。`discard` 命令がシェーダに
存在するというだけで、タイル方式の GPU（Adreno 等）の Early-Z 最適化が
無効化されうるためです。

### 空・地面グリッド: `sky.ts` / `ground-grid.ts`

どちらも全画面パス（頂点バッファ不要の巨大三角形）で、テクスチャを使わず
ビューのレイ方向から色を決めます。深度を書かないため、点群は常にその手前に
残ります。背景の既定は単色（暗）、グリッドの既定はオンです（実機フィードバックを
経て決まった経緯は [`TaskSheets/M2-shading-and-ui.md`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/M2-shading-and-ui.md) M2-0c の「既定の決定」を参照）。

両ファイルとも、ワールド空間の行列を f32 のまま GPU に渡していたために
NaN が出て画面が真っ黒・地面しか見えない、という不具合を2回経て、現在は
「カメラ基底（forward/right/up）から画素ごとにレイ方向を再構成する」方式に
落ち着いています。**単位ベクトルを広い角度にわたって線形補間してはいけない**
という教訓はこの修正から得られたもので、[落とし穴と教訓](../pitfalls.md)で詳しく扱います。

### EDL: `edl.ts`

[EDL（Eye-Dome Lighting）](../glossary.md#edleye-dome-lighting)は、隣接ピクセルとの深度差から陰影を作り、
色を持たない点群でも凹凸構造を読めるようにする手法（Potree が採用）です。
`sofi.copc.laz` のような RGB 無しデータを判読可能にする中心的な機能です。
強さは `0.05` に固定されており、これは所有者が実機で確認して決めた値です
（かつてはスライダーで調整できましたが、固定値になったため UI からは削除されています）。

このパイプラインは、一度 `depthStencil` の宣言を忘れたことでレンダーパスと
非互換になり、**画面全体が真っ黒になる**（しかも typecheck/lint/test/build/CI は
すべて成功する）という事故を起こしています。これをきっかけに
[WebGPU のエラー可視化の仕組み](#エラーの表示-gpu-error-logts)が作られました。
詳細は [ADR-0011](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0011-gpu-error-visibility.md) を参照してください。

### カラーマップ: `colormap.ts`

RGB・標高・強度・分類の4モードを切り替えます。標高と強度は同じランプ
（青→緑→黄→赤、CloudCompare の既定に合わせたもの）を使い、分類は ASPRS
標準の分類コード表に沿って配色されています。TypeScript 側のランプ定義から
WGSL のコードを生成する `rampToWgslFunction()` があり、色の制御点を TS 側
1箇所だけに持つことで、GPU 側のシェーダと食い違う事故を防いでいます。

標高の正規化レンジは、octree のノードの立方体の範囲ではなく、LAS ヘッダーの
実データ範囲（`CloudInfo.min`/`max`）から取ります（[`scene-bounds.ts`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/renderer/scene-bounds.ts)）。
これを混同すると「標高が全部同じ色になる」という実機不具合になります
（[落とし穴と教訓](../pitfalls.md)参照）。着色モード・標高の範囲・強度の範囲は**レイヤーごと**です
（離れた場所のレイヤーを並べても、各レイヤーの色の差が潰れないように）。RGB を持たないレイヤーで `rgb` を選ぶと、
呼び出し側（`resolveColorMode`、`colormap.ts`）が標高に落としてから renderer に渡します。renderer は渡された値をそのまま使います。

### 上方向: `up-axis.ts`

点群データは Z-up（LAS/COPC は投影座標系なので Z が標高）ですが、カメラは
以前 Y-up を仮定していました。この定義を1箇所（`DEFAULT_UP_AXIS`）に集約し、
カメラ・パン・ピッチ・標高・EDL・空の背景がすべて同じ値を参照します。
PLY/PCD のように座標系を持たないデータに備え、定数ではなく変更可能な値です。

## 端末への適応: `device-profile.ts` / `render-scale.ts` / `device-recovery.ts`

- [`device-profile.ts`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/renderer/device-profile.ts) — `navigator.deviceMemory` とタッチ主体かどうかだけでモバイル判定を行い
  （GPU 名には依存しません。[ADR-0009](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0009-adaptive-render-settings.md) 参照）、レンダースケール・点の形・
  EDL・ガラス表現・点予算上限の既定値を1箇所で決めます
- [`render-scale.ts`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/renderer/render-scale.ts) — キャンバスの内部解像度（描画バッファ）を「表示サイズ × レンダー
  スケール」で計算します。`devicePixelRatio` はこの式に**含めていません**
  （含めると、モバイルの既定値が実機で実質効かなくなる・デスクトップの
  見た目が変わってしまう、という2つの問題があったため）
- [`device-recovery.ts`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/renderer/device-recovery.ts) — `device.lost` から復帰を試みるかどうかを決める純粋関数。
  OPPO Pad Air の実機で「WebGPU が失われました」の後に画面が固まったまま
  戻らないという報告を受けて追加されました。無限に再試行せず、直近60秒に
  3回までという上限を持ちます

## エラーの表示: `gpu-error-log.ts`

[`gpu-error-log.ts`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/renderer/gpu-error-log.ts) の `GpuErrorLog` は、WebGPU のエラー（初期化時のバリデーション
エラー、実行時のエラー、デバイス消失）とノード読み出し失敗を蓄積し、同じ
メッセージの連投を抑制する、**WebGPU に一切依存しない**純粋なクラスです。
`src/state/useErrorLog.ts` の `reportError` が受け取り、`src/ui/dialogs/ErrorDialog.tsx`（[ui-shell の章](./ui-shell.md)）が画面に表示します
（出どころごとの流れは[エラーの流れ](../flows/errors.md)）。`GpuErrorSource`（`gpu`／`node-read`／`conversion`／`crs`／`tool`）で、
どの種類のエラーかを区別します。クラス名・ファイル名は `Gpu` のままですが、中身は GPU に依存しない汎用の仕組みです。

この仕組みが作られた理由そのものが教訓です。EDL の `depthStencil` 宣言漏れで
画面が真っ黒になったとき、`typecheck`/`lint`/`test`/`build`/CI はすべて緑でした。
WebGPU のバリデーションエラーはブラウザの実装が実行時に出すもので、静的解析にも
単体テストにも現れないためです。詳細は [ADR-0011](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0011-gpu-error-visibility.md) を参照してください。

## まず読むファイル

- [`src/renderer/point-cloud-renderer.ts`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/renderer/point-cloud-renderer.ts) — 全体のまとめ役
- [`src/renderer/node-selection.ts`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/renderer/node-selection.ts) — どのノードを描くか（純粋関数、読みやすい）
- [`src/renderer/gpu-resources.ts`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/renderer/gpu-resources.ts) — WebGPU の実体
