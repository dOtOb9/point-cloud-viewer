# M1: 点群が画面に出る

- 状態: 進行中（M1-1 完了）
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

- [ ] `pcv://` でノードを要求すると上記形式のバイナリが返る
- [ ] フロント側にパーサがあり、ヘッダの `magic` / `version` を検証して弾ける
- [ ] 読み出した点数がヘッダの `point_count` と一致する
- [ ] `DataSource` インターフェース（M0-3 で作った形）に `readNode(key)` が生えている
- [ ] Tauri の API を import しているファイルが `src/datasource/tauri.ts` のままであること（**規約2**）

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

- [ ] COPC を1つ開き、ルートノードの点が画面に出る
- [ ] カメラを回しても点群が歪まない・ジッタしない（M1-2 の相対座標が効いていることの確認）
- [ ] 点が円形に描かれ、手前の点が奥の点を隠す（深度が効いている）
- [ ] ウィンドウをリサイズしてもアスペクト比が崩れない

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
- [ ] 静止していると精度が段階的に上がり、やがて止まる
- [ ] 動かしている間もフレームが落ちない（点予算が効いている）
- [ ] 点予算を UI から変えると、描画点数が実際に追従する
- [ ] 同じ場所に戻ったとき再ロードが走らない（キャッシュが効いている）
- [ ] 描画点数・ロード中ノード数・fps が画面に出ている（**これが無いと挙動を追えない**）

### 自分で確かめる手順

```bash
npm run tauri dev
# 1. 大きい COPC を開く → 粗い全体像がすぐ出るか
# 2. じっとする → 精度が上がって止まるか
# 3. 速く動かす → fps が落ちないか、点予算を超えないか
# 4. 元の視点に戻る → 再ロードが走らないか（統計表示で確認）
```

### コミット単位

`feat: add screen-space error node selection` / `feat: add point budget and lru cache`
/ `feat: show render statistics`

---

## M1 完了の定義

- [ ] M1-1 〜 M1-4 がすべて完了している
- [ ] 1000万点以上の COPC を開いて、滑らかに見回せる
- [ ] `cargo build -p pcv-core --target wasm32-unknown-unknown` が通る（規約1 が生きている）
- [ ] `@tauri-apps/api` を import しているファイルが `src/datasource/tauri.ts` だけ（規約2 が生きている）
- [ ] CI が緑
- [ ] `ARCHITECTURE.md` の「現在の状態」表とデータフロー図が更新されている

## M2 に送ったもの

- EDL（Eye-Dome Lighting）シェーディング
- カラーマップ切替（RGB / 強度 / 標高 / 分類）
- 属性パネル・ヒストグラム
