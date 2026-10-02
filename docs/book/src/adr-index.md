# 設計判断の索引(ADR)

ADR（Architecture Decision Record、設計判断の記録）は、**なぜ**その設計に
なったかの一次資料です。この本の各章は「何をしているか」を中心に書いていますが、
「なぜ」を知りたくなったら、ここから該当の ADR に飛んでください。

| ADR | 内容 | 一言で |
|---|---|---|
| [ADR-0001](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0001-architecture.md) | 全体アーキテクチャ | Tauri + React + WebGPU + COPC。Bevy は使わない。解析ツールは UI の比重が大きい |
| [ADR-0002](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0002-rendering-api.md) | 描画 API | WebGPU のみ採用。WebGL2 フォールバックは実装しない |
| [ADR-0003](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0003-copc-crate.md) | COPC を読むクレート | `copc-core`/`copc-reader` を採用し `vendor/` で修正。大規模 COPC を開けない欠陥と、1ノード読み出しが遅かった根本原因を記録 |
| [ADR-0004](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0004-distribution-and-update.md) | 配布と更新 | GitHub Releases。**署名鍵は当面作らない**という追記で自動更新の方針が変わった |
| [ADR-0005](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0005-ui-shell.md) | UI の骨組み | 全面ビューア + 浮いたガラス面。設定画面だけ不透明 |
| [ADR-0006](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0006-conversion-strategy.md) | LAS/LAZ → COPC の変換 | `copc-writer` を採用。実測で決め、「ピークメモリ」の測り方自体を途中で正した経緯も記録 |
| [ADR-0007](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0007-pcv-protocol-concurrency.md) | `pcv://` と並行読み込み | 並行化だけでは直らず、1ノードの読み方自体が遅かったことが真因だった、という教訓が核心 |
| [ADR-0008](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0008-formats-and-crs.md) | 形式と座標参照系 | E57/PLY/PCD に対応。PROJ は使わず横メルカトルを自前実装（規約1を守るため） |
| [ADR-0009](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0009-adaptive-render-settings.md) | 端末に合わせた描画設定 | 静的情報は初期値と上限だけに使い、実際の調整はフレーム時間の閉ループで行う |
| [ADR-0010](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0010-lod-priority-and-point-budget.md) | LOD の優先度と点予算 | 優先度の式の次元の誤りと、点予算自動調整が2種類のラチェットに陥った経緯 |
| [ADR-0011](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0011-gpu-error-visibility.md) | WebGPU のエラーを画面に | 「すべて緑なのに画面が真っ黒」という事故から、エラーを握りつぶさない仕組みを作った |
| [ADR-0012](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0012-web-worker-sync-io.md) | Web 版の読み込み | Web Worker の中で同期 I/O を使い、`pcv-core` をそのまま動かす |
| [ADR-0013](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ADR-0013-crash-visibility.md) | Android で落ちたときの原因の可視化 | `panic = "unwind"` に変え、panic をログと画面のバナーに出す |

## 各 ADR の構成

どの ADR も同じ構成（決定 / 背景 / 帰結 / 却下した案）で書かれています。
特に「却下した案」節には、採用しなかった選択肢とその理由が残っており、
**同じ議論を繰り返さないための記録**になっています。

ADR のうちいくつかは、最初の決定が実機での発見によって追記・訂正されています。
これは ADR が「一度書いたら終わり」の文書ではなく、**実測・実機で裏切られた
前提をそのつど正す**運用になっていることを示しています。代表例は
ADR-0003（大規模 COPC を開けない欠陥）、ADR-0007（並行化だけでは直らなかった）、
ADR-0010（点予算の自動調整が2回ラチェットに陥った）です。

## タスクシートとの関係

ADR が「なぜ」を記録するのに対し、`TaskSheets/M0`〜`M4` の各タスクシートは
「何を、どう実装し、何を確認したか」という作業記録です。本書の各章は
主に ADR とコードを突き合わせて書いていますが、実機確認の有無や実測値の
詳細はタスクシート側にしかないことが多いので、気になる箇所は該当する
マイルストーンのタスクシートも参照してください。

- [`M0-feasibility.md`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/M0-feasibility.md) — 前提の確定（WebGPU 可否、IPC スループット、CI）
- [`M1-point-rendering.md`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/M1-point-rendering.md) — 点群が画面に出るまで
- [`M2-shading-and-ui.md`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/M2-shading-and-ui.md) — EDL・カラーマップ・UI シェル
- [`M3-release-and-update.md`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/M3-release-and-update.md) — リリース配布と実機対応
- [`M4-import-and-conversion.md`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/M4-import-and-conversion.md) — 各種形式の取り込みと変換、CRS

## まず読むファイル

- [`TaskSheets/HANDOFF.md`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/HANDOFF.md) — 今どこまで終わっていて、何が未確認かの最新状況
- [`TaskSheets/ARCHITECTURE.md`](https://github.com/dOtOb9/point-cloud-viewer/blob/main/TaskSheets/ARCHITECTURE.md) — 常に最新のディレクトリ構成・現在の状態表
