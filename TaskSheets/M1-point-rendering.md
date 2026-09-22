# M1: 点群が画面に出る

- 状態: 進行中（M1-1, M1-2 完了）
- 前提: [ADR-0001](./ADR-0001-architecture.md), [ADR-0002](./ADR-0002-rendering-api.md), [M0](./M0-feasibility.md) 完了

## このマイルストーンの目的

**COPC ファイルを開いて、点が画面に出て、動かしても破綻しない状態**まで持っていく。

M0 の計画では M1 に EDL とカラーマップも含めていたが、**1マイルストーンが大きすぎて差分を
追えなくなるため、そこは M2 に送る**。M1 は「点が正しく見える」だけに絞る。

## M0 から引き継いだ設計予算

M0-3 の実測で `pcv://` のスループットは **92.7MB/s**。後述のノード形式（1点20バイト）では
**毎秒約 4.6M 点**が上限になる。点予算を 3M 点とすると、可視ノードを総入れ替えするのに
約 0.65 秒かかる。したがって M1 の LOD は以下を満たす必要がある。

- ノードは **1〜2MB 単位**に刻む（粗くすると1ノードの到着待ちで画面が固まる）
- **画面空間誤差**でノードに優先度を付け、粗いものから順に埋める
- 一度読んだノードは**キャッシュして再取得しない**

なお Web 版では HTTP 帯域がこれより細くなるため、この予算で設計しておけば Web でも成立する。
**デスクトップ側がボトルネックになることはない。**

---

## M1-1: COPC を読む（`pcv-core`）

### やること

`crates/pcv-core` に COPC リーダーを実装する。

**クレートを選定する。** 候補は2つ:

| 候補 | 備考 |
|---|---|
| `copc-rs` 0.5.0 | reader + **writer**。writer があるとテスト用の極小 COPC をコードで生成でき、fixture を public リポジトリにコミットせずに済む |
| `copc-core` 0.9.0 | 新しい。hierarchy / streaming point 型を提供 |

**選定の決め手は規約1**（ARCHITECTURE.md）:
**`pcv-core` が `wasm32-unknown-unknown` でビルドできること。** これが Web 版のバックエンドが
成立する条件なので、ここを満たさない候補は落とす。`std::fs` を直接要求せず
`Read + Seek` のジェネリクスで受けている実装が望ましい。

実際に両方を試し、**選んだ理由と落とした理由を ADR-0003 に記録すること。**

### 公開する API の形

```rust
// 中身は選定したクレートに委ねてよいが、pcv-core の外向きAPIはこの形に寄せる
pub struct CopcFile { /* ... */ }

impl CopcFile {
    pub fn open(path: &Path) -> Result<Self>;
    pub fn info(&self) -> &CloudInfo;              // 点数, BBOX, scale/offset, 属性の有無
    pub fn hierarchy(&self) -> &Hierarchy;         // octree ノードキーと各ノードの点数
    pub fn read_node(&mut self, key: NodeKey) -> Result<NodeBuffer>;  // M1-2 の形式で返す
}
```

### 受け入れ条件

- [x] COPC ファイルを開き、総点数・BBOX・octree のノード数が取れる
      （`crates/pcv-core/src/copc.rs` の `open_reports_total_point_count_and_bbox` で確認。
      copc-writerで生成した2000点の合成COPCを開き、`info().point_count`・`min`/`max`・
      `hierarchy().len()` を検証している）
- [x] 任意のノードキーを指定して点を読み出せ、点数がヒエラルキの申告と一致する
      （`read_node_point_count_matches_hierarchy` で、hierarchy内の全ノードを走査し
      `read_node(key)` の返す点数が `hierarchy().get(key).point_count` と一致することを確認。
      当初は境界面が接するノード間で1点だけ混入する不具合があり、`point_belongs_to_key`で
      修正した。詳細はADR-0003参照）
- [x] `cargo build -p pcv-core --target wasm32-unknown-unknown` が通る（**規約1**）
      （ローカルで実行し成功を確認。copc-core/copc-reader両方を実装に組み込んだ後の実測）
- [x] `cargo test -p pcv-core` にテストがあり、CI で走る
      （10個のユニットテストを追加。ローカルの `cargo test --workspace` で全てpassすることを
      確認。CIでの実行結果はpush後にGitHub Actionsのrunで確認する）
- [x] ADR-0003 にクレート選定の理由が記録されている（`TaskSheets/ADR-0003-copc-crate.md`）

### テストデータの扱い

`.gitignore` で `*.laz` を除外しているのは、点群ファイルが大きいため。**この方針は変えない。**
テストは以下のどちらかで行う:

1. `copc-rs` の writer で**テスト内に極小 COPC を生成する**（推奨。リポジトリが太らない）
2. それが無理なら 1MB 未満の fixture を `crates/pcv-core/tests/fixtures/` に置き、
   `.gitignore` にそのパスだけ例外を足す

CI がネットワークから点群をダウンロードする構成にはしないこと（不安定になる）。

### コミット単位

`feat(core): add copc reader` / `docs: record copc crate choice (ADR-0003)`

---

## M1-2: ノードのバイナリ形式を決めて `pcv://` で配信

### やること

Rust からレンダラへ渡すノードの**バイナリレイアウトを確定させ**、`pcv://` で配信する。
これは Rust と TypeScript の間の唯一の重いインターフェースなので、ここで固める。

### ノードのバイナリ形式（決定）

ヘッダ（固定長）＋インターリーブされた点配列。**GPU の頂点バッファにそのまま流し込める形**にする。

```
[ヘッダ 32 bytes ]
  u32   magic        "PCVN"
  u32   version      1
  u32   point_count
  u32   stride       20
  f32   origin_x     ノードローカル座標の原点（世界座標、f32 で足りる粒度に丸めた値）
  f32   origin_y
  f32   origin_z
  u32   flags        どの属性が有効か（color / intensity / classification）

[ 点配列 point_count × 20 bytes ]
  f32 x3   position       ← ノードローカル相対座標
  u8  x4   color RGBA
  u16      intensity
  u8       classification
  u8       _padding
```

### なぜノードローカル相対座標にするのか（重要）

COPC の座標は f64 の世界座標で、実測データは UTM 系などで **X=500000.123 のような大きな値**を
取る。これを素朴に f32 に落とすと仮数部が足りず、**mm 〜 cm 単位の精度が消えて点群が
グリッド状にガタつく**（点群ビューアの古典的な失敗）。

そこでノードごとに原点を持たせ、点は**その原点からの相対座標**を f32 で持つ。
原点は uniform でシェーダに渡し、ビュー行列側で吸収する。これで f32 のまま精度が保たれる。

f64 を GPU に送る案は採らない。WebGPU に f64 は無い。

### 受け入れ条件

- [x] `pcv://` でノードを要求すると上記形式のバイナリが返る
      （`src-tauri/src/copc_state.rs` のテストに加え、M1-3で実際に `npm run tauri dev` を
      起動し webview から `fetch(convertFileSrc("0-0-0-0", "pcv"))` が動くことを確認した。
      Rust側stdoutに `[pcv] served node 0-0-0-0: 20000 points, 400032 bytes` が出た）
- [x] フロント側にパーサがあり、ヘッダの `magic` / `version` を検証して弾ける
      （`src/datasource/node-format.ts` の `parseNodeBuffer`。`npx tsx` で
      正常系・magic不正・version不正・バイト長不一致の4パターンを手動実行して確認した）
- [x] 読み出した点数がヘッダの `point_count` と一致する
      （Rust側は`read_node_bytes_matches_m1_2_wire_format`でバイト長を検証、
      フロント側は`parseNodeBuffer`が`buffer.byteLength`とヘッダの`point_count`から
      逆算した期待バイト数を突き合わせて検証する）
- [x] `DataSource` インターフェース（M0-3 で作った形）に `readNode(key)` が生えている
      （`src/datasource/DataSource.ts`。`TauriSource`が実装）
- [x] Tauri の API を import しているファイルが `src/datasource/tauri.ts` のままであること（**規約2**）
      （`grep -rl "@tauri-apps/api" src/` で確認）

### M0 で判明している落とし穴（そのまま効く）

- `convertFileSrc` はパス全体を1セグメントとして `encodeURIComponent` するため、
  `/node/<key>` のような**複数セグメントのパスは使えない**。ノードキーは1セグメントに
  エンコードすること（例: `pcv://0-0-0-0`）
- devURL と `pcv://` はオリジンが異なるため `Access-Control-Allow-Origin` ヘッダが要る

### コミット単位

`feat: define node binary format` / `feat: serve copc nodes over pcv://`

---

## M1-3: 1ノードを WebGPU で描画する

### やること

`src/renderer/` に点群描画パイプラインを作り、**まず1ノードだけ**を出す。LOD はまだ入れない。

- WebGPU の point sprite パイプライン（頂点シェーダで四角形を展開、フラグメントで円形に抜く）
- 点サイズは画面空間で一定（距離で小さくならない固定サイズから始める）
- orbit カメラ（左ドラッグで回転、ホイールでズーム、中ドラッグでパン）
- 深度バッファ有効

**規約3を守ること:** `src/renderer/` は React を import しない。canvas と `DataSource` だけを
受け取る。UI から触るときは `src/state/` を経由する。

### 受け入れ条件

- [x] COPC を1つ開き、ルートノードの点が画面に出る
      （`npm run tauri dev` を実際に起動し、20万点の合成COPC(copc-writerで生成)を
      一時的に自動オープンするコード〈確認後に削除〉で確認した。Rust側stdoutに
      `[pcv] served node 0-0-0-0: 20000 points, 400032 bytes` と
      `[frontend] [M1] opened ...: points=200000 nodes=41 rootPoints=20000` が出た）
- [ ] カメラを回しても点群が歪まない・ジッタしない（M1-2 の相対座標が効いていることの確認）
      未検証。マウス操作でのカメラ回転はGUIを目視できないと確認できない。
      相対座標のロジック自体はpcv-core側のテスト
      （`root_node_positions_are_small_relative_to_large_world_coordinates`）で
      検証済みだが、「実際に画面でガタつかないか」は所有者の目視確認が必要
- [ ] 点が円形に描かれ、手前の点が奥の点を隠す（深度が効いている）
      フラグメントシェーダのdiscardと depth24plus の depthWriteEnabled/depthCompare は
      実装したが、実際に円形に見えるか・奥行きが正しいかはGUIを目視できないため未検証
- [ ] ウィンドウをリサイズしてもアスペクト比が崩れない
      resize()でdepthテクスチャとcanvas幅高を再生成する実装はしたが、
      実際の見た目はGUIを目視できないため未検証

### 自分で確かめる手順

```bash
npm run tauri dev
# COPC を開き、回して・寄って・引いてみる。
# 特に「遠くから寄ったときに点がガタつかないか」を見る（相対座標の検証）
```

### コミット単位

`feat(renderer): add point sprite pipeline` / `feat(renderer): add orbit camera`

---

## M1-4: octree LOD と点予算

### やること

可視ノードを octree から選び、点予算の範囲で漸進的に精度を上げる。**M1 の本体。**

1. **画面空間誤差でノードに優先度を付ける** — ノードの BBOX を投影し、画面上の大きさ ÷
   そのノードの点密度から誤差を出す。大きいものほど優先
2. **視錐台カリング** — 画面外のノードは候補から外す
3. **点予算** — 合計点数が予算（デフォルト 3M、UI から変更可）を超えたら、優先度の低い
   ノードから捨てる
4. **ノードキャッシュ** — 一度読んだノードは LRU で保持し、再取得しない。
   GPU バッファも合わせて解放する
5. **非同期ロード** — 優先度順にキューイングし、同時リクエスト数を絞る（4本程度）。
   カメラが動いたらキューを組み替える

### 受け入れ条件

- [ ] 大きい COPC（1000万点以上）を開いても即座に粗い全体像が出る
      1000万点規模のファイルではまだ検証していない（`npm run tauri dev` を目視できない
      環境のため用意していない）。copc-writerで生成した20万点・41ノードの合成COPCでは、
      ルート・レベル1（各2万点）が最初にロードされ、レベル2（数百点/ノード）が後から
      埋まっていくことをRust側stdoutのログ順序で確認した（画面空間誤差による優先度付け
      が機能している）。1000万点規模での「即座に」という体感速度は所有者の目視確認が必要
- [x] 静止していると精度が段階的に上がり、やがて止まる
      （上記の合成COPCで、drawnNodesが8→28→32→36→40→41と段階的に増え、
      `drawnPoints=200000 drawnNodes=41 loadingNodes=0 queuedNodes=0` で安定することを
      `npm run tauri dev` のRust側stdoutログで確認した）
- [ ] 動かしている間もフレームが落ちない（点予算が効いている）
      非同期ロード中もfpsが58〜60を維持することは確認したが、これは**静止した状態での**
      確認。マウスでカメラを実際に動かしながらのfps計測はGUIを目視・操作できないため未検証
- [x] 点予算を UI から変えると、描画点数が実際に追従する
      （点予算を3,000,000→30,000に変更した直後、`drawnPoints`が200000から29959へ
      即座に減り、以後そこで安定することをログで確認した）
- [ ] 同じ場所に戻ったとき再ロードが走らない（キャッシュが効いている）
      「視点を動かして戻す」という操作自体はGUIを目視・操作できないため試せていない。
      間接的な確認として、視点を静止させた定常状態で `loadingNodes=0 queuedNodes=0` が
      何十フレームも継続し、キャッシュ済みノードへの余計な再リクエストが起きないことは
      確認した
- [x] 描画点数・ロード中ノード数・fps が画面に出ている（**これが無いと挙動を追えない**）
      `ViewerPanel.tsx` に統計表示を実装し、`useCopcViewer.ts` が
      `report_diagnostic` 経由でRust側stdoutにも同じ内容を出す
      （`[M1] drawnPoints=... drawnNodes=... loadingNodes=... queuedNodes=... cachedNodes=... fps=... pointBudget=...`）。
      画面上のオーバーレイに実際に表示されているかの目視確認は所有者に委ねる

### 自分で確かめる手順

```bash
npm run tauri dev
# 1. 大きい COPC を開く → 粗い全体像がすぐ出るか
# 2. じっとする → 精度が上がって止まるか
# 3. 速く動かす → fps が落ちないか、点予算を超えないか
# 4. 元の視点に戻る → 再ロードが走らないか（統計表示で確認）
```

### 検証中に気づいた挙動（要注意）

`npm run tauri dev` を開発モードで動かして確認したところ、ノードの読み込みが
**数十秒単位で止まって見えることがある**（`loadingNodes=4` のまま `queuedNodes` も
減らない状態が続き、その後まとめて進む）。fps は常に58〜60を維持しており、
`[pcv] served node ...` のエラーログも出ないため、描画パイプラインやLODの
選択ロジック自体の不具合ではなく、`pcv://` カスタムプロトコルへの並行リクエストが
開発サーバ（Vite）やWebView2のネットワークスタック側で一時的に詰まっている
（devビルド・大量の小さいリクエスト特有の現象）可能性が高いと見ている。
`cargo build --release` でのビルドや、実運用に近いノードサイズ（1〜2MB、
M1-point-rendering.mdの設計予算どおり）ではこの現象が再現するか未確認。
所有者が実機で気になる遅延を感じたら、まずこの点を疑ってほしい。

### コミット単位

`feat: add screen-space error node selection` / `feat: add point budget and lru cache`
/ `feat: show render statistics`

---

## M1 完了の定義

- [ ] M1-1 〜 M1-4 がすべて完了している
      M1-1・M1-2は完了。M1-3・M1-4は実装は完了し主要な受け入れ条件を実測で確認したが、
      「実際に画面がガタつかずに見えるか」「マウス操作でのカメラ回転」「1000万点規模での
      体感速度」はGUIを目視・操作できないため未検証（各セクションに詳細を記載）
- [ ] 1000万点以上の COPC を開いて、滑らかに見回せる
      未検証。1000万点規模のfixtureを用意しての確認、および「滑らかに見回せるか」の
      目視確認は所有者に委ねる
- [x] `cargo build -p pcv-core --target wasm32-unknown-unknown` が通る（規約1 が生きている）
- [x] `@tauri-apps/api` を import しているファイルが `src/datasource/tauri.ts` だけ（規約2 が生きている）
- [x] CI が緑（実装の各段階でpushしてGitHub Actions上のrunがsuccessであることを確認した）
- [x] `ARCHITECTURE.md` の「現在の状態」表とデータフロー図が更新されている

## M2 に送ったもの

- EDL（Eye-Dome Lighting）シェーディング
- カラーマップ切替（RGB / 強度 / 標高 / 分類）
- 属性パネル・ヒストグラム
