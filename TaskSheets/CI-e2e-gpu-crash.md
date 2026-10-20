# CI E2E の「Target crashed」: 調査と対処

## 症状

- CI の `e2e` ジョブで、変換系のスペックが Playwright の `Target crashed` で落ちる。
  失敗 run: 39511464687（コミット 345273d、docs のみ）。ほかに 39109955915, 39108093025, 39107288859, 39105961829, 39105062326。
  docs だけのコミットでも落ちるので、コードの退行ではない。2026-10-18 06:40 UTC ごろより前は約30回連続で通っていた（`retries: 1`、少なくとも1回は既に flaky）。
- `DEBUG=pw:browser`（d4e9e9f で追加）の Chromium の stderr では、クラッシュの直前に GPU プロセスで次が出る。
  `shared_image_factory.cc: Could not find SharedImageBackingFactory with params: usage: ...|WebgpuSwapChainTexture|..., format: RGBA_8888 ... size: 1280x720`
  → `SharedImageStub: Unable to create shared image` → `Received signal 6`（abort）。
- OOM ではない（dmesg に OOM なし、空きメモリ約14GB）。ランナーは 4 vCPU AMD EPYC 7763。イメージ 20261012.601 と 20261015.610 の両方で発生。
  通った run 39110573978 でも3回 abort があり、リトライで隠れていた。

## コーディネーターの診断（実験前）

GPU プロセスが、ヘッドレス Chromium（`channel: "chromium"`）の SwiftShader 上で WebGPU の canvas スワップチェーンを作るときに abort する。
仮説（未検証だった）: (H1) 並列ブラウザによる共有イメージ選択の競合、(H2) GPU バックエンドの選択（SwiftShader を Vulkan/ANGLE で明示、または旧 headless shell）で回避できる。

## 実験の設計

- 一時ブランチ `e2e-crash-experiment` に、そのブランチへの push だけで動く一時ワークフローを置いた（main には入れていない。実験後にブランチごと削除）。
- 各バリアントで既存の E2E 6本を `--repeat-each=5 --retries=0`（= 30 実行）で走らせ、`DEBUG=pw:browser` のログから
  `Received signal 6` の数と失敗数を数えた。`SharedImageBackingFactory` の行も数えた。V3 では 0 行、それ以外のバリアントでは毎回ちょうど 30 行だった（abort の回数と一致しないので、1回の abort あたりの行数は一定ではなく、理由は調べていない）。判定は signal 6 と失敗数で行う。
- ランナーは ubuntu-latest。1バリアント = 1ジョブ。

## 結果

実行数は各 30。「abort」は `Received signal 6` の数、「失敗」は失敗したテスト数（いずれのクラッシュも `Target crashed`）。

### 第1ラウンド（2回: run 39512374110 / 39512415707）

| バリアント | 内容 | 1回目 abort / 失敗 | 2回目 abort / 失敗 |
|---|---|---|---|
| V0 | 現行設定 | 6 / 6 | 13 / 13 |
| V1 | `workers: 1` | 2 / 2 | 4 / 4 |
| V2 | 旧 headless shell（`channel` 無し） | 5 / 5 | 14 / 14 |
| V3 | `--enable-features=Vulkan --use-vulkan=swiftshader --use-angle=swiftshader --use-webgpu-adapter=swiftshader` | **0 / 0** | **0 / 0** |
| V4 | `--disable-gpu-compositing` | 12 / 12 | 6 / 6 |

### 第2ラウンド: V3 のフラグの絞り込み（run 39512902436）

| バリアント | 内容 | abort / 失敗 |
|---|---|---|
| V5 | `--use-webgpu-adapter=swiftshader` のみ | 11 / 11 |
| V6 | `--enable-features=Vulkan --use-vulkan=swiftshader` のみ | 17 / 17 |
| V7 | `--use-angle=swiftshader` のみ | 2 / 2 |
| V3（再） | 4 フラグすべて | **0 / 0** |

V3 は計 90 実行（3 run）で abort 0・失敗 0。V3 の所要時間は 2.2〜3.1 分で、他（1.2〜2.3 分）より長い。

## 採用した修正

`playwright.config.ts` で、Linux のときだけ V3 の 4 フラグを `--enable-unsafe-webgpu` に足す。リトライ回数は変えていない。
テストは従来どおり WebGPU で描画まで通る（V3 の 90 実行はすべて通過）ので、「CI が緑でもブラウザでは壊れている」を検出する目的（ADR-0016）は保たれる。
診断ステップ（d4e9e9f）は残した。

Windows には入れない: ADR-0016 に、`--use-angle=swiftshader` が Windows では `requestAdapter()` を `null` にする組み合わせがあったと記録されているため（今回 Windows では実行していない）。

## 採らなかったもの

- V1（workers 1）: abort が減るだけで 0 にならない（2, 4）。並列が唯一の原因ではない。
- V2（旧 headless shell）: 悪化（5, 14）。ADR-0016 のとおり WebGPU の検証にもならない。
- V4（`--disable-gpu-compositing`）: 効果なし（12, 6）。
- V5 / V6 / V7 の単独フラグ: 0 にならない。4 つ揃って初めて 0 だった（どれが必須かの組合せ全探索はしていない）。
- リトライ回数を増やす: 原因を隠すだけなので採らない。

## 未検証

- なぜ V3 で直るかの Chromium 内部の機序（H2 の方向と整合するが、機序は示していない）。V3 の4フラグのうち最小の部分集合も未確認（V5〜V7 の単独のみ測定）。
- 0 / 90 は「確率が大きく下がった」ことの強い証拠だが、0 の保証ではない。V0 でも run によって 6 と 13 でばらつく。
- Chromium / Playwright のバージョンが上がったときに、この回避策が不要・有害にならないか。
- ローカル（Windows）の E2E は今回走らせていない（フラグを Linux 限定にしたため挙動は変わらないはず）。
- 修正を入れた main の CI の結果は、このファイル作成時点では未確認。

## 確認手順

`gh run list --workflow=CI --branch=main` で `e2e` ジョブが続けて緑になるか、`DEBUG=pw:browser` のログに `Received signal 6` が出ないかを見る。
