# ADR-0023: TS 側の機能はプラグインとして分け、後から第三者の機能を足せるようにする

- 状態: 採択（所有者の依頼 2026-11-16「Unreal Engine の Plugin のように、TS 側の機能をすべて Plugin として分離し、3rd Party の機能を入れる余地を作れるか。可能なら作業に追加」。
  可能と判断し、設計の細部はコーディネーターが決めた。**外部のプラグインを読み込む機能（PL-9）を有効にする前に、所有者に安全面の判断を聞く**）
- 日付: 2026-11-16
- 関係: [ADR-0022](./ADR-0022-tea-architecture.md)（各プラグインは TEA の1プログラム）、[ADR-0018](./ADR-0018-layer-centric-operations.md)、
  REVIEW の A-1（ツールが `DataSource` に入っていない）・A-3（層の規約の抜け穴）

## 可能か

可能。今の機能（計測・断面・選択・結合・ラスタ・間引き・フィルタ・DTM・視点）は、どれも「リボンのボタン → ダイアログ → 長い処理（`DataSource` 経由） → 新しいレイヤー／計測レイヤー」
という同じ形をしている。違いは配線が `Toolbar.tsx`・`AppShell.tsx`・`useCopcViewer.ts`・`src/app/*` に**機能ごとに手で書かれている**ことだけ。
この配線を「ホストが差し出す API」と「プラグインが登録する物」に分ければよい。WebGPU のレンダラ・データの読み込み（Rust/wasm）・レイヤーの一覧・殻（リボン・ダイアログの枠・ステータスバー）は**コア**として残す。

## 決定

### 形

```
src/plugin-api/      プラグインが import してよい唯一のコアの入口（型と小さな関数だけ。apiVersion を持つ）
src/plugins/<id>/    1プラグイン = 1フォルダ。index.ts（定義）・model.ts（TEA の Model/Msg/update）・effects.ts・view/*.tsx・*.test.ts
src/plugins/builtin.ts  組み込みプラグインの一覧（静的な import の配列。並び順がリボンの順）
src/core/plugin-host.ts ホストの実装（コア側。プラグインに API を渡し、登録された物を殻に並べる）
```

```ts
export interface PcvPlugin {
  id: string;                 // "pcv.view"、第三者は "vendor.name"
  name: string;               // 画面に出す名前（日本語）
  apiVersion: 1;
  activate(host: PluginHost): void | (() => void);   // 戻り値は後片付け
}

export interface PluginHost {
  ribbon: { add(item: RibbonItem): void };                 // アイコン＋名前、グループ、enabled の条件、onClick
  dialogs: { open(render: DialogRender): DialogHandle };   // 既存の Dialog の枠（中央・side）に中身を描く
  status: { add(item: StatusItem): void };                 // ステータスバーの項目（UX-1）
  shortcuts: { add(key: string, label: string, run: () => void): void };  // 入力欄では反応しない判定はホストが持つ
  layers: LayerApi;          // 一覧・選択の購読、新しいレイヤーを足す（ADR-0018: 元は書き換えない）
  tools: ToolApi;            // 長い処理（DataSource のツール、RF-2 の後）。進捗・中止のダイアログはホストが出す
  view: ViewApi;             // カメラ・投影・ピック・2D の重ね描き（ワールド→画面の変換を渡す）・表示の範囲
  units: UnitsApi;           // 表示単位（m / ft）と換算
  errors: { report(source: string, error: unknown): void };  // ADR-0011 のバナーとログ
  settings: SettingsApi;     // プラグインごとに名前空間を分けた保存（localStorage、try/catch はホストが持つ）
  program<Model, Msg>(init: Model, update: Update<Model, Msg>): Program<Model, Msg>;  // ADR-0022
}
```

### 決まり

- **組み込みの機能もすべて同じ API で書く。** 組み込みだけが使える裏口を作らない（第三者が同じことをできる証明になる）。
  API が足りなければ API を足す。足した API には `src/plugin-api/` にテストと説明を置く
- `src/plugins/**` が import してよいのは `src/plugin-api`・自分のフォルダ・`react`・`lucide-react`・`src/ui/kit`（ボタン・数値入力・単位つき入力欄など、見た目の部品だけ）。
  ESLint の `no-restricted-imports` で検査する（RF-1 の仕組みに足す）
- プラグイン同士は直接 import しない。必要なら API（`layers`・`view` など）を通して話す
- 1つのプラグインの失敗（`activate` の例外、効果の例外、描画の例外）でアプリを落とさない。ホストが受け止めて `errors.report` に流し、そのプラグインだけを止める（React の Error Boundary をプラグインの UI ごとに置く）
- `apiVersion` を上げるのは壊す変更のときだけ。ホストは自分の知らない `apiVersion` のプラグインを読み込まず、理由を表示する
- Rust（`pcv-core` の計算）はプラグインにしない。重い計算が要るプラグインは、ホストの `tools` が差し出す汎用の道（例: 範囲の全点を順に渡す `streamPoints`。メモリは点数に比例させない）を使う。
  専用の Rust が要る機能は組み込みとして Rust を足し、`tools` に1つ口を増やす

### 段階

| ID | 内容 | 前提 |
|---|---|---|
| PL-0 | `src/app/tea.ts`（ADR-0022）・`src/plugin-api/`・`src/core/plugin-host.ts`・`builtin.ts`。リボン・ダイアログ・ステータス・ショートカット・エラー境界。組み込みは空のまま、殻が今と同じに見える | RF-1 |
| PL-1 | 視点（TP-1）を最初のプラグイン `pcv.view` に移す。API が実用になるかの試金石 | PL-0 |
| PL-2 | TP-2（表示範囲）・TP-3（土量）をプラグインとして新しく作る | PL-1、RF-2 |
| PL-3〜8 | 既存の機能を1つずつ移す（計測 → 選択・断面 → 結合 → ラスタ → 間引き・フィルタ → DTM）。`Toolbar.tsx`・`AppShell.tsx`・`useCopcViewer.ts` から機能ごとの配線が消える | PL-1、RF-2 |
| PL-9 | 外部のプラグインの読み込み（Web: URL の ESM を `import()`、デスクトップ: 決まったフォルダ）。**有効にする前に所有者に聞く**（下の「安全」） | PL-3〜8 |

## 安全（PL-9 の前に所有者が判断すること）

外部のプラグインはアプリと同じ権限で動く（ページの中の JavaScript なので、ホストの API を通らずに `fetch` や DOM に触れる）。
最初の段階ではサンドボックスを作らず、「信頼できる物だけを入れる」前提で、読み込む前に警告を出し、既定では無効にする案を推奨する。
iframe や Worker に閉じ込める案は、レンダラや 2D の重ね描きへの API が非同期になり大きく変わるので、必要になってから ADR を起こす。

## 採らなかった案

- **組み込みはそのままで、第三者用の口だけ足す**: 口が実際に使えるかを誰も確かめないまま腐る。組み込みが同じ口を使うことが保証になる
- **Rust の計算もプラグインにする（wasm のプラグイン）**: 所有者の依頼は TS 側。wasm のプラグインは ABI・メモリの上限・デスクトップとの二重化が重く、今は割に合わない
