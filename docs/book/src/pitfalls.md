# 落とし穴と教訓

[`TaskSheets/HANDOFF.md`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/HANDOFF.md) は、繰り返し踏んだ落とし穴を3種類に整理しています。
この章ではそれぞれに、具体例とどのファイルの話かを添えます。

## 一方向にしか動けず、回復経路を持たない設計(3回)

同じ形の不具合が、ノードの読み方・点予算・リフレッシュ周期の推定の3箇所で
起きました。共通するのは「**下がることはできても、上がる経路が無い、または
原理的に発生しない**」という構造です。

### 点予算が下がる一方で戻らない(ラチェット)

[`src/renderer/point-budget.ts`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/renderer/point-budget.ts) の最初の実装は、`requestAnimationFrame` の
コールバック**間隔**をそのまま「描画の重さ」として使っていました。60Hz
環境では間隔が 16.7/33.3/50.0 ms に量子化されるため、**予算を上げる条件
（16.7ms 未満）は原理的に発生しません**（rAF は次の vsync まで待たされるため）。
結果、点予算は下がる一方で二度と戻らないラチェットになっていました。

対処として「vsync に間に合っているか」を信号にした AIMD（Additive Increase /
Multiplicative Decrease）に作り直されましたが、**その入力を作る
`updateRefreshIntervalEstimate` 自体に、今度は逆向きの同じ構造のラチェットが
残っていました。** 「これまで観測した最小の間隔を、より小さい値が来たときだけ
更新する」という単調非増加の関数は、異常に短い間隔（ウィンドウの再表示時の
rAF 連続発火など）が一度でも来ると、その小さい値に永久に固定されます。
最終的には「直近2世代（30秒）の最小値」という、時間で区切って自己修復できる
設計に落ち着いています。詳細は [ADR-0010 の追記1〜3](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0010-lod-priority-and-point-budget.md) を参照してください。

**教訓**: 新しく制御ループや推定を書くときは「この値は下がった（上がった）あと、
逆方向に戻れるか」を必ず確認してください。片方向だけ検証して満足しないことです。

### カーソル位置へのズームが3回書き直された

[`src/renderer/orbit-camera.ts`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/renderer/orbit-camera.ts) の `zoom()` は、当初「AABB とレイの交点という
『点』を求め、そこへ target を寄せる」方式でした。この方式は、寄る対象
（AABB の面）が点群の点そのものではなく、近づくほど移動量が0へ潰れて
**止まってしまう**という、構造的に成立しない設計でした。レイキャストの
バグを2つ直しても症状は変わらず、最終的に「カーソル位置を通るレイの**方向**
だけを使い、移動量は自分自身が縮めている距離に比例させる」という、代理を
経由しない方式に書き直して解決しています。詳細は [`M1-point-rendering.md`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/M1-point-rendering.md) の
M1-5 を参照してください。

**教訓**: 「対象までの距離に比例して縮む」式を書くとき、縮む対象が
本物のデータ（点群の点）ではなく代理（AABB の面、深度バッファの値）だと、
代理に近づくほど代理へ漸近して止まります。代理を使う方式は、代理と本物が
ずれる場面を先に洗い出してください。

## すべて緑なのに壊れている(4回)

静的解析・単体テスト・ビルド・CI がすべて成功しているのに、実機では壊れていた
事例です。**緑は「確かめた」の代わりになりません。**

### EDL の `depthStencil` 欠落で画面が真っ黒

[`src/renderer/edl.ts`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/renderer/edl.ts) の合成パイプラインが `depthStencil` の宣言を忘れていました。
WebGPU では、深度アタッチメントを持つレンダーパスの中で `draw` する全てのパイプラインが
同じフォーマットの `depthStencil` を宣言していないとパスと非互換になり、
**コマンドエンコーダ全体が無効化されてそのフレームが丸ごと捨てられます。**
これはブラウザの WebGPU 実装が実行時に出すバリデーションエラーであり、
`npm run typecheck`/`lint`/`test`/`build`、CI のどこにも現れません。この事故が
[WebGPU エラー可視化の仕組み](./frontend/renderer.md#エラーの表示-gpu-error-logts--gpuerrorbannertsx)（`GpuErrorLog`/`GpuErrorBanner`）を作る直接のきっかけになりました。
詳細は [ADR-0011](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0011-gpu-error-visibility.md) を参照してください。

### インストーラ抜きの Release が「成功」する

[`.github/workflows/release.yml`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/.github/workflows/release.yml) で、ビルド成果物のパスを誤って指定していました。
`softprops/action-gh-release` は既定では「添付ファイルが0件でも失敗しない」ため、
**インストーラが1つも付いていない Release が、ワークフロー上は「成功」として
公開されていました。** `fail_on_unmatched_files: true` を追加し、ビルド成果物を
毎回ログに残すステップを足すことで、次に同じ形の不具合が起きても気付けるように
しています。詳細は [配布の章](./distribution.md)を参照してください。

### 標高カラーマップが全部紫になる

[`src/renderer/scene-bounds.ts`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/renderer/scene-bounds.ts) が分離される前、カメラ位置決め用の「シーンの
バウンディングボックス」（octree ノードの立方体セル由来、水平方向に合わせて
Z 方向も大きく引き伸ばされる）と、標高カラーマップ用の「標高の正規化レンジ」
（LAS ヘッダーの実データ範囲）が、同じ変数として混同されていました。航空測量
データは水平方向が数 km、実際の標高差が数十 m しかないため、正規化レンジが
実際の何十倍にも広がり、**全点の正規化値がほぼ0（レンジの下端）に張り付いて
同じ色になっていました。** テスト・ビルドは通っていましたが、この種の
「数値としては動くが、値の意味が違う」バグは単体テストだけでは見つかりにくく、
実機で色を見て初めて発覚しました。

### レンダースケールがタブレットで効いていない

[`src/renderer/render-scale.ts`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/src/renderer/render-scale.ts) の当初の実装は「表示サイズ × `devicePixelRatio` ×
レンダースケール」という式でした。モバイルの既定値（レンダースケール 0.5）を
`devicePixelRatio`（タブレットでは 2 前後の見込み）と掛け合わせると
`2 × 0.5 = 1.0` 倍になり、**`devicePixelRatio` を考慮していなかった変更前と
同じ内部解像度のまま**でした。所有者の実機の症状（`VK_ERROR_DEVICE_LOST`、
GPU のハング）に対する本命の対策（1フレームの GPU 負荷を減らす）が、
既定値では何も効いていなかったことになります。`devicePixelRatio` を式から
外し、「表示サイズ × レンダースケール」だけにすることで解決しました。

## 測り方の誤り(2回)

### 判断表の基準を1億点に置いた

[ADR-0006](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0006-conversion-strategy.md) の M4-1 スパイクは「1億点が10分以内・8GB以内なら自前実装で進める」
という判断表を作りましたが、**実際に所有者が扱うデータは sofi が3.64億点
（見込み約22GB）**でした。1億点の基準をクリアしても、実データでは破綻する
規模です。判断表を作った時点で「このプロジェクトの前提は数億点で破綻しないこと」
という大前提を基準に反映し損ねていたことが、追加の実測（M4-1b）で発覚しました。

### ピークメモリをワーキングセットで測った

`copc-writer` は一時ファイルを `memmap2` でメモリマップして読みます。
ワーキングセット（物理メモリに載っているページの総量）で測ると、ファイルに
裏付けられたページも含まれてしまい、**メモリが足りなくなれば OS が捨てて
読み直せるページ**まで「使用中のメモリ」として数えてしまいます。これは
メモリ不足で落ちるかどうかの指標になりません。指標を**プライベートメモリ**
（ファイルに裏付けられていないメモリ）に正したところ、sofi の変換は
ワーキングセット 17.3GiB に対しプライベートメモリは**0.053GiB**でした。
詳細は [ADR-0006](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0006-conversion-strategy.md) の「『ピークメモリ』を測り直した理由」を参照してください。

**この教訓はもう一度、別の形で現れています。** Web 版の `OpfsScratchFs` は
OPFS にメモリマップ相当の API が無いため一時ファイルを `Vec<u8>` へ丸ごと
読み込む実装にせざるを得ず、数千万点の入力で wasm のメモリ上限を超えて
`unreachable` で止まる不具合になりました（[vendor/copc-writer の章](./rust/copc-writer.md)参照）。
「出力ファイルがバイト単位で一致すること」だけを確認基準にしており、
**読み込み中にどれだけのメモリを同時に保持するか**という別の軸は、
出力の正しさを確認しただけでは見つけられませんでした。

### エージェントの計測値は再現しないことがある

M4-1b では、ある環境での計測値（beer.laz: 46.27秒、sofi: 553.81秒）が、
別の環境での再計測で約2〜4倍遅い結果（190.0秒、1,079.3秒）になりました。
原因は特定されていません。**判断に使う数値は、できれば複数回・複数環境で
再実行して確かめること**、そして「原因不明の食い違いがあった」こと自体を
正直に記録することが、このプロジェクトの一貫した態度です。

## もう1つの教訓: 診断の仮説を検証せずに次へ進まない

[ADR-0007](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0007-pcv-protocol-concurrency.md) は「`pcv://` の並行リクエストが並行数を上げてもスループットが
頭打ちになる」ことを実測し、`CopcPool` によるプール化で解決しました。
この対処自体は正しく効きましたが、後になって所有者から「早くなったが、
まだ遅い」という報告があり、**並行化そのものではなく「1ノードあたりの
読み出しコストが単スレッドで88ms」という、そもそも疑っていなかった部分が
真因だった**ことが分かりました（[vendor/copc-reader の章](./rust/copc-reader.md)参照）。

**教訓**: 「並行数を上げたら速くなった」という観測は、並行化が効いている
ことの証拠にはなりますが、「1リクエストのコスト自体が適正か」という
別の軸を自動的には検証しません。計測の対象を広く振っただけで、
疑うべき軸を絞り込んだつもりにならないことです。

## まず読むファイル

- [`TaskSheets/HANDOFF.md`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/HANDOFF.md) の「繰り返し踏んだ落とし穴」節
- [`TaskSheets/ADR-0010-lod-priority-and-point-budget.md`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0010-lod-priority-and-point-budget.md) — ラチェットの教訓が最も詳しく記録されている ADR
