# 用語集

本書で前提知識なしに読めるよう、頻出する用語をまとめます。初出の章にもリンクを
置いていますが、迷ったらここに戻ってきてください。

## COPC（Cloud Optimized Point Cloud）

LAZ（圧縮 LAS）の内部に octree を埋め込んだ点群ファイル形式。HTTP Range
リクエストによる部分取得を前提に設計されており、サーバー側のロジック無しで
一部分だけを取得できます。このアプリの内部形式です。→ [データの流れ](./data-flow.md#copc-とは何か)

## LAS / LAZ

LAS は点群データの標準的なファイル形式（拡張子 `.las`）。LAZ はその圧縮版
（拡張子 `.laz`）です。COPC は LAZ の一種（内部に octree を持つ LAZ）です。

## octree（八分木）

3次元空間を再帰的に8つの直方体（立方体）に分割していく木構造。COPC は
点群をこの構造で空間分割し、粗いレベルから詳細なレベルへ段階的に読み込める
ようにしています。

## hierarchy（ヒエラルキ）

COPC ファイルの中に格納された、octree の各ノードの位置・点数などの一覧。
COPC ファイルを開くとき、点データ本体を読まずにまずこれだけを読みます。
→ [データの流れ](./data-flow.md#hierarchy-とノード)

## ノード（node）

octree の1つの区画。点群データはノード単位（COPC では1ノード=1 LAZ チャンク）
で保存され、このアプリでも読み込み・キャッシュ・GPU への転送の単位になります。
`(level, x, y, z)` の4整数で識別され、`"0-0-0-0"` のような文字列にもなります。
→ [データの流れ](./data-flow.md#hierarchy-とノード)

## 点予算（point budget）

1フレームに描画する点の総数の上限。LOD（詳細度）を調整する主要な手段で、
画面空間誤差の高いノードから優先的にこの予算の中に収めます。フレーム時間の
閉ループで自動調整されます。→ [renderer の章](./frontend/renderer.md#点予算の自動調整-point-budgetts)

## 画面空間誤差（screen space error）

あるノードが「どれだけ粗く見えているか」を表す数値。点間隔（ノード内の点と
点の間隔、長さの次元）に、そのノード位置での画面上の投影スケール（ピクセル/
ワールド単位）を掛けて求めます。大きいほど優先的にロードされます。
→ [renderer の章](./frontend/renderer.md#どのノードを描くか-node-selectionts)

## EDL（Eye-Dome Lighting）

隣接ピクセルとの深度差から陰影を作り、色を持たない点群でも凹凸構造を
読めるようにするシェーディング手法。Potree が採用しています。本アプリでは
強さを `0.05` に固定しています。→ [renderer の章](./frontend/renderer.md#edl-edlts)

## vsync（垂直同期）

画面のリフレッシュレート（例: 60Hz なら約16.7ms ごと）に合わせて描画を
更新する仕組み。`requestAnimationFrame` のコールバックはこのタイミングに
合わせて呼ばれるため、1フレームがどれだけ速く終わっても、次の vsync までは
待たされます。点予算の自動調整はこの性質（間隔が16.7/33.3/50.0ms のように
量子化される）を信号として利用しています。→ [落とし穴と教訓](./pitfalls.md)

## AIMD（Additive Increase / Multiplicative Decrease）

緩やかに増やし、条件を外したら大きく減らす、という非対称な制御方式。
TCP の輻輳制御で知られる考え方で、本アプリでは点予算の自動調整に使われて
います。→ [renderer の章](./frontend/renderer.md#点予算の自動調整-point-budgetts)

## OPFS（Origin Private File System）

ブラウザが提供する、オリジンごとに隔離されたファイルシステム API。
Web Worker の中では `FileSystemSyncAccessHandle` により同期的な読み書きが
できます。本アプリの Web 版は、生の LAS/LAZ を COPC に変換する際の一時
ファイルの置き場所としてこれを使っています。→ [vendor/copc-writer の章](./rust/copc-writer.md)

## 平面直角座標系

日本で測量に使われる、横メルカトル図法ベースの投影座標系。全国を19の系
（I〜XIX）に分け、系ごとに原点を定めています。本アプリは JGD2000/JGD2011 の
平面直角座標系19系と UTM に対応しています（PROJ は使わず自前実装）。
→ [pcv-core の章](./rust/pcv-core.md#crs-座標参照系)

## ADR（Architecture Decision Record）

設計判断とその理由を記録する文書形式。このリポジトリでは
`TaskSheets/ADR-0001`〜`ADR-0013` として蓄積されています。→ [設計判断の索引](./adr-index.md)

## `pcv://`

デスクトップ・Android 版で、ノードのバイナリデータを運ぶ Tauri のカスタム
プロトコル。`invoke`（通常の IPC）より高速で、点群のような大きいデータの
転送に使われます。→ [データの流れ](./data-flow.md#pcv-プロトコルtauri)

## DataSource

`src/datasource/DataSource.ts` で定義される TypeScript のインターフェース。
Tauri 版（`TauriSource`）と Web 版（`WebSource`）がこれを実装し、レンダラや
UI はこのインターフェースだけを見ます。→ [datasource の章](./frontend/datasource.md)
