# ADR-0017: UIシェルをリボン+レイヤーツリー+ステータスバーに再構築する

- 状態: 採択
- 日付: 2026-10-09
- 前提: [ADR-0005](./ADR-0005-ui-shell.md)（ガラスの質感、維持）、[ADR-0011](./ADR-0011-gpu-error-visibility.md)（エラーバナー、維持）
- 置き換え: [ADR-0014](./ADR-0014-ui-forge.md)（ui-forgeでのレイアウト記述。本ADRで廃止）

## 決定（所有者の判断）

1. **レイアウトをデスクトップの点群/GIS系ソフトに多い構成に変える。** 上部に
   リボン、左にレイヤーツリー、下部にステータスバー。以前は画面下部中央の
   フローティングドック+左右2枚のパネル(ADR-0005時点の構成)だった。
2. **ガラスの質感は維持する。** ADR-0005の決定(全面ビューア+浮かぶガラス面、
   ライト/ダーク別tint、設定モーダルは不透明)は変えない。モバイルプロファイル
   (`device-profile.ts`)がガラスを無効化する既定も変えない。
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
  <ErrorLogDialog />               ← 不透明なモーダル(新設)
  <UpdateNotice />
  <GpuErrorBanner />               ← z-50、最前面
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
| COPCファイル選択(Web: ファイル選択/URL入力/サンプルを開く。デスクトップ: OSのファイル選択ダイアログ) | `Ribbon`の「ファイル」グループ(`RibbonFileGroup.tsx`)。`data-testid="file-input"`はそのまま維持 |
| エラー表示(`data-testid="viewer-error"`) | `LayerPanel`の「レイヤー情報」(`LayerInfoSection.tsx`)。testidはそのまま維持 |
| 変換中の進捗+キャンセルボタン | `LayerInfoSection.tsx` |
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
| テーマ/更新確認/一時ファイル置き場所/レンダースケール/ガラス切替/点予算上限表示/OPFS保存領域/診断パネル/開発用パス直指定 | `SettingsModal.tsx`に残存(位置不変) |

### 旧 `GpuErrorBanner.tsx`

| 旧コントロール | 新しい場所 |
|---|---|
| エラー表示+個別の✕閉じる | そのまま(`GpuErrorBanner.tsx`) |
| (新設)「ログ」ボタン | `ErrorLogDialog.tsx`を開く。閉じたエラーも含めて確認できる(タスクシートの要求) |

### 新規追加

| 新しいコントロール | 場所 | 備考 |
|---|---|---|
| 未実装ツール(計測・断面・点の選択・複数レイヤー)、いずれも`disabled` | `Ribbon`の「ツール」グループ(`RibbonToolsGroup.tsx`) | タスクシートの指定どおり |
| 表示点数/予算、fps、CRS、読み込み進捗、エラーログを開くボタン | `StatusBar.tsx` | 新規 |
| セッション中の全エラー履歴(閉じても消えない) | `ErrorLogDialog.tsx` | `GpuErrorBanner`と`StatusBar`の両方から開ける |

### `point size`の対応付けについて

タスクシートの「表示」グループの指定に`point size`があるが、このコードベースには
点の大きさを数値で調整する機能が無い(`src/renderer/gpu-resources.ts`の
`POINT_SIZE_PX`は固定値で、UIから変える口が無い)。UIから唯一調整できる
「点の見た目」は点の形(丸/四角、`pointShape`)だけなので、これを`point size`の
対応先とした。新しい数値調整機能を追加することは本タスクの範囲(UIシェルの
再構築)を超えると判断し、見送った。

### CRSについて(正直に)

`LayerInfoSection.tsx`・`StatusBar.tsx`はどちらもCRSを「不明（未配線）」と表示する。
`CloudInfo`(`src/datasource/DataSource.ts`)には現時点でCRSフィールドが無く、
`crates/pcv-core/src/crs`モジュールは存在するが`CloudInfo`まで配線されていない
(`grep -rn "crs" crates/pcv-core/src/lib.rs`で`pub mod crs;`のみ確認)。推測で
値を出さず、配線されていないことをそのまま表示した。配線する場合は
`pcv-core::crs`→`CloudInfo.crs`→UIの3箇所の変更が必要になる(本タスクの範囲外)。

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
- `src/ui/shell/ErrorLogDialog.tsx` — エラー履歴ダイアログ
- `TaskSheets/ADR-0017-ui-shell-ribbon.md` — 本ファイル

**変更:**
- `src/state/useCopcViewer.ts` — `openedFileName`(開いているファイル名)・
  `errorHistory`(dismissで消えないエラー履歴)・`recordErrorHistory`を追加
- `src/ui/shell/AppShell.tsx` — 新レイアウトへの組み替え
- `src/ui/shell/GpuErrorBanner.tsx` — `onOpenErrorLog`props・「ログ」ボタンを追加
- `src/ui/shell/LayerPanel.tsx` — レイヤーツリー+情報パネルとして全面書き換え、ドロワー対応
- `src/ui/shell/SettingsModal.tsx` — リボンへ移した5項目の節を削除
- `package.json` — ui-forge依存・`ui:gen`/`ui:check`スクリプトを削除
- `package-lock.json` — 上記に伴う`npm install`の反映
- `.github/workflows/ci.yml` — `ui:check`ステップを削除
- `docs/book/src/frontend/ui-shell.md` — 新レイアウトの説明に更新
- `TaskSheets/ADR-0014-ui-forge.md` — 冒頭に「廃止（本ADRで置き換え）」の注記を追加

**削除:**
- `src/ui/shell/InfoPanel.tsx` — `LayerInfoSection.tsx`/`LayerStatsDetails.tsx`へ統合
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
- **ガラスのfpsコスト(ADR-0005が要求する実測)。** このセッションではPlaywrightの
  ヘッドレスChromiumがSwiftShader(ソフトウェアレンダラ)上で動いており、実GPUでの
  計測ではない。実機での計測手順は所有者への報告メッセージに記載する。
- **ライト/ダーク切り替え時の、リボン・ステータスバーの可読性の実機での見た目。**
  スクリーンショットでの目視は行ったが、実機の発色(特にモバイル端末の画面)は別。
