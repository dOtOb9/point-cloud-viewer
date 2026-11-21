# ADR-0023: TS 側の機能はプラグインとして分け、後から第三者の機能を足せるようにする

- 状態: 採択（所有者の依頼 2026-11-16「Unreal Engine の Plugin のように、TS 側の機能をすべて Plugin として分離し、3rd Party の機能を入れる余地を作れるか。可能なら作業に追加」。
  可能と判断し、設計の細部はコーディネーターが決めた。外部のプラグインは所有者の決定（2026-11-16）で「権限が要る処理は利用者に許可を求め、許可は設定から後で編集できる」形で入れる）
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
| PL-9a | 外部のプラグインの実行環境: サンドボックスの iframe、メッセージの API、権限の仲介（下の「外部のプラグインと権限」） | PL-3〜8 |
| PL-9b | 入れる・許可を求める・設定の「プラグイン」ページ（権限の編集・無効化・削除） | PL-9a |

## 外部のプラグインと権限（所有者の決定 2026-11-16）

所有者の決定: 「外部のプラグインも読み込めるようにする。権限が必要な処理は利用者に許可を求める。許可した権限は設定項目から後で編集できる」。

### 閉じ込める（許可を意味のあるものにするため）

ページの中でそのまま動く JavaScript には権限をかけられない（ホストの API を通らずに `fetch`・DOM・`localStorage` に触れる）。
そこで**外部のプラグインは組み込みと同じ場所では動かさない**。

- `sandbox="allow-scripts"`（`allow-same-origin` を付けない）の iframe の中で動かす。オリジンが不透明になるので、アプリの DOM・保存領域・Cookie・Tauri の API に届かない
- iframe の中身は `srcdoc` で作り、`<meta http-equiv="Content-Security-Policy">` で `connect-src` を**許可された接続先だけ**にする（既定は `'none'`）
- ホストとの話は `postMessage` だけ。ホスト側の仲介（`src/core/plugin-broker.ts`）が、メッセージごとに権限を確かめてから API を呼ぶ。API は非同期の RPC になる
- プラグインの画面（ダイアログの中身）は iframe の中で描き、ホストはその iframe を既存の Dialog の枠に入れる。リボン・ステータス・ショートカットは宣言（名前・アイコン名・キー）で登録し、ホストが描く
- 2D の重ね描きは「点・線・文字のリスト」を宣言で渡し、ホストが SVG で描く。3D の重ね描きは当面、外部には出さない
- 組み込みのプラグインは同じページで動く（信頼する）。ただし権限は同じ形で宣言し、宣言の漏れをテストで捕まえる

### 権限

プラグインは `manifest.json` に、使う権限と理由を宣言する。

| 権限 | できること | 許可を求める時 |
|---|---|---|
| `layers.read` | レイヤーの一覧・範囲・CRS・選択を読む | 入れる時 |
| `layers.create` | 新しいレイヤーを足す（ADR-0018。元は書き換えない） | 入れる時 |
| `points.read` | 選んだレイヤーの点を、範囲を指定して順に受け取る（メモリは点数に比例させない） | 入れる時 |
| `view.control` | カメラ・投影・表示の範囲を変える | 入れる時 |
| `view.overlay` | 画面に点・線・文字を重ねる | 入れる時 |
| `file.save` | ファイルを保存する（保存先は毎回利用者が選ぶ） | 使う時に毎回 |
| `file.open` | 利用者が選んだファイルを読む | 使う時に毎回 |
| `network:<オリジン>` | 宣言したオリジンにだけ接続する | 入れる時（オリジンごと） |
| `storage` | プラグイン専用の保存領域（容量の上限つき） | 入れる時 |

- 入れる時に、宣言された権限と理由を一覧で見せ、1つずつ許可／拒否を選ばせる。拒否された権限の呼び出しは `permission-denied` のエラーとしてプラグインに返す。アプリは止めない
- 宣言していない権限は使えない。権限を増やした版に更新する時は、増えた分だけ許可を求め直す
- **設定に「プラグイン」のページを足す**: 入れたプラグインの一覧、有効／無効、権限ごとの許可の切り替え、接続先の一覧、削除。変えたらすぐ効く（そのプラグインを読み込み直す）
- 許可の記録（プラグインの id・版・manifest のハッシュ・権限ごとの許可）はアプリの設定として保存する（Web は localStorage、デスクトップは設定ファイル。どちらも `datasource` 経由）。
  manifest が変わったら記録を無効にして求め直す
- 入れる元: Web は HTTPS の URL（CORS が要る）かファイル（zip、または .js と manifest）、デスクトップはファイルの選択。中身を保存してから動かす（毎回取りに行かない）

### 落ちないこと

- iframe の中の例外・無限ループで本体は止まらない。応答が一定時間ない RPC は失敗にし、繰り返せばそのプラグインを止めて理由を表示する
- `points.read` の受け渡しは、プラグインが受け取りを確認してから次を送る（ホストが抱える量に上限）

### 採らなかった案（外部のプラグイン）

- **同じページで `import()` して警告だけ出す**: 権限を宣言させても守らせられない。所有者の「許可を求める」に応えられない
- **Web Worker に閉じ込める**: DOM が無いので画面を描けない。Worker の `fetch` にはページの CSP しか効かず、プラグインごとの接続先の制限ができない

## 採らなかった案

- **組み込みはそのままで、第三者用の口だけ足す**: 口が実際に使えるかを誰も確かめないまま腐る。組み込みが同じ口を使うことが保証になる
- **Rust の計算もプラグインにする（wasm のプラグイン）**: 所有者の依頼は TS 側。wasm のプラグインは ABI・メモリの上限・デスクトップとの二重化が重く、今は割に合わない

## 改訂（PL-0、2026-11-21）: PL-0 で作った API の形

PL-0（`src/plugin-api/index.ts`・`src/core/plugin-host.ts`・`src/ui/plugins/`）で、上の「形」の `PluginHost` を次のように決めた。本文は書き換えない。

- **PL-0 の口は `ribbon`・`dialogs`・`status`・`shortcuts`・`errors`・`program` だけ。** `layers`・`tools`・`view`・`units`・`settings` は、使う機能を移すとき（PL-1 以降）に足す。使えない口を見せない
- 口の一覧: `ribbon`・`dialogs`・`status`・`shortcuts`・`errors`・`program`（後の改訂で口を足したら、その改訂の節に同じ「口の一覧:」の行を書く。`src/core/adr-shape.test.ts` が最後の「口の一覧:」の行と、ホストがプラグインに渡す口を突き合わせる）
- **`program(init, update, effectFailed)`**: ADR-0022 の改訂（PL-0）の3つ目の引数のうち、`effectFailed` だけをプラグインが渡す。
  効果の失敗はホストが `errors.report(プラグインの id, error)` に流してから Msg にし、失敗の Msg の処理中の失敗は報告だけにする
- **`shortcuts.add({ key, label, kind, run })`**: 上の `add(key, label, run)` に、入力欄での扱いの種類 `kind` を足した。
  `"harmless"` は `isTypingTarget`（文字を打つ欄でだけ止める）、`"irreversible"` は `isFormControl`（フォーム部品なら止める）で、判定はホストがする（プラグインは判定を書かない）。
  位置の引数が4つになるので、名前つきの1つのオブジェクトにした
- **アプリが使っているキーはプラグインに渡さない**: `APP_SHORTCUT_KEYS`（`src/core/plugin-host.ts`。F・1〜7 は視点、Delete はレイヤーの削除、Enter・Escape は計測・範囲選択とダイアログ、Tab はダイアログのフォーカスの巡回）を
  登録しようとしたら、同じキーの2度目の登録と同じく断って `errors.report` に流す（PL-0 監査 R1 F-5。同じキーで既存の処理とプラグインの両方が走るのを防ぐ）。
  `src/core/app-shortcut-keys.test.ts` が、視点のキーの一覧（`VIEW_SHORTCUTS`）と、ソースの中のキーの比較（`e.key === "…"` の形）が全部この一覧に入っていることを確かめる。
  PL-1 で視点が `pcv.view` に移ったら、F・1〜7 をこの一覧から外す（その時は視点のプラグインが登録する）
- **描く物の型は `ViewNode`、アイコンは `IconComponent`**: `src/plugin-api` は React を import しない（型も）ので、`ReactNode` の代わりに広い型
  （`ViewNode` は object・文字列・数・真偽・null・undefined、`IconComponent` は object）を置き、`src/ui/plugins` が `ReactNode`・lucide のアイコンとして描く。
  誤った物を渡されたら描画で投げ、Error Boundary が受け止める。アイコンを名前の文字列にしてホストが引く案は、全アイコンを読み込む表が要るので採らなかった（外部のプラグインの宣言の形は PL-9a で決める）
- **リボンの `enabled` の条件とグループは PL-1 で足す**: 「点群があるか」を知る `layers` の口がまだ無く、PL-0 では使い手がいないため
- **Error Boundary は ADR-0021 の「クラスは長く生きる資源を持つものだけ」の例外**: React の Error Boundary はクラスの部品でしか書けない（フックの API が無い、React の仕様）。
  `src/ui/plugins/PluginErrorBoundary.tsx` が持つ状態は `failed` 1つだけで、手順は持たない。リボンの項目・ステータスの項目・ダイアログごとに置き、ダイアログの中身が投げたらダイアログごと閉じる
- **エラーの行き先**: `errors.report(source, error)` は既存の `reportError("<source>: <本文>", "tool")` に流れる（ErrorDialog の見出しは「点群ツール」）。新しいバナーは作らない

## 改訂（PL-1、2026-11-21）: 視点を `pcv.view` に移すために足した口

PL-1 で視点（TP-1）を組み込みプラグイン `pcv.view`（`src/plugins/view/`）に移したとき、上の「改訂（PL-0）」の形に次を足した。本文と PL-0 の改訂は書き換えない。

- **`DialogSpec.onClose`（閉じたことの通知、PL-0 の N-7）**: ホストが閉じたとき（Esc・枠の外のクリック・フッターの閉じるボタン、中身が投げてホストが閉じたとき）に、ちょうど1度呼ぶ。
  プラグインが自分で `handle.close()` したときと、プラグインを止めるとき（`deactivate`）は呼ばない（閉じたことをプラグインが知っている、またはプラグインがもう居ないため）。
  `onClose` が投げたら `errors.report(プラグインの id, error)` に流し、ダイアログは閉じたままにする。使い手は `pcv.view`（ダイアログが開いているかを Model に持ち、リボンを2度押しても2つ開かない）
- **リボンの `group`・`enabled`・`disabledTitle`・`testId` と、`ribbon.add` が返す `RibbonHandle { setEnabled }`**（PL-0 の改訂で PL-1 に先送りした物）: `group` は置く場所で、今は `"view"`（「開く」の区切りの後、計測の区切りの前）だけ（使い手のいない場所は足さない。PL-3 以降で足す）。
  `enabled: false` のボタンはグレーアウトし、ツールチップは `disabledTitle`。`setEnabled` で、登録し直さずに（同じボタンのまま）押せる／押せないを変える。押せないボタンの `onClick` はホストが呼ばない。
  `enabled` を「条件の関数」にしてホストが毎回呼ぶ案は、いつ呼び直すか（何が変わったら描き直すか）をホストが知りようがないので採らなかった。プラグインは自分の Model の変化で `setEnabled` を呼ぶ
- **`Shortcut.enabled` と、`shortcuts.add` が返す `ShortcutHandle { setEnabled }`**: 押せないショートカットは、走らせず、キーも取らない（`preventDefault` しない）。TP-1 の「点群が無いとき視点のキーは何もせず、キーも取らない」をそのまま移すため。断った登録（アプリのキー・他のプラグインのキー）には何もしない handle を返す
- **`DialogSpec.width`（`"normal"`・`"narrow"`）と `closeButtonLabel`**: ダイアログの枠の幅と、フッターの閉じるボタン。ホストが既存の `Dialog` の `widthClass`（`normal` は今の既定の `max-w-lg`、`narrow` は視点のダイアログが使っていた `max-w-xs`）と、
  既存のダイアログと同じ形のボタン（`DIALOG_TERTIARY_BUTTON_CLASS`）で描く。押したら、ホストが閉じたのと同じに `onClose` を呼ぶ。
  幅をクラス名の文字列で渡す案と、フッターを `ViewNode` で渡す案は、プラグインが `src/ui/dialogs` の見た目の定数を import できない（ADR-0023 の import の決まり）ので、同じ見た目を保つ道が無く採らなかった
- **`layers`（読む側だけ）: `{ hasPointCloud(): boolean; subscribe(listener) }`**: 点群のレイヤー（計測のレイヤー以外）が1つでもあるか。上の「形」の `LayerApi`（一覧・選択・新しいレイヤーを足す）のうち、`pcv.view` が使う読む側だけを置いた。一覧・選択・足す側は、使うプラグイン（PL-2 以降）を移すときに足す。
  今の値はビューの文脈（`src/app/view.ts` の `ViewContext.pointCloud`、`syncViewWithLayers` がレイヤーの一覧から作る）にある。レイヤーの一覧を移すときにレイヤーの文脈へ分ける
- **`view`: `{ get(): ViewState; subscribe(listener); fitAll(); showPreset(id); setProjection(mode) }`**（`ViewState` は `projection`・`preset`・`rendererHasLayers`）: 上の「形」の `ViewApi` のうち、視点（全体・決まった視点・投影）と、その読み取りだけ。ピック・2D の重ね描き・表示の範囲は、使うプラグイン（計測・TP-2）を移すときに足す。
  `preset` はレンダラの stats の `viewPreset`（`matchViewPreset` で今の向きから求めた値）、`rendererHasLayers` は stats の `layerCount > 0`（ステータスバーの視点の文を出す条件。TP-1 と同じ）。
  `ProjectionMode`・`ViewPresetId`・`VIEW_PRESET_IDS` は `src/plugin-api` に置いた（`src/plugin-api` は `src/renderer` を import しないため）。レンダラの型と同じであることは、ホストの配線の型検査（`ViewState` へ渡す向きと `showPreset` の向きの両方）と、`src/ui/plugins/view-plugin.test.tsx` の "the plugin API's viewpoints and the plugin's labels are the renderer's" で確かめる
- **投影の正本はビューの文脈**: 選んだ投影は、プラグインの Model ではなく、ビューアごとのビューの文脈（`ViewContext.state`）に置く。レンダラを作り直したとき（`attachViewRenderer`）に、選んでいた投影を新しいレンダラに渡すため（F11）。`pcv.view` の Model は `view.subscribe` でその値を写す。
  プラグインの Model に正本を置く案は、レンダラの付け外しがプラグインの外（`src/state/useRendererLifecycle.ts`）で起きるので、新しいレンダラに投影を渡す道がホストに無くなり採らなかった
- **ビューの文脈はビューアごと（F11）**: `export const viewContext`（モジュールに1つ）を消し、`useCopcViewer` がビューアごとに `createViewContext()` を作って、レンダラの付け外しとホスト（`createPluginHost({ reportError, view })`）に渡す
- **購読の失敗**: `layers.subscribe`・`view.subscribe` に渡した関数が投げたら、ホストが `errors.report(プラグインの id, error)` に流し、ほかの購読者とレイヤー・ビューの更新は続ける
- **視点のキー（F・1〜7）は `pcv.view` が持つ**: `pcv.view` が `shortcuts.add` で `kind: "harmless"` として登録し、点群が無い間は `setEnabled(false)` にする。`APP_SHORTCUT_KEYS` から F・1〜7 を外し、Delete・Enter・Escape・Tab だけにした。他のプラグインが同じキーを登録しようとすると、2度目の登録として断って報告する（`src/core/app-shortcut-keys.test.ts`）
- **ステータスバーのプラグインの場所**: プラグインの項目を、fps の後（視点の文があった場所）に描く。中身が何も描かないとき（点群が無いとき）は包む `span` を `empty:hidden` で消し、空の項目の間隔が残らないようにした
- 口の一覧: `ribbon`・`dialogs`・`status`・`shortcuts`・`errors`・`layers`・`view`・`program`
