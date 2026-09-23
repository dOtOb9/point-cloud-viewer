# ADR-0010: LOD優先度の式の次元を直し、点予算を自動調整にする

- 状態: 採択
- 日付: 2026-09-23
- 前提: [M1-point-rendering.md](./M1-point-rendering.md) M1-4、
  [ADR-0009](./ADR-0009-adaptive-render-settings.md)（描画設定の自動調整方針）

## 決定

1. `src/renderer/screen-space-error.ts` の `screenSpaceError()` を、次元の合わない
   `sizePixels / density`（density=点数/体積）から、`点間隔(ワールド) ×
   ピクセル/ワールド単位` に直す。
2. `src/renderer/point-budget.ts` に、フレーム時間の閉ループで点予算を決める純粋関数
   `nextPointBudget()` を新設し、`point-cloud-renderer.ts` から呼ぶだけにする。

この2つは別々の問題（優先度の式の次元 / 点予算の決め方）だが、どちらも
「LODがどのノードをどれだけ読み込むか」を決める同じ経路にあり、Aを直さないと
Bの動作を実機で正しく評価できない（優先度が壊れていると、点予算をいくら
賢く増減させても、そもそも読み込まれるべきノードが選ばれない）ため、
1つのADRにまとめる。

## タスクA: 優先度の式の次元を直す

### 問題（診断は所有者から前提として与えられたもの）

旧式:

```
sizePixels = 画面上のBBOX対角長（ピクセル）
density = 点数 / 体積
screenSpaceError = sizePixels / density
```

「まばらさ」を測るつもりで `体積 ÷ 点数`（点間隔の**3乗**、体積の次元）を使っていたが、
本来「まばらさ」は点間隔（**1次元**、長さ）で測るべきものだった。

`sofi.copc.laz` のヒエラルキ実測では、ノードあたり点数はレベルによらずほぼ一定
（約25,000点。レベル0〜7で52296, 13937, 20740, 23032, 25349, 24127, 29723, 27015）。
octreeは1レベル下がると体積が1/8になるので、旧式では

- 体積÷点数が1/8
- sizePixelsも（ノードの一辺が半分になるので）さらに1/2

で、**誤差が1レベルあたり約1/16に落ちる**。距離の効果は1/距離の1乗しかないため、
浅く遠いノードに深く近いノードが優先度で勝つには非現実的な倍率の接近が必要になり、
点予算（3,000,000点 ÷ 約25,000点/ノード ≈ 120ノード）が浅いレベルだけで尽きて、
深いレベルのノードが事実上読み込まれなくなっていた。

### 新しい式

```
点間隔 = (体積 / 点数) ^ (1/3)                 … 長さの次元（1次元）
ピクセル/ワールド単位 = sizePixels / ワールド対角長  … そのノード位置での投影スケール
screenSpaceError = 点間隔 × ピクセル/ワールド単位
```

`sizePixels`（画面上のBBOX対角長）は既存の `projectedBoundsDiagonalPixels()` の
戻り値をそのまま使う。**この関数はニアプレーンのクリップ処理を含む繊細なコード
（M1-point-rendering.md M1-4の実機不具合対応で書かれた）なので中身は変更していない。**

この式なら、1レベル下がると点間隔がちょうど1/2になり、他の項（距離由来の
ピクセル/ワールド単位）は変わらないので、誤差もちょうど1/2になる。「1レベル
深くなる」ことと「距離が2倍近づく」ことが釣り合う、素直なスケーリングになる。

### 検証

`src/renderer/screen-space-error.test.ts` に2つのテストを追加した（`npx tsx`で
実際に数値計算して確認した具体的な座標・カメラ行列を使っている。以下の数値は
すべてそのtsx実行で得た実測値であり、期待値ではない）。

1. **親ノードと子ノード（体積1/8・点数同じ・同じカメラ距離）の誤差比が0.45〜0.55**
   一辺10と一辺5の立方体（体積比1/8）を、距離100・点数25,000で比較。
   実測比: **0.4872**（旧式ならこの比は約1/16=0.0625付近になり、範囲に入らない）。
2. **レベル差3（誤差比 約1/8）でも、距離が約1/8近い深いノードのほうが優先度が高い**
   一辺80/距離850のノードと、一辺10（3レベル分細かい）/距離100
   （850÷100≈8.5、「約1/8」）のノードを比較。
   実測: shallowError ≈ 2.579, deepError ≈ 2.749（deepが約6.6%高い）。
   なお距離をちょうど1/8（106.25）にすると理論上ぴったり同点になることも
   `npx tsx`で確認した（点間隔由来の1/8とピクセル/ワールド単位由来の8倍が
   ちょうど相殺するため。これは新しい式が「距離1/2 ≒ レベル1つ」という
   設計どおりに機能していることの裏付けでもある）。

既存の `screen-space-error.test.ts` の4テストは変更なしで通った
（同一パラメータで統一されたノード群を使うテストのため、新式でも旧式と
同様に優先度が分散することを確認できる）。

### 却下した案

| 案 | 却下理由 |
|---|---|
| `projectedBoundsDiagonalPixels`ごと書き直す | ニアプレーンクリップの実装は既に実機不具合の修正を経た繊細なコード。触る理由が無い |
| 点間隔を`体積/点数`（3乗のまま）にして係数だけ調整する | 次元が合っていないという根本原因を残したまま数値だけ合わせる対症療法になる |

## タスクB: 点予算を自動調整にする

### 決定

`src/renderer/point-budget.ts` に純粋関数 `nextPointBudget(current, recentFrameMs, opts)`
を作る。WebGPUデバイスもReactも要らないので、レンダラを一切起動せずvitestで
検証できる。`point-cloud-renderer.ts`はこれを呼んで`pointBudget`に代入するだけ。

```
if (recentFrameMs > target + deadZone)      → current * (1 - shrinkRate)  （速く下げる）
else if (recentFrameMs < target - deadZone) → current * (1 + growRate)    （ゆっくり上げる）
else                                         → current のまま（不感帯）
結果は必ず [limits.min, limits.max] に収める
```

ADR-0009の閉ループの作り方をそのまま反映している:

- 目標は**フレーム時間**（デフォルト1000/60ms）であってfpsではない
- 上げ(`growRate`)と下げ(`shrinkRate`)を別の割合にし、`shrinkRate > growRate`にする
  （上げはゆっくり、下げは速く）
- 不感帯(`deadZoneMs`)を目標の前後に設け、境界で往復しないようにする
- 呼び出し側（`point-cloud-renderer.ts`）は直近フレームの**中央値**
  （`medianOf()`、直近20フレーム分）を渡す。単発の重いフレーム（ノード到着時など）に
  反応しないため
- 上限・下限を持つ（`limits.min`/`limits.max`）

`point-cloud-renderer.ts`側の結線:

- `renderOnce()`で毎フレーム`recordFrameDelta()`（直近フレーム時間を記録）と
  `autoAdjustPointBudget()`（500msごとに評価。`STATS_INTERVAL_MS`と同じ間隔）を呼ぶ
- `setPointBudget()`（既存の手動設定API）を呼ぶと自動調整を止める
  （`autoPointBudgetEnabled = false`）。ADR-0009:「ユーザーの手動設定を常に優先する。
  手で変えたら自動調整は止まる」に対応
- `setAutoPointBudgetEnabled(enabled)` / `getAutoPointBudgetEnabled()` を新設し、
  手動で自動調整を再開・停止できるようにした
- `RenderStats.autoPointBudgetEnabled` を追加し、`useCopcViewer.ts`のRust側stdoutログに
  `autoPointBudget=...` を足した（ADR-0009:「現在値を画面に出す」）

### 数値について正直に書く

**`DEFAULT_POINT_BUDGET_TUNING`（`targetFrameMs`以外の`deadZoneMs`/`growRate`/
`shrinkRate`）と`AUTO_POINT_BUDGET_MIN`/`AUTO_POINT_BUDGET_MAX`は実測していない。**
`point-budget.ts`と`point-cloud-renderer.ts`のコメントに明記した。

- `deadZoneMs=4`, `growRate=0.05`, `shrinkRate=0.2`: ADR-0009の設計方針
  （上げより下げを速くする・不感帯を設ける）を満たす形で経験的に選んだ初期値。
  実機でのチューニングが別途必要
- `AUTO_POINT_BUDGET_MIN=200,000`: 「これより粗いと点群として意味が無い」という
  経験的な最低ライン。実測ではない
- `AUTO_POINT_BUDGET_MAX=3,000,000`（既存の`DEFAULT_POINT_BUDGET`をそのまま流用）:
  自動調整が「これまでの開発機前提の固定値」を超えて増やさないようにする保守的な
  選択であって、対象端末（OPPO Pad Air等）の実測上限ではない

**端末情報（`adapter.limits`など）から上限を決める仕組みは今回のタスクの範囲外。**
ADR-0009が「静的情報の使いどころ」として挙げているこの部分は、
[M3-8](./M3-release-and-update.md)の端末適応作業に送る。

### 検証

`src/renderer/point-budget.test.ts`（5テスト、`npm test`で確認。すべて`nextPointBudget`
単体で、レンダラを一切起動していない）:

1. 目標を大きく超えるフレーム時間（+20ms）を50回与えると、予算が単調に減り
   下限（200,000）に到達する
2. 目標を大きく下回るフレーム時間（-10ms）を200回与えると、予算が単調に増え
   上限（3,000,000）に到達する
3. 不感帯（target±4ms）の内側（±1ms）を交互に20回与えても、予算が一切変化しない
4. 不感帯のすぐ外側（target±5ms）では、上げ・下げの両方向にちゃんと反応する
   （不感帯が広すぎて固まっていないことの確認）
5. 極端な入力でも結果が常に`limits`の範囲に収まる

### 却下した案

| 案 | 却下理由 |
|---|---|
| `point-cloud-renderer.ts`に直接if文で書く | ADR-0009が要求する「素朴に書くと振動する」ロジックを単体テストできなくなる。純粋関数に切り出す指示（タスクB要件）にも反する |
| 単発フレームの時間をそのまま使う | ADR-0009:「単発の重いフレーム（ノード到着時など）に反応しない」ために中央値を使うと明記されている |
| 上限を`navigator.deviceMemory`等から動的に決める | このタスクの範囲では「端末情報が意図的に粗い」問題（ADR-0009参照）への対処が別途要り、今回は「実測していない数値を実測したと書かない」ことを優先し、保守的な固定上限に留めた。M3-8に送る |

## 触ったファイル

- `src/renderer/screen-space-error.ts`（タスクA: 式の変更）
- `src/renderer/screen-space-error.test.ts`（タスクA: 新規テスト2件）
- `src/renderer/point-budget.ts`（タスクB: 新規。純粋関数`nextPointBudget`/`medianOf`）
- `src/renderer/point-budget.test.ts`（タスクB: 新規テスト5件）
- `src/renderer/point-cloud-renderer.ts`（タスクB: `nextPointBudget`の呼び出し、
  `setAutoPointBudgetEnabled`/`getAutoPointBudgetEnabled`の追加、
  `RenderStats.autoPointBudgetEnabled`の追加）
- `src/state/useCopcViewer.ts`（タスクB: stdoutログに`autoPointBudget=...`を追加）

## 所有者が自分で確認する手順

### タスクA・タスクB共通（テストとCI）

```bash
npm run typecheck   # 通ること
npm run lint        # 通ること
npm run test        # 68件（旧63件+タスクA2件+タスクB5件+関連の-2の差分調整...実際の件数はテスト出力で確認）すべてpassすること
```

`screen-space-error.test.ts`と`point-budget.test.ts`のコメントに、テスト内の数値が
何を計算した結果かを書いてあるので、疑わしければ`npx tsx`で該当の式を打ち直して
自分で数値を再現できる。

### 実機での確認（GUIが必要。この作業では未実施）

**GUIでの目視確認はこの環境ではできなかった。** 以下は所有者に確認してほしい項目:

1. `npm run tauri dev` で `sofi.copc.laz` を開く。以前は「レベル5以上が事実上
   ロードされない」状態だったはずなので、寄っていったときに以前より高いレベルの
   ノードが実際に読み込まれる（`cachedNodes`が増え続ける・寄った先の精細さが
   上がる）ことを確認する
2. 統計表示（InfoPanel、または`npm run tauri dev`のRust側stdout）に
   `autoPointBudget=true`が出ること。負荷をかけて（速く動き回る、大きい点群を
   開く）フレームが重くなったとき、`pointBudget`が自動的に下がっていくことを
   確認する
3. UIから点予算を手動で変更したとき、`autoPointBudget`が`false`になり、以後
   自動では変わらないことを確認する（未実装: 自動調整を再開するUIは今回
   作っていない。必要なら`setAutoPointBudgetEnabled(true)`を呼ぶ経路をUIに
   追加すること）

3点目にある通り、**`setAutoPointBudgetEnabled()`を呼び出すUIはまだ無い**
（`PointCloudRenderer`のメソッドとしては存在する）。UIからの結線は今回のタスク
（優先度の式・点予算の自動調整ロジック）の範囲外としたため、必要であれば
別タスクとして扱うこと。
