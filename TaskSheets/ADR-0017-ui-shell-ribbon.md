# ADR-0017: UIシェルをリボン+レイヤーツリー+ステータスバーに再構築する

- 状態: 採択
- 日付: 2026-10-09
- 前提: [ADR-0005](./ADR-0005-ui-shell.md)（ガラスの質感、維持）、[ADR-0011](./ADR-0011-gpu-error-visibility.md)（エラー表示。本ADRで「バナー」から中央ダイアログに変更）
- 関連: [ADR-0018](./ADR-0018-layer-centric-operations.md)（機能は「選んだレイヤーから新しいレイヤーを作る」向きに揃える。レイヤーパネルとツールの構造に反映した）
- 置き換え: [ADR-0014](./ADR-0014-ui-forge.md)（ui-forgeでのレイアウト記述。本ADRで廃止）

## 決定（所有者の判断）

1. **レイアウトをデスクトップの点群/GIS系ソフトに多い構成に変える。** 上部に
   リボン、左にレイヤーツリー、下部にステータスバー。以前は画面下部中央の
   フローティングドック+左右2枚のパネル(ADR-0005時点の構成)だった。
2. **ガラスの質感は維持する。** ADR-0005の決定(全面ビューア+浮かぶガラス面、
   ライト/ダーク別tint、設定モーダルは不透明)は変えない。
   **ガラスのオン/オフというユーザー設定は廃止した**(所有者の決定。設定画面のチェックと
   `AppShell`のstate・setterを削除。永続化は元から無かった)。デスクトップ・Webでは常にガラス。
   ただしモバイル端末では`device-profile.ts`の端末プロファイル(M3-8)が、GPU負荷のため自動で
   ぼかしを切って不透明のtintにする。これは性能プロファイルであり、ユーザーが切り替える設定ではない
   ので残した。
3. **ui-forgeを使うのをやめる。** `Dock`(ui-forgeで書かれていた唯一の
   コンポーネント)を手書きのTSXに戻す決定の前に、新しいレイアウトでは
   フローティングドック自体が無くなる(決定1の帰結)。ドックが無くなった以上
   ui-forgeを使う対象も無くなるため、ツール自体を取り除く。`Dock.ui`/
   `Dock.generated.tsx`/`npm run ui:gen`・`ui:check`/CIの検査ステップ/
   `package.json`のui-forge依存をすべて削除する。
4. **未実装のツール(計測・断面・点の選択・複数レイヤー)はグレーアウトで表示する。**
   `disabled`属性をつけ、クリックしても何も起きないことをHTMLレベルで保証し、
   `title`に「未実装（予定）」と出す。
5. **下部のタブ型ドックは作らない。**
6. 他社製品(名前・ロゴ・アイコン・配色・文言)を模倣しない。コード・UI・
   ドキュメントのどこにも言及しない。

## 新しいレイアウト

```
<div class="fixed inset-0">
  <ViewerPanel />                 ← 3Dビュー(canvas)、全面
  <Ribbon />                      ← 上部。ファイル/表示/ツール/設定の4グループ
  <LayerPanel />                  ← 左。レイヤーツリー+レイヤー情報、折りたたみ可
  <StatusBar />                   ← 下部、1行
  <SettingsModal />                ← 不透明なモーダル
  <ConversionDialog />             ← 中央ダイアログ「変換中」(新設)
  <ErrorDialog />                  ← 中央ダイアログ「エラー」。z-50、最前面(新設。旧バナーの後継)
  <UpdateNotice />
</div>
```

768px未満(`src/state/useNarrowViewport.ts`、`matchMedia`ベース)では:
- `Ribbon`はハンバーガーボタン1つの帯に畳まれ、タップすると全グループを
  縦に並べたメニューが下に開く(`Ribbon.tsx`)。
- `LayerPanel`は固定幅のフロートパネルではなく、画面を覆うドロワーになる
  (開いている間は背景に半透明の黒を敷き、タップで閉じる。`LayerPanel.tsx`)。
- すべてのボタン・入力は最小44px角(`ribbon-styles.ts`の`min-h-11`、
  Tailwindの`h-11`/`w-11`はいずれも44px)。

## 既存コントロールの対応表

タスクの指示(「削る前に、今あるコントロールを全部挙げて新しい場所に対応づける」)
に従い、削除前に存在した全コントロールを列挙し、新しい場所を対応づける。

### 旧 `LayerPanel.tsx`

| 旧コントロール | 新しい場所 |
|---|---|
| COPCファイル選択(Web: ファイル選択/URL入力/サンプルを開く。デスクトップ: OSのファイル選択ダイアログ) | `Ribbon`の「ファイル」グループ(`RibbonFileGroup.tsx`): 開く(`data-testid="file-input"`維持)・URLから開く(中央の`UrlDialog`。常設のURL欄は廃止)・サンプル |
| エラー表示(`data-testid="viewer-error"`) | `LayerPanel`の「レイヤー情報」(`LayerInfoSection.tsx`)。testidはそのまま維持 |
| 変換中の進捗+キャンセルボタン | 中央の変換ダイアログ(`ConversionDialog.tsx`、「変換中」。キャンセルはフッター) |
| ダウンロードリンク(`data-testid="download-link"`) | `LayerInfoSection.tsx`。testidはそのまま維持 |
| 変換の内訳(`data-testid="conversion-breakdown"`、コピー機能) | `LayerInfoSection.tsx`の`ConversionBreakdownPanel`(ロジック・testid・コピー機能ともそのまま) |
| 点予算(数値入力+自動調整チェック) | `LayerInfoSection.tsx`(タスクシートの「表示」グループ5項目に含まれないため左パネルに残した) |
| 背景(select) | `LayerInfoSection.tsx`(同上の理由) |
| グリッド(checkbox) | `LayerInfoSection.tsx`(同上の理由) |
| 着色モード(select) | `Ribbon`の「表示」グループ(`RibbonViewGroup.tsx`)。タスクシートの指定 |
| パネル開閉ボタン(◀/▶) | `LayerPanel.tsx`自身の開閉ボタン(そのまま。モバイルではドロワーの開閉に相当) |

### 旧 `InfoPanel.tsx`（右パネル、本再構築で廃止）

| 旧コントロール | 新しい場所 |
|---|---|
| cloudInfo: points | `LayerInfoSection.tsx`(「点数」として) |
| cloudInfo: nodes / hasColor | `LayerStatsDetails.tsx`(折りたたみ式の詳細統計) |
| 統計: drawn points/nodes, loading/queued/cached nodes, fps, pointBudget | `LayerStatsDetails.tsx`(詳細)。fps・表示点数・点予算は`StatusBar.tsx`にヘッドラインとしても出す(タスクシートの指定: ステータスバーに表示点数/予算・fpsを出す) |
| モバイル最適化の現在値(isMobile/renderScale/pointShape/pointBudgetMax) | `LayerStatsDetails.tsx` |
| カメラ(pitch/yaw/upAxis/eye) | `LayerStatsDetails.tsx` |
| パネル開閉ボタン(▶/◀) | 廃止。右パネル自体を左パネルへ統合したため、専用の開閉ボタンは不要になった(左パネルの開閉ボタンが同じ役割を兼ねる) |

### 旧 `Dock.tsx`（フローティングドック、本再構築で廃止）

| 旧コントロール | 新しい場所 |
|---|---|
| 「レイヤー」ボタン(開閉トグル+ハイライト) | 廃止(重複削除)。`LayerPanel`自身の開閉ボタンが同じ役割を既に持っていたため、ドック側の同機能ボタンは不要 |
| 「情報」ボタン(開閉トグル+ハイライト) | 廃止。右パネル自体を廃止したため不要(InfoPanelの項参照) |
| 「設定」ボタン | `Ribbon`の「設定」グループ(`RibbonSettingsGroup.tsx`) |

### 旧 `SettingsModal.tsx`（タスクシートが指定した5項目のうち、設定画面から移した分）

| 旧コントロール | 新しい場所 |
|---|---|
| 点の形(丸/四角ボタン) | `Ribbon`の「表示」グループ。select化(タスクシートの「point size」に対応。下記「`point size`の対応付けについて」参照) |
| EDL(checkbox) | `Ribbon`の「表示」グループ(そのまま) |
| 中央優先度の強さ(スライダー) | `Ribbon`の「表示」グループ(そのまま) |
| 中央優先度の下限(スライダー) | `Ribbon`の「表示」グループ(そのまま) |
| 「開発用: パス指定で開く」(絶対パス入力欄) | 廃止(パスを人に打たせない。OSのダイアログ/ドラッグ&ドロップで代替) |
| 「UIのガラス表現」チェック | 廃止(上記の決定2。ガラスは固定) |
| テーマ/更新確認/一時ファイル置き場所/レンダースケール/点予算上限表示/OPFS保存領域/診断パネル/開発用パス直指定 | `SettingsModal.tsx`に残存(位置不変) |

### 旧 `GpuErrorBanner.tsx`（廃止。中央のエラーダイアログに置き換え）

| 旧コントロール | 新しい場所 |
|---|---|
| エラー表示(本文そのまま・複数を縦に並べる) | `ErrorDialog.tsx`(中央、「エラー」) |
| 個別の✕閉じる | ダイアログの「閉じる」(✕・Escも同じ)。現在のエラーをまとめて消す。個別には消さない(まとめて読んで閉じる使い方に変わったため) |
| (新設)エラーログ | 同じ`ErrorDialog`の履歴モード。ステータスバーの「ログ」ボタンから開く |

### 新規追加

| 新しいコントロール | 場所 | 備考 |
|---|---|---|
| 未実装ツール(計測・断面・点の選択・複数レイヤー)、いずれも`disabled` | `Ribbon`の「ツール」グループ(`RibbonToolsGroup.tsx`) | タスクシートの指定どおり |
| 表示点数/予算、fps、CRS、読み込み進捗、エラーログを開くボタン | `StatusBar.tsx` | 新規 |
| セッション中の全エラー履歴(閉じても消えない) | `ErrorDialog.tsx`の履歴モード | ステータスバーの「ログ」と、エラーダイアログ本文の「履歴を見る」から開く |
| 変換ダイアログ(ファイル名・進捗バー・段階・経過時間・キャンセル。完了後は結果表示) | `ConversionDialog.tsx` | ステータスバーの変換中表示から開き直せる |
| 共通のダイアログ枠 | `Dialog.tsx` | 下記「ダイアログ」参照 |

## ダイアログ（所有者の追加要件）

設定・変換の進捗・エラーは、画面中央のダイアログで出す(タイトルバーが上、本文、右寄せボタンのフッターが下)。

- **共通部品は`Dialog.tsx`(手書き1ファイル)。** 不透明(ADR-0005どおり)、Escと✕で閉じる、
  開いたら本文の最初の操作要素へフォーカスを移して閉じたら元の要素へ戻す、Tabはダイアログ内で循環。
  狭幅(<768px)は外枠の余白を詰めたほぼ全幅の中央ダイアログ。暗幕クリックでは閉じない
  (読んでいる最中の誤操作を避けるため)。ボタンは44px以上。振る舞いは`Dialog.test.tsx`で確認。
- **設定:** `Dialog`に載せた(不透明のまま)。フッターは「閉じる」。
- **変換の進捗:** 長時間のLAS/LAZ→COPC変換だけが対象。タイトル「変換中」、本文は
  ファイル名(複数選択時は表示名)・進捗バー・いまの段階・経過時間、フッターは「キャンセル」。
  ✕/Escで隠しても変換は続く(ステータスバーの変換中表示から開き直せる)。
  変換が終わると同じダイアログが「変換が完了しました」の結果表示になり、フッターは「閉じる」。
  **「開く」ボタンは置かない:** 変換結果は完了時に自動で開かれる(`onConversionDone`/`onConvertDone`が
  `openFile`を続けて呼ぶ既存の流れ)ため、押せるボタンが何もしない状態になるのを避けた。
  変換の内訳(コピー可)・ダウンロードは左パネルの「レイヤー情報」に残し、ダイアログからそこを案内する
  (`data-testid`はそちらに残るため、ダイアログ側では重複させない)。失敗・キャンセルのときは変換ダイアログは
  出さず、エラーダイアログが出る。ノードの逐次読み込みの進捗はステータスバーのまま。
- **エラー:** タイトル「エラー」、本文は全文(要約しない・選択してコピー可・複数なら縦に並べる)、
  フッターは「コピー」「閉じる」。新しいエラー(`gpuErrors`の増加、または`viewer.error`の変化)で自動で開く。
  **旧バナー(`GpuErrorBanner.tsx`)は廃止し、角のインジケータも残さなかった。** 代わりにステータスバーの
  「ログ」ボタンが同じダイアログを履歴モードで開く(エラーログ用の別ダイアログ`ErrorLogDialog.tsx`も
  `ErrorDialog`に統合して廃止)。ADR-0011が守った要件(本文そのまま・最初のエラーを隠さない・不透明・
  最前面(z-50)・テーマに依らない警告色)は引き継いだ。「閉じる」は現在のエラーを一覧から消すが、
  履歴(`viewer.errorHistory`)には残る。
- **`data-testid`:** `viewer-error`は左パネルの`LayerInfoSection.tsx`にエラーがあるときだけ描画する
  (E2Eは成功後に不在を確かめる)。`file-input`・`conversion-breakdown`・`download-link`も従来どおり。

## 色の役割（所有者の追加要件）: primary=緑 / secondary=橙 / tertiary=灰 / error=赤

- **定義は1箇所:** `src/index.css`のCSSカスタムプロパティ(`--primary`/`--on-primary`など8個、
  ライトは`:root`、ダークは`:root[data-theme="dark"]`)。`@theme inline`で
  Tailwindの`bg-primary`・`text-on-primary`・`border-tertiary`・`accent-primary`などの名前にした
  (このプロジェクトが既にTailwind v4 + `data-theme`属性でテーマを切り替えているため、その仕組みに乗せた)。
  コンポーネントは役割の名前だけを使い、役割色の生のhexは書かない。ガラス面のtint(`glass.ts`)は従来のまま
  (役割色が乗るのはその上のボタンなどの部品)。
- **値と文字コントラスト(WCAG相対輝度の式を`node`で計算した実測。AAの文字は4.5:1以上):**

| 役割 | テーマ | 面の色 | 上の文字(on-*) | コントラスト比 |
|---|---|---|---|---|
| primary(緑) | ライト | `#15803d` | `#ffffff` | 5.02 |
| primary(緑) | ダーク | `#4ade80` | `#052e16` | 8.55 |
| secondary(橙) | ライト | `#c2410c` | `#ffffff` | 5.18 |
| secondary(橙) | ダーク | `#fb923c` | `#431407` | 6.92 |
| tertiary(灰) | ライト | `#475569` | `#ffffff` | 7.58 |
| tertiary(灰) | ダーク | `#334155` | `#f1f5f9` | 9.45 |
| error(赤) | ライト | `#b91c1c` | `#ffffff` | 6.47 |
| error(赤) | ダーク | `#f87171` | `#450a0a` | 5.84 |

  役割色を文字そのものに使う箇所(左パネルの`viewer-error`の赤文字)は、面の上で: ライト
  `#b91c1c`/白 6.47、ダーク`#f87171`/`#0f172a` 6.45(いずれも4.5以上)。
  ※計算は面が不透明な前提。ガラス面(半透明)の上に置いた場合の実際の背景色は点群で変わるため、
  役割色のボタン(不透明な塗り)の上の文字についてだけ保証できる。
- **割り当て:** primary = 主操作(リボンの「開く」、`UrlDialog`の「開く」、ダウンロードリンク、
  更新通知のリリースページ、設定のテーマ/レンダースケールの選択中、チェック・スライダーのON表示
  (`accent-primary`))。secondary = 進行中(変換ダイアログの進捗バーと「段階」バッジ、ステータスバーの
  「変換中 N%」)。tertiary = 中立・無効(未実装ツールの無効スタイル、閉じる/キャンセル/コピーなどの
  副ボタン、進捗バーの溝)。error = エラーダイアログのタイトルバー、ステータスバーの
  エラーログボタン(履歴が1件以上あるとき赤)、`viewer-error`の文字。
- ダイアログの「閉じる」は所有者の割り当てに従いtertiaryにした(以前の実装は主ボタン風の塗りだった)。

### レイヤー中心の構造（[ADR-0018](./ADR-0018-layer-centric-operations.md)に沿う）

機能は「選んだレイヤーから新しいレイヤーを作る」向きに揃える、という原則(ADR-0018)に、構造だけ備えた
(新しい機能は作っていない)。
- **選んだ方法: stateは変えず、`LayerPanel.tsx`の中で形だけ揃えた。** `layers: Layer[]`と
  `selectedLayerId`を`viewer`の状態(開いているファイル名・状態)から導く。いまは最大1件で選択は常にその1件。
  `src/state`(`useCopcViewer`)は別のエージェントが複数ファイル対応で並行して変更中のため、
  今ここで一覧と選択をstateに入れるのは衝突の危険が大きいと判断した。複数レイヤー化するときは、
  この2つをstateへ引き上げるだけで、一覧の描画(選択行の左のprimary線、`aria-selected`)はそのまま使える。
- **ツールは「選択中のレイヤーに対する操作」として並べる。** 未実装のツールのツールチップは
  「選択中のレイヤーから断面レイヤーを作る（未実装）」の言い方(計測・点の選択・複数レイヤーも同様)。
- **表示の設定は対象外:** 着色・EDL・点のサイズ・中央優先度は点群を作り替えないので、ADR-0018のとおり
  レイヤーの操作ではなく、リボンの「表示」グループのまま。

### アクセントの細い線（所有者の追加要件）

役割色トークンの細い線で、ガラスの面の見た目を引き締める(重い枠にはしない)。
- **リボン:** 上端に3pxのprimary(緑)。上端を選んだ。下端(キャンバスに接する側)は試していない(下端だと左パネルの縁と近くなり二重に見えそう、という見込みで、未検証)。上端のスクリーンショット(ライト/ダーク)では、ライトで明瞭、ダークでは控えめに見える。狭幅のコンパクトなバーも同じ。
- **ダイアログ:** 上端に3px(`Dialog.tsx`の`accent`)。設定・URLから開く = primary、
  変換 = secondary(橙)、エラー = error(赤。タイトルバーも赤いので線は目立たない)。
- **左パネル:** 選択中のレイヤー行の左に3pxのprimary。パネル内の見出し(「レイヤー」「レイヤー情報」
  「詳細統計」)の左に2pxのtertiary(灰)。
- **アクティブなタブ/トグルの下線:** `RibbonButton`に`active`(下端3pxのprimary)を用意したが、
  いまのリボンにタブ・トグル型のボタンは無いため、使っている箇所は無い(将来のため)。

## UIの動き（AN-3。`TaskSheets/AN-animation.md`）

- **実装:** アニメーションライブラリは使わない。CSSのtransition/keyframesと、出入りのためだけの
  小さなフック`useTransitionMount.ts`(`mounted`=DOMに居る、`shown`=見せている状態。開くとき次のフレームで
  `shown`にしてtransitionを走らせ、閉じるときは`shown`を先にfalseにして、`exitMs`後にDOMから外す)。
- **動かすのは`opacity`と`transform`だけ**(`backdrop-filter`・ぼかし・幅・高さは動かさない。ADR-0005)。
  進捗バーも幅ではなく`transform: scaleX`(`ConversionDialog.tsx`)。
- **時間・イージングは`src/index.css`の`--motion-*`の1箇所**(すべて未検証の初期値。所有者が画面で見て調整する):
  ダイアログの出る170ms・閉じる120ms、パネル220ms、押下100ms、進捗300ms、脈打ち450ms、
  イージングはease-out/ease-in(`cubic-bezier`)。`Dialog.tsx`の`EXIT_MS`と`LayerPanel.tsx`の
  `PANEL_EXIT_MS`はDOMを外すタイミング用の同じ値(CSS側と合わせて直す)。
- **`prefers-reduced-motion: reduce`:** `--motion-*`を0msにし、フックも待たずにDOMから外す。
- **内容:** ダイアログ(設定・URL・変換・エラー)は暗幕のフェード+パネルが0.96倍→1倍のフェード
  (閉じるときは逆向きで速い)。左パネルと狭幅のドロワーはtranslateXで滑る(デスクトップでは開閉ボタンも
  同じtransformで動かし、パネルがDOMから消えたときに位置が飛ばないようにした)。リボンのボタンは
  ホバーで1px浮き、押下で0.97倍。`RibbonButton`の`active`は下線がscaleXで中央から伸びる(使う箇所はまだ無い)。
  ステータスバーのエラーログボタンは、新しいエラー(履歴の件数が増えたとき)に1回だけ脈打つ。
  点数・fpsなどの数値には動きをつけない。
- **やっていないこと:** (1) 「スイッチのつまみ」の動き: UIにスイッチ部品が無く、チェックボックスはブラウザ標準のため。
  (2) AN-animation.mdの「設定にアニメーション: オン/オフ」: ユーザー設定を増やさない方針(ガラスの設定廃止と同じ)で
  見送り、OSの`prefers-reduced-motion`にだけ従う。
- **確認(実行した出力):** headed Chromiumでrequest​AnimationFrameごとにcomputed styleを標本化した。設定ダイアログの
  開くとき: opacityが0.00→0.49→0.75→0.87→…→1.00、scaleが0.96→0.9795→0.9899→…→1.0に推移(中間フレームあり)。
  閉じるとき: 約120msでopacity 1→0・scale 1→0.96に推移した後、DOMから消えた。左パネルの畳む/開くも
  translateXが0↔-316.8pxを中間値を通って推移した。E2E(`web-conversion`・`web-multi-conversion`)は通る
  (`viewer-error`は左パネルにありダイアログのアニメーションの影響を受けない)。
  未確認: 見た目の心地よさ(所有者が画面で調整)、デスクトップ(Tauri)・Android実機での滑らかさ。

## ファイルの開き方（所有者の追加要件）: パスを人に打たせない

- **ローカルファイルのパスを打つ入力欄は、アプリのどこにも無い。** 削除したもの: 設定画面の
  「開発用: パス指定で開く」(絶対パスの入力欄+開くボタン)。設定画面の一時ファイルの置き場所も、
  以前は読み取り専用の`<input>`で表示していたが、入力欄に見えないよう`<p>`の表示に変えた
  (変更は「選ぶ…」のOSのフォルダ選択から)。確認: `grep -rn 'type="text"' src/ui`が空、
  `<input>`は`file`・`checkbox`・`range`・`number`(点予算)・`url`(下のURLダイアログ)だけ。
- **開く経路は3つだけ。** (1) OSのファイル選択ダイアログ(Web: 隠した`<input type="file">`
  `data-testid="file-input"`をリボンの「開く」ボタンのラベルで包む。デスクトップ・Android:
  `src/datasource/tauri.ts`の`pickLocalFiles`)。(2) ドラッグ&ドロップ(`src/state/useFileDrop.ts`)。
  Webはブラウザ標準のdrop、デスクトップはTauriのドラッグ&ドロップイベントを
  `src/datasource/tauri.ts`の`onFilesDropped`越しに受ける(規約2: Tauriのパッケージのimportは
  `tauri.ts`だけ)。ドラッグ中は「ここにドロップして開く」の案内を重ねる。どちらも
  `viewer.openFiles()`を呼ぶだけ(複数ならマージ、1件なら従来どおり)。(3) リモートCOPCのURL。
- **URLから開く:** リボンの「URLから開く」ボタン(Webのみ)が`UrlDialog.tsx`(中央ダイアログ、
  入力欄はURL1つ、フッターは キャンセル/開く)を開く。パネルへの常設入力欄は無い。
  ダイアログはリボンのz-20の重ね順の外に出すため、`AppShell`が持つ。
- **未確認:** Tauriのドラッグ&ドロップ(`onDragDropEvent`)は、デスクトップ・Android実機で
  動かしていない(Webビルドでは呼ばれない。型検査とlintのみ)。所有者の確認手順は下記。

## ボタンのアイコンとラベル（所有者の追加要件）

- リボンのボタンは**アイコンが上、短い文字ラベルが下**(`RibbonButton.tsx`)。未実装ツールも
  アイコンとラベルを残したまま無効スタイル(`disabled`、不透明度40%、`title`「未実装（予定）」)。
  select・スライダー・チェックのような「ボタンではない操作」は、アイコン+短いラベルの見出しを
  操作の上に添える(`RibbonViewGroup.tsx`の`RibbonControl`)。
- 狭幅(<768px)のコンパクトなバーは、「メニュー」ボタン(アイコンの下にラベル)を置く。
  開いたメニューの中のボタンも同じ`RibbonButton`(アイコン+ラベル)なので、アイコンだけで
  名前を省く場面は無い(ホバーの`title`にも説明を入れてある)。
- **アイコンセット: `lucide-react`**(本体をそのまま使う。同梱する1つのセットだけ)。
  ライセンスは**ISC**(Feather由来の一部アイコンのみMIT。`node_modules/lucide-react/LICENSE`で確認)。
  どちらも寛容なライセンスで、このプロジェクトの`MIT OR Apache-2.0`と両立する。
  理由: アイコンの見た目が1つのセットで揃う・必要なものだけimportすればビルドに入る
  (ツリーシェイク。使うのは約15個)・Reactコンポーネントなので手書きSVGの管理が要らない。
  採らなかった案: 手書きインラインSVG(15個ぶんの図形を自分で保守することになり、
  見た目も揃えにくい)。追加した依存は`lucide-react`の1つ(`package.json`、バージョンは
  インストール時の1.54.0)。使うアイコン: FolderOpen・Link2・Box・Palette・Contrast・Circle・
  Crosshair・ArrowDownToLine・Ruler・Slice・MousePointerClick・Layers・Settings・Menu・X。

### `point size`の対応付けについて

タスクシートの「表示」グループの指定に`point size`があるが、このコードベースには
点の大きさを数値で調整する機能が無い(`src/renderer/gpu-resources.ts`の
`POINT_SIZE_PX`は固定値で、UIから変える口が無い)。UIから唯一調整できる
「点の見た目」は点の形(丸/四角、`pointShape`)だけなので、これを`point size`の
対応先とした。新しい数値調整機能を追加することは本タスクの範囲(UIシェルの
再構築)を超えると判断し、見送った。

### CRSについて

当初(このADRの実装時点)は、`CloudInfo`にCRSのフィールドが無く`pcv-core::crs`も画面まで
つながっていなかったため、`LayerInfoSection.tsx`・`StatusBar.tsx`は「CRS: 不明（未配線）」と
出していた(推測で値を出さないための措置)。

**2026-10-10に配線した。** `CloudInfo.crs`(`{ epsg?, name, kind, error? }`)を
`pcv-core`→Tauri/Web共通のDTO→`src/datasource/copc-dto.ts`→UIの順に通した。
左パネルは長い形(例「JGD2011 / 平面直角座標系 第IX系 (EPSG:6677)」)、
ステータスバーは短い形(例「EPSG:6677」)。無いときは「なし（ファイルに座標系情報が無い）」、
読めなかったときは「読み取れなかった」(本文はエラーログへ)。
詳細・確かめたこと・確かめていないこと(デスクトップ実機の手順)は
[ADR-0008](./ADR-0008-formats-and-crs.md)の「追記（2026-10-10）」にある。

## 他社製品を模倣しないことについて

所有者の指示により、レイアウトの「上部リボン+左レイヤーツリー+下部ステータスバー」
という**構成の分類**だけを参照し、具体的な製品名・ロゴ・アイコン・配色・文言は
一切使っていない。本ファイル・コード・コメントのどこにも製品名を書いていない。
配色は既存の`glass.ts`(slate/white系、ADR-0005)をそのまま使い、新しいコンポーネント
にも新しい配色を導入していない。

## 触ったファイル

**追加:**
- `src/state/useNarrowViewport.ts` — 768px未満かどうかの判定(`matchMedia`)
- `src/ui/shell/Ribbon.tsx` — 上部リボンの束ね役(狭幅ではハンバーガーメニュー)
- `src/ui/shell/RibbonFileGroup.tsx` — 「ファイル」グループ
- `src/ui/shell/RibbonViewGroup.tsx` — 「表示」グループ
- `src/ui/shell/RibbonToolsGroup.tsx` — 「ツール」グループ(未実装4種)
- `src/ui/shell/RibbonSettingsGroup.tsx` — 「設定」グループ
- `src/ui/shell/ribbon-styles.ts` — リボン共通のクラス文字列
- `src/ui/shell/LayerInfoSection.tsx` — 左パネルの「レイヤー情報」節
- `src/ui/shell/LayerStatsDetails.tsx` — 左パネルの折りたたみ式詳細統計(旧InfoPanel)
- `src/ui/shell/StatusBar.tsx` — 下部ステータスバー
- `src/ui/shell/RibbonButton.tsx` — アイコン上・ラベル下のリボンボタン
- `src/ui/shell/UrlDialog.tsx` — 「URLから開く」ダイアログ
- `src/state/useFileDrop.ts` — ドラッグ&ドロップで開く。`src/datasource/tauri.ts`に`onFilesDropped`を追加
- `package.json`/`package-lock.json` — `lucide-react`を追加
- `src/ui/shell/Dialog.tsx` / `dialog-styles.ts` / `Dialog.test.tsx` — 共通ダイアログ枠とそのテスト
- `src/ui/shell/ConversionDialog.tsx` — 変換の進捗・結果ダイアログ
- `src/ui/shell/ErrorDialog.tsx` — エラー・エラー履歴ダイアログ
- `TaskSheets/ADR-0017-ui-shell-ribbon.md` — 本ファイル

**変更:**
- `src/state/useCopcViewer.ts` — `openedFileName`(開いているファイル名)・
  `errorHistory`(dismissで消えないエラー履歴)・`recordErrorHistory`を追加
- `src/ui/shell/AppShell.tsx` — 新レイアウトへの組み替え
- `src/ui/shell/SettingsModal.tsx` — 共通`Dialog`に載せ替え(上の「リボンへ移した5項目の節を削除」と同じファイル)
- `src/ui/shell/LayerPanel.tsx` — レイヤーツリー+情報パネルとして全面書き換え、ドロワー対応
- `src/ui/shell/SettingsModal.tsx` — リボンへ移した5項目の節を削除
- `package.json` — ui-forge依存・`ui:gen`/`ui:check`スクリプトを削除
- `package-lock.json` — 上記に伴う`npm install`の反映
- `.github/workflows/ci.yml` — `ui:check`ステップを削除
- `docs/book/src/frontend/ui-shell.md` — 新レイアウトの説明に更新
- `TaskSheets/ADR-0014-ui-forge.md` — 冒頭に「廃止（本ADRで置き換え）」の注記を追加

**削除:**
- `src/ui/shell/InfoPanel.tsx` — `LayerInfoSection.tsx`/`LayerStatsDetails.tsx`へ統合
- `src/ui/shell/GpuErrorBanner.tsx` — `ErrorDialog.tsx`へ置き換え
- (追加した後に統合した)`src/ui/shell/ErrorLogDialog.tsx` — `ErrorDialog.tsx`の履歴モードに統合
- `src/ui/shell/Dock.tsx` / `Dock.generated.tsx` / `Dock.ui` / `Dock.test.tsx`

## 検証

**実行して確認済み(2026-10-09、このADRが対象とする変更をすべて適用した状態):**

```
$ npx tsc --noEmit
（出力無し、終了コード0）

$ npx eslint .
（出力無し、終了コード0）

$ npx vitest run
 Test Files  35 passed (35)
      Tests  311 passed (311)

$ npm run build
> tsc && vite build
✓ 93 modules transformed.
✓ built in 331ms

$ npx playwright test
Running 1 test using 1 worker
  ok 1 [chromium] › e2e/web-conversion.spec.ts:25:1 › LASファイルを選ぶとWeb版で変換され、内訳とダウンロードが表示される (3.3s)
  1 passed (4.2s)
```

CI invariants(規約2: `@tauri-apps/api`を`src/datasource/tauri.ts`以外からimportしていないこと)も
同じコマンドで手元で再現し、`src/datasource/tauri.ts`のみであることを確認した。

ヘッドレスChromium(Playwright、`channel: "chromium"` + `--enable-unsafe-webgpu`、
SwiftShaderソフトウェアレンダラ)で1920x1080・390x844の両サイズ、ライト/ダークの
スクリーンショットを撮り、目視した結果は本ADRのコミット時点の作業記録(報告メッセージ)に記載する。

**未確認(所有者の実機確認が必要):**

- **デスクトップアプリ(Tauri)での見た目・操作。** `npm run tauri dev`でWindows実機の
  実GPU上でリボン・左パネル・ステータスバーが正しく表示され、ファイルを開く・
  表示設定・設定モーダル・エラーログがすべて操作できること。
  確認手順: `npm run tauri dev`を実行し、COPCファイルを1つ開いて各部品を一通り操作する。
- **Android実機での見た目・操作、特に768px未満のドロワー/ハンバーガーメニュー。**
  確認手順: `npm run tauri android dev`(または所有者の既存の実機確認手順。
  `TaskSheets/M3-release-and-update.md`参照)で実機にインストールし、
  リボンがハンバーガーメニューに畳まれること、左パネルがドロワーとして開閉すること、
  各ボタン・入力が指で押しやすい大きさ(44px角)であることを確認する。
- **ガラスのfps比較(ADR-0005が要求していた「ガラスあり/なし」の実測)は、行わない。** 所有者の決定で
  ガラスのオン/オフ設定を廃止した(下記)ため、比較する対象が無くなった。参考として、
  この開発機(headed Chromium、実GPUのNVIDIA、`--disable-frame-rate-limit`)でガラスありの状態を
  マウスで回しながら測ったrAFのfpsは約286(1回の測定。上限解除時)。比較対象は無いので、これ以上の主張はしない。
- **ライト/ダーク切り替え時の、リボン・ステータスバーの可読性の実機での見た目。**
  スクリーンショットでの目視は行ったが、実機の発色(特にモバイル端末の画面)は別。
