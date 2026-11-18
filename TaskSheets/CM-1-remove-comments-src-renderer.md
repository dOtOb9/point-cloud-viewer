# CM-1: コメントを消す（`src/renderer/`）

- 共通の決まり・例外・「なぜ」の移し方: [CM-0-no-comments.md](./CM-0-no-comments.md)（CM-0 が先に main に入っていること）
- 範囲: `src/renderer/`。範囲の外のファイルは触らない（並行して別の作業役が消している）
- 方針: 振る舞いは変えない。push しない

## 受け入れ基準

- **AC-1** 範囲のファイルについて `scripts/comment-baseline.json` の項目が無くなり（上限 0）、`npm run check:comments` が通る。例外（CM-0 の「例外」）だけが残る
- **AC-2** 消したコメントが、コードから読めない意図を持っていた所では、CM-0 の順（名前 → テストの名前 → このシートの「移した理由」）で移す。
  名前を変えたら使い手を全部直す（`grep` の数を作業報告に書く）。名前の変更と関数の切り出し以外の変更はしない（振る舞いを変えない）
- **AC-3** コメントだけの行を消した後に、空行が2行以上続く・ブロックの先頭が空行になる、などの跡を残さない（整形ツールが通る）
- **AC-4** `src/code-limits.test.ts` の BASELINE など、行数に依存する検査・文書（ADR-0024 などの `path:line` の参照）を、縮んだ行数に合わせて直す（`npm run check:docs` が通る）
- **AC-5** `npm run check:all` が全部 OK
- **AC-6** シェーダー（WGSL）を TS の文字列から出す: `/* wgsl */` の付いたテンプレート文字列を持つ5ファイル（`depth-pick.ts`・`edl.ts`・`gpu-resources.ts`・`ground-grid.ts`・`sky.ts`）のシェーダーを `src/renderer/shaders/*.wgsl` に置き、`?raw` で import する。`.wgsl` のコメントも消し、`npm run check:comments` が通る（CM-0 の検査は `.wgsl` を数える）。描画の結果は変えない（コメントを除いた文字列が同じであることをテストで確かめるか、差分で示す）
- **AC-7** シェーダーが TS に戻らない守り: `src/code-limits.test.ts` に、`src/**/*.{ts,tsx}`（テストを除く）に WGSL の入口の属性（`@vertex`・`@fragment`・`@compute`）が出てきたら落ちるテストを置く。目印（`/* wgsl */`）でなく中身を見る（CM-0-RP の F-RP-2）。元の形に一時的に戻して落ちることを確かめる

## 移した理由の記録

| ファイル:識別子 | 消したコメントの要点 | 移し先（名前／テスト名／ここ） |
|---|---|---|
| `shaders/points.wgsl:fs_main_round`・`fs_main_square`・`*_fade` | `discard` はシェーダーの中にあるだけで、タイル型 GPU（Adreno など）の Early-Z・隠面消去を無効にしうる。uniform で形を切り替えても静的には消せないので、入口（エントリポイント）を分け、四角とフェードの済んだノードのパイプラインには `discard` が無いようにした | ここ（M3-8・AN-1。`TaskSheets/M3-release-and-update.md`） |
| `shaders/points.wgsl:VertexIn.packed` | intensity(u16)・classification(u8)・padding(u8) を 1 つの u32 として読み、ビット演算で分ける（`crates/pcv-core/src/node_format.rs` のオフセット 16、リトルエンディアン） | ここ |
| `shaders/points.wgsl:colorForVertex` | 想定外の mode は RGB に落とす（何も出ないより元の色が出るほうがよい）。標高は `originZ + position.z`（node_format の rel_z の逆算） | ここ |
| `shaders/points.wgsl:vs_main` | `clip.w` を掛けてから角をずらすので、透視除算の後も点の大きさがピクセルで一定 | ここ |
| `shaders/points.wgsl:bayer4`・`fs_main_*_fade` | フェードはアルファブレンドでなく Bayer 4x4 のしきい値で描く・捨てるの二択にし、描く順・深度・EDL に影響しない | ここ（`TaskSheets/AN-animation.md`） |
| `shaders/edl.wgsl:fs_main` | 深度がクリア値（1.0）のピクセルは点が無いので `discard` し、空・グリッドに陰影を掛けない。近傍の座標は画面端でクランプする（`textureLoad` の範囲外は 0 = 近クリップで、誤って「手前」になる）。近傍が背景なら足さない | ここ（`TaskSheets/M2-shading-and-ui.md` M2-1） |
| `shaders/edl.wgsl:logDepth` | 平行投影では log2 でなく `eyeDistance / (orthoRef * ln 2)`（`edl.ts:edlLogDepthOrtho` の手書きの写し）。`0.6931472` は ln 2 | ここ |
| `shaders/ground-grid.wgsl`・`shaders/sky.wgsl` | レイ方向は画素ごとに基底から組み立てる（`forward + ndc.x*rightScaled + ndc.y*upScaled`）。全画面三角形の頂点の方向を線形補間すると弦を取って長さが縮み NaN になった。ワールド座標の絶対値は GPU に渡さず、グリッドの位相はカメラ位置の余り（`floorMod`）で渡す。遠方はフェードしてモアレを避ける | `TaskSheets/M2-shading-and-ui.md` M2-0c と `scripts/diag-sky-ray.ts`（元のコメントが指していた所） |
| `edl.ts`・`sky.ts`・`ground-grid.ts` の `depthStencil` | 深度を書かないパイプラインでも、パスに深度アタッチメントがある以上、同じ形式の `depthStencil` を宣言しないとパスと非互換になり、フレームがまるごと捨てられて画面が真っ黒になった | `TaskSheets/ADR-0011-gpu-error-visibility.md`・`TaskSheets/M2-shading-and-ui.md` M2-1 |
| `gpu-resources.ts:DEPTH_FORMAT` | 全部の深度テクスチャとパイプラインが 1 つの定数を参照し、上の事故を構造で防ぐ | ここ |
| `gpu-resources.ts:OFFSCREEN_COLOR_FORMAT` | オフスクリーンは EDL が読むだけなので、環境ごとに違うスワップチェーンの形式に合わせず `rgba8unorm` に固定 | ここ |
| `gpu-resources.ts` の点のパイプライン 8 つ | 色アタッチメントの形式はパイプラインと厳密に一致する必要があるので、オフスクリーン用とスワップチェーン用を別に持つ。EDL オフのときは 1 パス（メモリ帯域を減らす。M3-8） | ここ |
| `gpu-resources.ts:handleDeviceLost` | `device.lost` で復帰を試みる（MDN "Handling device loss"）。`destroyed` と `dispose` 後は試みない。頻度の判定は `device-recovery.ts`。復帰したら古いデバイスのバッファを持つノードキャッシュを空にする（`loader.reset()` は呼ばない: ファイルは変わっていない） | `TaskSheets/M3-release-and-update.md` M3-8 |
| `gpu-resources.ts:initWithErrorScope` | 生成の手順ごとにエラースコープで区切り、どの生成が失敗したかをメッセージに付ける（`onuncapturederror` は 1 つしか持てない） | `TaskSheets/ADR-0011-gpu-error-visibility.md` |
| `gpu-resources.ts:drawPoints` | 点の大きさに `renderScale` を掛け、引き伸ばした後の見た目の大きさを一定にする | ここ |
| `gpu-resources.ts:drawFrame` のパス 1 | 「点が無い」の判定は色の alpha でなく深度のクリア値で行う（円形の外を `discard` しても深度はクリア値のまま） | ここ |
| `gpu-resources.ts:ELEVATION_INTENSITY_RAMP_WGSL_SRC` | 色ランプは TS の `ELEVATION_INTENSITY_RAMP` から WGSL を生成し、手で写して食い違うのを防ぐ | テスト `shaders.test.ts`「points.wgsl calls the elevation and intensity ramp that gpu-resources.ts generates from ELEVATION_INTENSITY_RAMP」と `colormap.test.ts` の既存のテスト |
| `gpu-resources.ts:UNIFORM_BUFFER_SIZE` ほか uniform の大きさ | mat4(64)+f32×5=84 バイトを WGSL の構造体の揃え 16 の倍数に切り上げて 96。EDL・着色設定は f32×8 | 名前: `NODE_UNIFORM_FIELD_BYTES`・`WGSL_UNIFORM_STRUCT_ALIGNMENT_BYTES`・`roundUpToMultiple`・`EDL_UNIFORM_F32_FIELDS`・`COLOR_SETTINGS_UNIFORM_F32_FIELDS`・`SKY_UNIFORM_VEC4_FIELDS`・`GRID_UNIFORM_VEC4_FIELDS` |
| `point-cloud-renderer.ts` の `getPointBudget` など 9 つ | `scripts/igpu-bench/bench.mjs` が名前で呼ぶ（参照の検索では見えない）ので消さない | テスト `bench-entry-points.test.ts`「every one of them is still a method of PointCloudRenderer (a reference search cannot see these calls)」 |
| `point-cloud-renderer.ts:applyCanvasSize`・`render-scale.ts:computeCanvasBackingSize` | devicePixelRatio を掛けない（掛けるとモバイルの 0.5 が実質 1.0 になり、デスクトップの高 DPI では重くなる）。結果は最低 1px（サイズ 0 の `createTexture` は失敗する） | ここ（`TaskSheets/M3-release-and-update.md` M3-8） |
| `point-cloud-renderer.ts:handleNodeLoaded`・`reportNodeLoadError` | 読み込み中に消したレイヤーの結果・失敗は黙って捨てる。強度の範囲はレイヤーごと（計測機が違うと幅が違う）。標高の範囲もレイヤーごと（L2-F: 合併だと離れたレイヤーの色の差が無くなる） | ここ（`TaskSheets/L1-multi-layer.md`） |
| `point-cloud-renderer.ts:addLayer` | 最初のレイヤーは視点を即座に置く（原点から数 km 先へ飛ぶ動きを見せない）。2 つ目からは視点移動のアニメーション | ここ |
| `point-cloud-renderer.ts:updateIdleBoost` | 戻すときに AIMD の窓を捨てる（止まっている間の重いフレームを「外した」と読ませない） | ここ（`idle-boost.ts` の決まりは `TaskSheets/HQ-high-quality-mode.md`） |
| `point-budget.ts:updateRefreshIntervalEstimate` | 全期間の最小値は、異常に短い間隔が一度来ると永久に固定される逆向きのラチェットだったので、直近 2 世代（15 秒×2）の最小値にした。4ms 未満は計測異常として捨てる。世代の長さは未検証の初期値 | `TaskSheets/ADR-0010-lod-priority-and-point-budget.md` 追記3 |
| `point-budget.ts:evaluatePointBudget`・`DEFAULT_POINT_BUDGET_TUNING` | rAF の間隔は vsync に量子化されるので、間隔の絶対値でなく「推定周期の 1.5 倍を超えたフレームの割合」で判定する。上げはゆっくり、下げは速く、間に不感帯。各値は未検証の初期値（`hitRatioToGrow` 0.05 は 20 フレームのうち 1 回のミスを許す） | `TaskSheets/ADR-0010-lod-priority-and-point-budget.md`・`ADR-0009-adaptive-render-settings.md` |
| `node-loader.ts:defaultMaxConcurrent` | 同時リクエスト数は論理コア数（上限なし。Rust のプールが本当の上限で、超えた分は待つだけ）。取れないときは 8、下限 4。`read_node` を直した後のベンチで論理コア数まで伸びることを実測 | `TaskSheets/ADR-0007-pcv-protocol-concurrency.md` 追記 |
| `node-loader.ts:generation` | ファイルを切り替えたら世代を進め、前の世代の結果は成功も失敗も黙って捨てる。古い世代の後始末で今の世代の `inFlight` に触らない | 既存のテスト `node-loader.test.ts`「NodeLoader: ファイル切り替え時の不具合の修正」（`TaskSheets/M4-import-and-conversion.md`） |
| `node-selection.ts:MIN_NODE_SPACING_PIXELS` | 0.5 と 1.0 を比べて 0.5（1.0 は高層ビルの壁が少しまばら）。測定は HQ-0 | `TaskSheets/HQ-high-quality-mode.md` LOD A |
| `node-selection.ts:selectNodesForLayers` | 視錐台の外と LOD A の部分木には降りない（子の箱は親に含まれるので結果は旧実装と同じ）。同じ優先度は hierarchy の添字の順。点予算は全レイヤーで 1 つ | 既存のテスト `node-selection-equivalence.test.ts`（`TaskSheets/L1-multi-layer.md`） |
| `screen-space-error.ts:screenSpaceError`・`projectedBoundsDiagonalPixels`・`surfaceSpacingPixels` | 誤差は点間隔（長さの次元）×ピクセル/ワールド単位。以前の式は体積の次元で、深いノードが読まれなかった。箱はニアプレーンでクリップしてから大きさを測る。LOD A だけは面に並ぶ点を仮定した間隔を使う | `TaskSheets/ADR-0010-lod-priority-and-point-budget.md`・`M1-point-rendering.md` M1-4・`HQ-high-quality-mode.md` |
| `center-priority.ts:centerPriorityWeight` | ガウス型（中央付近は平らで、離れると急に効く）、下限 0.2 で端のノードの飢餓を防ぐ。既定の強さ 4 は所有者が実機で 0/1/2/4 を試して決めた | `TaskSheets/ADR-0010-lod-priority-and-point-budget.md` 追記4 |
| `orbit-camera.ts:zoom` | カーソルへのズームは「点」でなく「方向」を使う。AABB の面を点の代理にすると、毎回「残りの何%」だけ進んで箱の面に漸近して止まる（方式そのものが成立しない） | `TaskSheets/M1-point-rendering.md` M1-5 |
| `orbit-camera.ts:attachOrbitControls` | 同時に押しているポインタの数で操作を決める（タッチは button が常に 0）。`canvas.style.touchAction = "none"`。タッチで寄った直後の `dblclick` は無視（同時に来るブラウザがある）。`pointercancel` でもポインタを外す | ここ（`TaskSheets/M3-release-and-update.md` M3-6） |
| `animation.ts` の時間・減速の定数 | どれも未検証の初期値。減衰は `exp(-dt/tau)` で書き、フレームレートに依存しない | 既存のテスト `animation.test.ts`（30fps と 144fps の比較）、`TaskSheets/AN-animation.md` |
| `colormap.ts:ELEVATION_INTENSITY_RAMP` | 緑と赤を直接補間すると中間が濁ったオリーブ色になるので黄を挟む（CloudCompare と同じ 4 点）。明度は単調でないが所有者の指定 | 名前: `YELLOW_BETWEEN_GREEN_AND_RED`（R2 で `YELLOW_SO_GREEN_TO_RED_IS_NOT_MUDDY` から改名。黄を挟む理由はこの行）。経緯は `TaskSheets/M2-shading-and-ui.md` M2-2 |
| `colormap.ts:ASPRS_CLASSIFICATION_COLORS` | 各コードの意味（地表・植生・建物・ノイズなど）。似た意味のコードは近い色相（植生 3〜5 は緑で明度だけ変える、ワイヤー関連 13・14・16 は黄土色）。7（Low Point noise）と 18（High Noise）は異常値として目立つマゼンタと赤。12（旧 Overlap Points）は 8 の灰色 0.5 と区別できるよう明度を 0.58 にずらした。表に無いコードはどの色とも被らないシアン（`UNKNOWN_CLASSIFICATION_COLOR`） | 名前: `ASPRS_CLASS` と、ここ |
| `gpu-resources.ts:ignoreBecauseDeviceLostNeverRejects` | `device.lost` は `Promise<GPUDeviceLostInfo>` で本来 reject しない。念のため `.catch` を付けて、未処理の rejection でコンソールを汚さない（R2 F-2。以前は空の `() => {}` だけが残っていた） | 名前: `ignoreBecauseDeviceLostNeverRejects` |
| `colormap.ts:FALLBACK_COLOR_MODE_WITHOUT_RGB` | RGB の無い点群の既定は標高（全点に必ず意味のある値があり、範囲がヘッダーから決まる）。強度はセンサー次第で意味が無いことがある | ここ（`TaskSheets/M2-shading-and-ui.md` M2-2） |
| `scene-bounds.ts:elevationRangeFromCloudBounds` | 標高の範囲はノードの箱（立方体で Z が水平の広さまで伸びる）でなく LAS ヘッダーの範囲から作る（「標高が全部紫」の不具合） | 既存のテスト `scene-bounds.test.ts`「実機不具合の再現: ノードのセル範囲(立方体)を標高に使ってはいけない」 |
| `pick-math.ts:refineDepthRange` | 2 段目の near/far は z/2〜2z。実機（NVIDIA、autzen、z≈8000）で 1 段目の距離が理論の量子化誤差の約 3 倍ずれ、余裕 4 段では外れた。原因は未特定 | ここ |
| `pick-math.ts` の 2 段階 | NEAR=0.01・FAR=1e7 の 24 ビット深度は遠くで粗い（z=3000 で 1 段 約 54）ので、1 段目で粗い距離、2 段目で狭い near/far で描き直して読む | ここ |
| `device-profile.ts` の既定値 | GPU 名・UA は見ず、`deviceMemory` と `pointer: coarse` の OR でモバイルと判定（ADR-0009）。モバイルのキャッシュは総メモリの 1/64、`deviceMemory` が無ければ 4GiB と仮定。どれも未検証の初期値 | `TaskSheets/ADR-0009-adaptive-render-settings.md`・`M3-release-and-update.md` M3-8 |
| `fly-to.ts:pickFlyToPoint` | 交差する箱のうち一番細かいものを選び、箱を実データの範囲で切る（autzen でデータの上端 615 に対し箱の面が 1570） | ここ |
| `raycast.ts:MIN_HIT_DISTANCE`・`intersectRayAabb` | カメラを含む箱は交点にしない（ズームで「交点＝カメラ位置」になり寄れなくなった）。ズームからは使っていないが、ピッキングの土台として残す | `TaskSheets/M1-point-rendering.md` M1-5 |
| `frustum.ts:frustumPlanes` | Gribb & Hartmann の方法。near の式は WebGPU の z 0..1 でも近似として十分 | 名前: `left`・`right`・`bottom`・`top`・`near`・`far` と、ここ |
| `layer-key.ts`・`layer-focus.ts` | キーの前置きはレイヤーの id でなく通し番号（同じ id を付け直しても前の読み込み結果を捨てられる）。カメラは合併でなく 1 レイヤーに合わせる（遠いファイルの合併は FAR を超える） | ここ（`TaskSheets/L1-multi-layer.md`） |
| `mat4.ts` の `// prettier-ignore` | 行列を 4 列で並べた形を保つ指示。このリポジトリに prettier は入っていない（`node_modules/.bin` に無い）ので、指示を消しても並びは変わらない | ここ |
| `animation.ts` の `FADE_IN_DURATION_MS`(250)・`INERTIA_TAU_MS`(325)・`INERTIA_SAMPLE_WINDOW_MS`(100)・`INERTIA_MAX_IDLE_MS`(60)・`INERTIA_STOP_*`・`ZOOM_SMOOTH_TAU_MS`(80)・`TRANSITION_DURATION_MS`(500。0.4〜0.6 秒の範囲)・`FLY_TO_DISTANCE_RATIO`(0.5)・`DOUBLE_TAP_*`(300ms・30px) | どれも実機で触って決めた値ではない、未検証の初期値。所有者が画面で調整する入口をこのファイルに集めた。`ZOOM_SMOOTH_STOP_LOG`(1e-3) は残りのズーム（自然対数）がこれ未満なら一度に適用して終える | ここ（`TaskSheets/AN-animation.md`） |
| `orbit-camera.ts:PAN_SPEED_PER_PIXEL_AND_DISTANCE`(0.0015)・`TAP_MAX_MOVE_PX`(10)・`DBLCLICK_IGNORED_AFTER_TOUCH_FLY_MS`(600)・`MIN_PAN_DISTANCE_RATIO`(0.0005)・`DEFAULT_PITCH`(0.3) | パンは距離に比例（マウスの移動量と見た目の移動を揃える簡易な近似）、寄りすぎたらシーンの対角線の 0.0005 倍を下限にする。タップは 10px 未満の動きで離したもの。タッチで寄った後 600ms の `dblclick` は無視。`DEFAULT_PITCH` 0.3（約 17°）は「少し見下ろしつつ地平線も見える」角度。10・600・0.0015 の値の根拠は元のコメントにも無い（R2 で名前を付けた） | 名前と、ここ |
| `point-budget.ts:DEFAULT_POINT_BUDGET_TUNING` の各値・`REFRESH_ESTIMATE_GENERATION_MS`(15 秒)・`MIN_PLAUSIBLE_REFRESH_INTERVAL_MS`(4ms = 250Hz) | ミスの閾値 1.5 倍は 1 倍と 2 倍の中間。`missRatioToShrink` 0.15 は 20 フレームの窓で 3 回、`hitRatioToGrow` 0.05 は 1 回。`sustainedHitsToGrow` 3 は 500ms ごとの評価で 1.5 秒。`growRate` 0.1・`shrinkRate` 0.2（下げを速く）。4ms 未満の間隔は計測の異常。どれも未検証の初期値 | `TaskSheets/ADR-0010-lod-priority-and-point-budget.md` と、ここ |
| `point-cloud-renderer.ts:AUTO_POINT_BUDGET_MIN`(20 万)・`AUTO_POINT_BUDGET_FRAME_HISTORY`(20)・`FALLBACK_REFRESH_INTERVAL_MS`(1000/60)・`STATS_INTERVAL_MS`(500)、`render-scale.ts:MIN_RENDER_SCALE`(0.05) | 下限 20 万点は「これより粗いと点群として意味が無い」経験的な値（実測ではない）。窓 20 本は単発の重いフレームに反応しないため（ADR-0009）。60Hz は最初のフレームまでの仮の値。統計は毎フレームだと受け手が重いので 500ms に間引く。`MIN_RENDER_SCALE` は R2 で名前を付けた（行数の上限のため `render-scale.ts` に置いた。値の根拠は元のコメントにも無い） | ここ |
| `edl.ts:DEFAULT_EDL_STRENGTH`(0.15)・`DEFAULT_EDL_RADIUS_PX`(1.4)・`EDL_RESPONSE_SCALE`(300)・`EDL_MIN_SHADE`(0.5)、`wgslFloat` の `toFixed(4)` | 強さはスクリーンショットを見て決めた未検証の初期値。半径は Potree の既定（1.0〜1.4）、300 は Potree の edl.frag の値。下限 0.5 は 0.3〜0.5 の範囲で見て決めた。`toFixed(4)` は WGSL の f32 リテラルに小数点を付けるため（`1` でなく `1.0000`） | `TaskSheets/M2-shading-and-ui.md` M2-1 と、ここ |
| `center-priority.ts:DEFAULT_MIN_CENTER_PRIORITY_WEIGHT`(0.2)・`DEFAULT_CENTER_PRIORITY_STRENGTH`(4)・`halfDiagonal` の `1e-6` | 0.2 は「下限が無いのと同じにならず、中央優先の効果も消えない」設計判断（実機で調整していない）。4 は所有者が 0/1/2/4 を試して一番良かった値。`1e-6` は大きさ 0 の canvas での 0 除算よけ | `TaskSheets/ADR-0010-lod-priority-and-point-budget.md` 追記4 |
| `ground-grid.ts:GRID_LINE_COLOR`・`GRID_MAX_ALPHA`(0.35)・`TARGET_CELLS_ACROSS_SCENE`(40)・`FADE_DISTANCE_RATIO`(1.5)・`niceGridCellSize` の 1.5・3.5・7.5 | 線は背景に薄く重ねるだけ（点群を邪魔しない）。間隔は対角線をおよそ 40 マスに割り、1-2-5 系列に丸める（軸の目盛りの定番の方法。例: 対角線 100m → 2m 刻み） | ここ |
| `sky.ts` の色（`SKY_COLORS`・`SOLID_DARK_CLEAR` など） | 色は主観で、実機の感想で 2 回直した（白っぽい → 暗すぎ → その中間）。地面の色は地平線とはっきり分ける | `TaskSheets/M2-shading-and-ui.md` M2-0c |
| `device-profile.ts:MOBILE_LOW_MEMORY_THRESHOLD_GIB`(4)・`MOBILE_RENDER_SCALE`(0.5)・`MOBILE_POINT_CACHE_MEMORY_FRACTION`(1/64)・`MOBILE_FALLBACK_DEVICE_MEMORY_GIB`(4)・`DESKTOP_POINT_CACHE_MEMORY_BUDGET_BYTES`(1GiB) | 4GiB は所有者の実機を基準にした判断。0.5 はタスクシートの指定。1/64 は 4GiB 端末で 64MiB、点予算の上限 約 168 万点になる保守的な値。1GiB は ADR-0010 の値をそのまま。モバイル側はどれも未検証の初期値 | `TaskSheets/M3-release-and-update.md` M3-8 |
| `node-loader.ts:CONCURRENCY_MEASURED_IN_ADR_0007`(8)・`MIN_CONCURRENCY_SO_FEW_CORES_DO_NOT_SERIALIZE`(4) | コア数が取れないときは実測で裏付けのある 8。コア数を極端に少なく申告する環境で直列化しないよう下限 4 | 名前（R2）と `TaskSheets/ADR-0007-pcv-protocol-concurrency.md` |
| `pick-math.ts:PERSPECTIVE_MIN_MARGIN_STEPS`(4)・`ORTHOGRAPHIC_MARGIN_STEPS`(32)・`ORTHOGRAPHIC_MIN_MARGIN_FRACTION`(0.002)・`COARSE_HALF`(4) | 上の `refineDepthRange` の行の余裕（とても遠くで粗い 1 段が z/2 を超えるときの 4 段、平行投影の 32 段・範囲の 0.2%）。1 段目の窓は半径 4 で、点の幅が数ピクセルなので少しの隙間を許す | 名前（R2）と、ここ |
| `up-axis.ts:UP_TOO_CLOSE_TO_Z_FOR_A_Z_SEED`(0.9)・`view-presets.ts:UP_IS_AN_AXIS`(0.999)・`MATCH_TOLERANCE`(0.02)・`ISOMETRIC_PITCH`(35°) | 上方向が Z に近いと種の Z と外積が 0 になるので種を X にする。上方向がちょうど Z（Y）なら地図の慣習の北を使う。0.02 ラジアン（約 1.1°）以内なら固定の視点にいるとみなす。等角の仰角は約 35° | 名前（R2）と、ここ |
| `section-2d.ts:MAX_TICKS`(1000)・`CSS_PX_PER_HORIZONTAL_TICK`(90)・`CSS_PX_PER_VERTICAL_TICK`(50)・`SMALL_DOT_MAX_POINTS`(30 万)・`LABEL_HEIGHT_PX`(14) | 目盛りの数の上限（壊れた範囲で無限に回らない）、目盛りの間隔のおよその画面幅。30 万点を超えたら 1 点 1 ピクセル、以下なら 2x2（まばらな断面を見えるように）。ラベルは 11px の文字 | 名前（R2）と、ここ |
| `layer-focus.ts:DEFAULT_POINT_SIZE_PX`(4)・`MAX_POINT_SIZE_PX`(32)、`idle-boost.ts:IDLE_BOOST_DELAY_MS`(500)、`screen-project.ts:LABEL_WIDTH_PX`(190)、`touch-gesture.ts:MIN_DISTANCE`(1e-3)、`raycast.ts:MIN_HIT_DISTANCE`(0.01)、`screen-space-error.ts:NEAR_W_EPSILON`(1e-6) | 4 は変更前の固定値と同じ（触らなければ見た目は変わらない）。500ms は未検証の初期値。190px は 12px のラベルのおよその幅。1e-3 は指が重なる瞬間の 0 除算よけ。0.01 は NEAR と同じ程度。1e-6 は 0 除算よけで、カメラのニアとは関係ない（元のコードから引き継いだ値） | ここ |
| `src/renderer/*.test.ts` のテストの入力値 | テストの入力（距離・点数・フレーム間隔など）の説明のコメント。期待する性質はテストの名前にある。CM-5 の道具で 225 か所が出たが、テストの入力値には名前を付けていない | ここ（R2 で一覧を見て判断した） |

## 記録

### 実装の記録 R1（作業役）

#### やったこと

- **シェーダー（AC-6・AC-7）**: 5 つのファイルの `/* wgsl */` のテンプレート文字列を `src/renderer/shaders/{depth-window,edl,points,ground-grid,sky}.wgsl` に出し、`?raw` で import した。WGSL のコメントも消した
  - 埋め込んでいた値: EDL の `EDL_MIN_SHADE`・`EDL_RESPONSE_SCALE` は `edl.wgsl` では名前のまま書き、`edl.ts` が `const EDL_MIN_SHADE: f32 = 0.5000;` の 2 行を前に付ける。点の色ランプ（`rampToWgslFunction` の結果）は `gpu-resources.ts` が `points.wgsl` の前に付け、関数名 `elevationOrIntensityRampColor` は `points.wgsl` に直接書いた（`shaders.test.ts` が生成側と呼ぶ側の名前の一致を見る）
  - `src/code-limits.test.ts` に `hasWgslEntryPoint` と、テスト以外の TS に `@vertex`・`@fragment`・`@compute` があれば落ちるテストを足した
- **コメントを消す（AC-1・AC-3）**: `scripts/check-comments.mjs` の `findScriptCommentRanges` で範囲を出し、指示（CM-0 の例外）以外を消す一時スクリプト（コミットしていない）で、67 ファイルから 2,133 個を消した。コメントだけの行は行ごと消し、その跡の空行（2 行続く・`{` の直後・`}` の直前）も消した。行末・行中のコメントは前後の空白ごと消した
  - 消した後に手で直した所: `ground-grid.ts`・`sky.ts` の `4 /* lineColor */;` のように式の中にあったコメントの跡（` ;`）は、フィールドの一覧の定数に置き換えた
- **意図を名前・テストに移す（AC-2）**: 上の表。足した名前は `ASPRS_CLASS`（使い手 19、`colormap.ts` の中だけ）、ランプの色 4 つ（各 1、`ELEVATION_INTENSITY_RAMP` だけ）、uniform のフィールドの一覧 5 つと `NODE_UNIFORM_FIELD_BYTES`・`WGSL_UNIFORM_STRUCT_ALIGNMENT_BYTES`・`roundUpToMultiple`（各 1）、`frustumPlanes` の中の 6 つの局所変数。テストは `bench-entry-points.test.ts`・`shaders/shaders.test.ts` を足した
  - 既存の識別子の名前は変えていない（`grep` で数える使い手は無い）。消した別名は `depth-pick.ts:SHADER`・`ground-grid.ts:GRID_SHADER_SRC`・`sky.ts:SKY_SHADER_SRC`（どれもファイルの中で 1 か所だけ使っていた。import の名前を直接使う）
- **行数に依存する物（AC-4）**: `src/code-limits.test.ts` の BASELINE から `gpu-resources.ts` を消し（654 行で 800 以下）、`point-cloud-renderer.ts` を 1309 → 867 に下げた。`TaskSheets/ADR-0024-progressive-open.md` の `src/renderer/` の `path:line` 11 か所を新しい行に直した（`hierarchyByKey` は型の宣言でなく `addLayer` の中で作る行 309 を指す）

#### シェーダーの文字列が変わっていないことの確かめ方（AC-6）

一時スクリプト（コミットしていない）で、`git show d05c858:<ファイル>` のテンプレート文字列から WGSL のコメントを `findRustCommentRanges` で除き、空行と行末の空白を除いたものと、今の `.wgsl`（TS が前に付ける物も付けた形）を比べた。

- `depth-window.wgsl`・`ground-grid.wgsl`・`sky.wgsl`: 一致（`identical`）
- `edl.wgsl`: 違いは次の 2 つだけ。先頭に `const EDL_MIN_SHADE: f32 = 0.5000;`・`const EDL_RESPONSE_SCALE: f32 = 300.0000;` が付いたことと、`max(0.5000, exp(-response * 300.0000 * u.strength))` が `max(EDL_MIN_SHADE, exp(-response * EDL_RESPONSE_SCALE * u.strength))` になったこと（同じ値の WGSL の定数）
- `points.wgsl`: 違いは色ランプの関数の置き場所だけ（構造体の宣言の後から、文字列の先頭へ）。WGSL のモジュールの宣言は順番に依らない
- 改行: TS のテンプレート文字列は CRLF を LF にするが、`?raw` は作業ツリーのファイルをそのまま読むので、Windows のチェックアウト（`core.autocrlf=true`）では CRLF が入りうる。WGSL では改行は空白なので意味は変わらない（推定。GPU で確かめていない）

#### AC-7 の守りが落ちることの確かめ方

`git show d05c858:src/renderer/sky.ts > src/renderer/sky.ts` で元の形に一時的に戻し、`npx vitest run src/code-limits.test.ts` が `no TypeScript source outside tests has a WGSL entry point` で `[ 'src/renderer/sky.ts' ]` を出して落ちる（`Tests  1 failed | 8 passed (9)`）ことを見て、作業中のファイルに戻した。

#### 採らなかった案

- WGSL の `override` 定数で EDL の値を渡す: パイプラインの作り方（`constants`）が変わるので、前に `const` を付ける形にした
- `.wgsl` に `{{EDL_MIN_SHADE}}` のような置き換えの印を書く: 文字列は元と完全に一致するが、`.wgsl` が WGSL として読めなくなる
- `.gitattributes` に `*.wgsl text eol=lf`: ルートの設定は CM-3 の範囲なので触らなかった（上の改行の件は CM-3 かメインの判断）
- `ELEVATION_INTENSITY_RAMP_WGSL_FN` を `colormap.ts` に移して `shaders.test.ts` から import する: 名前の変更と切り出し以外の移動になるので、テストは関数名を文字列で書いた

#### 触ったファイル

- `src/renderer/` の 67 ファイル（コメントを消した）、新規 `src/renderer/shaders/*.wgsl`（5）・`shaders/shaders.test.ts`・`bench-entry-points.test.ts`
- `src/code-limits.test.ts`（BASELINE と WGSL の守り）、`scripts/comment-baseline.json`（`src/renderer/` の 67 項目を消した）、`TaskSheets/ADR-0024-progressive-open.md`（行の参照）、このシートの記録

#### 数

- `scripts/comment-baseline.json` の合計: 12,261 → 10,123（2,138 減。`/* wgsl */` の目印 5 個を含む）。`src/renderer/` の項目は 0
- `git diff --stat d05c858` の時点で 77 files changed, 653 insertions(+), 4565 deletions(-)（シートの記録を足す前）

#### 検査の結果

- `npm run check:all` を 3 回実行し、2 回は全部 OK（vitest 99 files 1119 tests passed）。1 回は vitest の `src/layer-rules.test.ts > rule 2: … > allows them in tauri.ts` が `Test timed out in 5000ms` で落ちた。このテストは ESLint を起動するもので CM-1 の範囲の外（変えていない）。他の worktree が並行してビルドしていた時で、次の実行では通った。負荷による時間切れと推定（未検証）
- `node scripts/check-task-sheet.mjs d05c858` → `task sheets OK (97 files compared with d05c858)`

#### 確かめていないこと

- 画面・GPU: シェーダーを `.wgsl` に出した後に点群・空・グリッド・EDL・ピッキングが同じに描けるかは、GPU のある環境で見ていない（未確認）。確かめ方: `npm run dev` で `sofi.copc.laz` か autzen を開き、背景を空にしてグリッドをオン、EDL のオン・オフ、着色を標高・強度・分類に切り替え、点の形を丸・四角に、計測で点を 2 つ拾う。どれも変更前と同じに見え、エラーのバナーが出ないこと
- `?raw` の WGSL が Windows（CRLF）と Linux（LF）で同じに動くか（上の推定）

### 監査の指摘への対応 R2（作業役）

- F-1（must）: `points.wgsl` で、`${ELEVATION_INTENSITY_RAMP_WGSL_SRC}` の行を消した跡の 2 行続きの空行を 1 行にした。監査役の赤のテスト `shaders.test.ts`「no shader file keeps two blank lines in a row where a comment or a template value was removed」は弱めずにそのままコミットした（直す前は落ち、直した後は通る）
- F-2（should）: `device.lost` の `.catch(() => {})` を `.catch(ignoreBecauseDeviceLostNeverRejects)` にした（中身は同じ空の関数）。表に 1 行足した
- F-3（should）: `YELLOW_SO_GREEN_TO_RED_IS_NOT_MUDDY` → `YELLOW_BETWEEN_GREEN_AND_RED`（使い手 1、`ELEVATION_INTENSITY_RAMP` だけ。`grep -rn YELLOW_ src` で確かめた）。理由は表の `ELEVATION_INTENSITY_RAMP` の行
- F-4（nit）: 分類の色の理由（7・18 は異常値として目立つ色、12 は 8 と区別するため明度 0.58、未知のコードはシアン）を表の `ASPRS_CLASSIFICATION_COLORS` の行に足した
- F-5（nit）: `src/renderer/shaders/uniform-layout.test.ts` を足した。TS のフィールドの一覧（`EDL_UNIFORM_F32_FIELDS`・`SKY_UNIFORM_VEC4_FIELDS`・`GRID_UNIFORM_VEC4_FIELDS`・`COLOR_SETTINGS_UNIFORM_F32_FIELDS`・`NODE_UNIFORM_FIELD_BYTES`）と、`.wgsl` の構造体のフィールドを、名前と順番で比べる。点の uniform の書き込み位置も `NODE_UNIFORM_FLOAT_INDEX`（R2 で `uniformData[16]`〜`[20]` に付けた名前）として、`mvp` の 16 個の後に構造体の順で並ぶことを見る。`edl.ts` の `"orthoRef", "_pad1"` を一時的に入れ替えると `edl.ts EDL_UNIFORM_F32_FIELDS lists the fields of EdlUniforms in order` が落ちることを確かめて戻した
- F-6（nit）: `src/code-limits.test.ts` の `hasWgslEntryPoint` の `export` を外した
- 消したコメントの近くに残った名前の無い数値: `C:\workspace\pcv-wt-CM-5\scripts\removed-comments-near-literals.mjs` を読み取りだけで `node …/removed-comments-near-literals.mjs d05c858 src/renderer` として実行した（自分のブランチにはコピーしていない）。354 件（テスト 225、テスト以外 129）
  - テスト以外: 既に名前の付いた定数（その名前の値の理由をコメントが説明していた物）は、理由を表に足した（`animation.ts`・`point-budget.ts`・`edl.ts` ほか 14 行）。名前の無かった数値には名前を付けた: `orbit-camera.ts` の 0.0015・10・600、`node-loader.ts` の 8・4、`pick-math.ts` の 4・32・0.002、`point-cloud-renderer.ts` の 0.05（`render-scale.ts:MIN_RENDER_SCALE`。`point-cloud-renderer.ts` の行数の上限 867 を超えないよう、既存の import の行に足した）、`up-axis.ts` の 0.9、`view-presets.ts` の 0.999、`section-2d.ts` の 1000・90・50、`gpu-resources.ts` の `uniformData` の添字 16〜20
  - 残した物: 型の文字列（`"rgb"`・`"top"` など）、配列の添字の 3（xyz の 3 成分・w）、バイト数の `* 4`（f32 の 4 バイト）、行列の 16 など、道具が数えても意味が自明な物。直した後に同じ道具を実行すると 341 件（テスト以外 116。名前を付けた定数の宣言の行も道具は数える）
  - テスト: 入力値の説明だったので名前は付けず、表に 1 行（上）

#### R2 の検査の結果

- `npm run check:all`: typecheck・lint・check:circular・check:docs・check:comments・vitest（100 files 1126 tests passed）・cargo fmt (workspace)・cargo clippy (workspace)・cargo fmt (vendor/copc-writer) が全部 OK
- `node scripts/check-task-sheet.mjs d05c858` → `task sheets OK (97 files compared with d05c858)`
