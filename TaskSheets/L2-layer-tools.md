# L2: レイヤーごとの表示、視点の移動、ツールの実装、CRS の無いファイル、変換の計測

所有者の要望（2026-10-14、L1 のあと）と、コーディネーターの決定をまとめる。並行で走らせる作業の分担と、作業間の取り決めをここに置く。

## 所有者の要望

- レイヤー欄のパディングがおかしい
- 設定: 「診断」を削除し、代わりに「読み込み優先」をリボンから設定へ移す（設定の一覧の見た目は良い、と所有者）
- 着色・見た目は**レイヤーごと**に変えたい。ボタンはレイヤー情報の下へ
- 別々の場所のファイルを開くと視点が壊れる。開いたらその点群へカメラを移し、他のレイヤーへも見に行けるようにしたい
- 削除が右クリックしないと存在すら分からない（案を求められた）
- リボンにある未実装のツール（計測・断面・点の選択・複数レイヤー）を実装する
- 変換を本当に速くしたい。数十億〜数百億点で検証してよい
- CRS の無いファイルの扱い

所有者が確認済み（2026-10-14）: リボンのドラッグ後にボタンが誤って押されない、スクロールの挙動、設定画面の見た目。

## コーディネーターの決定

### レイヤー欄の「操作」の並び（削除が見つからない問題の案）

選択中のレイヤーに対する操作を、**レイヤー情報の下に、リボンと同じアイコン＋名前のボタンの列**として常に出す:
「着色」「見た目」「移動」（そのレイヤーへカメラを移す）「削除」。
右クリック・長押しのメニューも残し、同じ項目（移動・削除）を出す。選択中に Delete キーでも削除。
理由: ボタンが常に見えていれば存在が分かる。所有者の UI の方針（操作はアイコン＋名前のボタン）とも揃う。
各行の右端に「⋯」を出す案もあるが、行が狭く、ボタンの列のほうが着色・見た目と同じ場所にまとまる。

リボンの「表示」グループ（着色・見た目・読み込み優先）は無くなる（着色・見た目はレイヤーへ、読み込み優先は設定へ）。

### レイヤーごとの「見た目」

- レイヤーごと: 着色（L1 で済み）、**点の形**、**点の大きさ**（新規。バックログにあった）
- 画面全体のまま: EDL（画面全体にかける処理なので、レイヤーごとにできない）→ 設定の一覧に「陰影（EDL）」として移す

### 視点

- レイヤーを足したら、**そのレイヤー**へカメラを移す（全レイヤーの合併ではなく）。動きは既存の視点移動のアニメーション（AN-2）
- 「移動」ボタン・行のダブルクリックで、そのレイヤーへ移る
- グリッドの高さ・大きさは、いま見ているレイヤー（最後に移動したレイヤー）に合わせる

### ツール（ADR-0018: 選んだレイヤーから新しいレイヤーを作る）

| ツール | 操作 | 結果 |
|---|---|---|
| 点の選択 | 画面上で多角形を描く（クリックで頂点、ダブルクリックか Enter で閉じる、Esc で取り消し） | 選択中のレイヤーのうち、多角形の内側に映る点（奥行きは全部）を新しい点群レイヤーにする |
| 断面 | 点群の上を2点クリックして線を引き、厚みをダイアログで決める（既定 1m） | 線に沿った鉛直の板の中の点を新しい点群レイヤーにし、カメラを板に垂直な横向きにする |
| 計測 | 距離（2点）・高さ（2点の鉛直差）・面積（多角形。水平面に投影した面積と周長） | 「計測」レイヤー（線とラベルの注記）。表示・非表示・削除できる |
| 複数レイヤー | レイヤー欄で Ctrl/Shift クリックで複数選び、ボタンを押す | 選んだ点群レイヤーを1つに結合した新しい点群レイヤー |

点群から点群を作るものは、**Rust 側で「COPC を読み、条件に合う点だけを COPC に書く」**を、数億点でもメモリが点数に比例しない形（既存の結合と同じ流し方）で行う。
デスクトップ（Tauri のコマンド）と Web（Worker・OPFS）の両方。結果は一時フォルダ（Web は OPFS）に書き、それを新しいレイヤーとして開く。

条件（Rust 側の型。座標はファイルの実座標、f64）:

```text
ScreenPolygon { view_proj: [f64; 16] (列優先), polygon_ndc: Vec<[f64; 2]> }   // 投影して多角形の内側、かつ w>0（カメラの前）
OrientedBox   { center: [f64; 3], axes: [[f64; 3]; 3] (正規直交), half_extents: [f64; 3] }
```

ノードの範囲が条件と交わらないノードは読まない（速さのため）。

点の位置を画面から取る（計測・断面の2点）は、**描いた深度を読み戻して逆投影**する（ノードの点を CPU に持たないため）。

### CRS の無いファイル（コーディネーターの判断）

CRS は今、表示（レイヤー情報・ステータスバー）と、結合のときの「全部同じ座標系か」の確認にしか使っていない。描画は座標をそのまま使うので、CRS が無くても表示に不都合は無い。
不都合は「結合のとき、本当に同じ座標系か確かめられない」ことと「結合した結果の CRS を何にするか」。

決定: **CRS の無いファイルは止めずに通し、警告をエラーログ（ADR-0011）に出す**。結果の CRS は CRS のあるファイルのものにする。
CRS のあるファイルどうしで食い違うときは、今までどおり止める。開発ツールの `--assume-missing-crs-is-first` と同じ考えを、アプリの既定にする。

## 作業の分担（並行）

| 記号 | 中身 | 主に触る |
|---|---|---|
| L2-A | レイヤー欄のパディング、レイヤー操作のボタン列（着色・見た目・削除。移動は L2-B）、リボンの表示グループの撤去、設定の診断削除・読み込み優先と陰影（EDL）の追加、Delete キー | `src/ui/shell/Layer*`・`Ribbon*`・`Settings*`・`settings-nav.ts` |
| L2-B | レイヤーごとの点の形・大きさ、足したレイヤーへのカメラ移動、`focusLayer`、見た目ダイアログの中身 | `src/renderer/`・`src/state/useCopcViewer.ts`・`ViewDialogs.tsx` の AppearanceDialog |
| L2-C | 抽出のエンジン（ScreenPolygon/OrientedBox → COPC）と、COPC の結合、CRS の無いファイルの扱い。Tauri コマンドと Web の Worker の入口まで | `crates/`・`vendor/copc-writer`・`src-tauri/`・`src/datasource/` |
| L2-D | 計測（深度の読み戻しによる点の取得、計測レイヤー、線とラベルの描画） | `src/renderer/`（新規ファイル中心）・`src/state/`・`src/ui/` に計測用の部品 |
| L2-E | 変換の遅さの計測（直さない。どの段階に何秒・何バイトの I/O か） | 計測スクリプトと記録だけ |
| L2-F | 点の選択・断面・複数レイヤーの UI（L2-C の後） | — |

L2-A と L2-B の取り決め: viewer に `focusLayer(id)`・`setLayerPointShape(id, shape)`・`setLayerPointSize(id, px)` を L2-B が作る。
L2-A はボタン列の部品（`LayerActions.tsx`）を作り、「移動」は置かない。L2-B は rebase のときに `LayerActions` があれば「移動」を足す（無ければ行のダブルクリックだけ先に入れ、後から足す）。
見た目ダイアログの中身（レイヤーごとの形・大きさ、EDL を外す）は L2-B、ダイアログを開くボタンの場所は L2-A。EDL の設定ページは L2-A。

## L2-B の記録（レイヤーごとの点の形・大きさ、レイヤーへのカメラ移動）

### 何をしたか

- renderer: `setLayerPointShape(id, shape)`・`setLayerPointSize(id, px)`・`focusLayer(id)` を追加。`resetView(layerId?)` の意味を変えた。`addLayer` は、足したレイヤーへカメラを移す。
- state（`useCopcViewer`）: `ViewerLayer` に `pointShape`・`pointSize`、`setLayerPointShape`・`setLayerPointSize`・`focusLayer` を公開。
- UI: 見た目ダイアログ（`ViewDialogs.tsx` の `AppearanceDialog`）を、選択中のレイヤーの点の形（丸/四角）・点の大きさ（1〜32px のスライダー）に変えた（対象のレイヤー名を出す）。EDL の操作はダイアログから外した（viewer の `setEdlEnabled` などは名前を変えずに残してある）。
  行のダブルクリックと、右クリック／長押しメニューの「移動」で `focusLayer`。`LayerActions.tsx` はこの時点の main に無かったので、「移動」ボタンはまだ置いていない（L2-A が入れた後に `RibbonButton` で足す）。
- 触ったファイル: `src/renderer/layer-focus.ts`（新規、行き先の計算と点の大きさの丸め。テストあり）・`gpu-resources.ts`・`point-cloud-renderer.ts`・`src/state/layers.ts`・`useCopcViewer.ts`・`src/ui/shell/ViewDialogs.tsx`・`LayerList.tsx` とそれぞれのテスト。

### 設計と理由（他の案）

- **点の大きさ・形はシェーダーを変えずに実現した。** 点の大きさは、もともとノードごとの uniform（`pointSizePx`、毎フレーム `writeBuffer` している）に入っていたので、固定値 4 の代わりに「そのノードのレイヤーの値」を入れるだけで済む。WGSL は無変更。
  L1-C の「着色のレイヤーごとのバッファ」に載せる案は、大きさをシェーダー側で別の構造体から読むことになり WGSL の変更が要るので採らなかった。
- 形は丸/四角のパイプラインが起動時から両方あるので、`drawPoints` でノードを「形 × フェード中か」の4組に分け、組ごとにパイプラインを1回だけ切り替えて描く（ノードごとに切り替えない）。描画のとき `nodeStyle(node)` でノードのキー（`<通し番号>:<ノードキー>`）からレイヤーの設定を引く。
- 点の大きさの既定値は 4px（変更前の固定値と同じ）。1〜32px に丸める（範囲は経験的な値で、実機で詰めていない）。
- renderer の `setPointShape`（全体）は残した。意味は「これから足すレイヤーの初期の形」に変わった（モバイルは四角、デスクトップは丸という端末ごとの既定を新しいレイヤーに引き継ぐため）。

### 視点

- `addLayer` したら、**そのレイヤー**（octree セルの和集合。無ければヘッダーの範囲）へ移る。最初のレイヤーだけは即時に置く（原点から数km 先へ飛ぶ動きを見せない）。2つ目以降は既存の視点移動のアニメーション（アニメーション無効なら即時）。向き（yaw/pitch）は今のまま。
- グリッドの高さ・大きさは、最後に移動したレイヤー（見えていれば）に合わせる。そのレイヤーを消したり隠したりしたら、見えているレイヤーの合併に戻す。
- `resetView(layerId?)`: 選択中のレイヤー（viewer が渡す）へ、向きも初期に戻して移る。以前は「見えている全レイヤーの合併」だったが、別々の場所のファイルでは合併が意味を成さないため。選択が無ければ最後に移動したレイヤー、それも無ければ合併。
- **別々の場所のファイルで視点が壊れた原因（推定。壊れる元のコードは再現して測っていない）:** 従来は `addLayer` が全レイヤーの合併（ノード範囲の和集合）の中心へカメラを置き、距離を合併の対角線にしていた。今回の2ファイル（autzen: EPSG:2992 の x≈6.4e5・y≈8.5e5、渋谷: EPSG:6677 の x≈-1.2e4・y≈-3.8e4）では、ヘッダーの範囲から概算して合併の対角線は約1.1e6 m。各ファイルは数km なので、画面上で1ピクセル未満になり、見えない（距離に対して小さすぎる）。座標系が異なる（単位も違う）ファイルでは、対角線が `FAR`（1e7）を超えうる。その場合は点が全部ファープレーンの外に出て何も描かれない（これは計算上の見込みで、実際に起こして確かめていない）。
  直し: 距離を常に「1レイヤーの大きさ」で決める（上の視点の仕組み）。これで合併の巨大な範囲は、カメラにもグリッドにも使われなくなった。
- near/far（`NEAR=0.01`・`FAR=1e7`）は**変えていない**。カメラ距離が1レイヤーの大きさになったので、通常の操作では足りる。ただし手でズームアウトして距離が 1e7 を超えれば、今までどおり全部クリップされる（`MAX_DISTANCE=1e9`）。EDL・空・グリッドも NEAR/FAR 定数を使っているので、動的にするのは GPU で見ながらやる別作業にした。
- 標高の着色の範囲は、今も見えている全レイヤーの合併（L1-C の決定）のまま。別々の場所のファイルでは、合併の範囲が広くなって各レイヤーの色の差が小さくなる。**未対応**（今回の範囲外）。

### 確認したこと（実行したコマンドと結果）

- `npx tsc --noEmit`: エラーなし。`npm run lint`: 警告0・エラー0（`useCallback` の依存を1つ足して解消）。
- `npx vitest run`: 51ファイル・453テスト通過（新規: `layer-focus.test.ts`、`layers.test.ts`・`ViewDialogs.test.tsx`・`LayerList.test.tsx` の追加分）。
- **実 GPU**: `GITHUB_PAGES_BUILD=true npm run build` → `vite preview`（ポート 4391、確認後に自分のプロセスだけ止めた）。ヘッドありの実 Edge（Playwright の `channel: "msedge"`、`--enable-unsafe-webgpu`）。`adapter.info` は `{"vendor":"nvidia","architecture":"lovelace"}`、`isFallbackAdapter` は null（SwiftShader ではない）。
  autzen-classified.copc.laz（オレゴン）→ tokyo-shibuya-merged-v2.copc.laz（渋谷、4.2GB を `setInputFiles` で。Web 版は COPC をそのまま開けた）の順に開いた。
  - (a) 2つ目を開くと、カメラが渋谷へ移る: 移動前 target=[637905, 851210, 2734]・distance=8064 → 移動後 target=[-12000.0, -37800.0, 121.0]・distance=5543（途中の値 target=[83821, 93274, 506]・animating=true も取れた）。
  - (b) 行のダブルクリックで autzen へ戻る: target=[637905.545, 851209.905, 2733.895]・distance=8063.58（最初に開いた直後と完全に一致）。右クリックメニューの「移動」でも同じ値に戻った。2つ目の行のダブルクリックでも渋谷の値に戻った。
  - (c) 1つ目を選んで見た目ダイアログで 12px・四角にすると、その場で1つ目の点だけが大きな四角になった。2つ目（渋谷）は既定のまま小さい点のまま。
  - ブラウザのコンソールに error / warn / panic は出なかった（`LOGS []`）。
- スクショ（scratchpad: `l2b-*.png`）を自分で開いて見た所見:
  - `l2b-1-first.png`: autzen が画面中央に収まり、グリッドが点群の足元にある。
  - `l2b-2b-second.png`: 渋谷が画面中央に収まり、グリッドもその下。レイヤー情報は渋谷（EPSG:6677）。autzen が一緒に映り込むことはない。
  - `l2b-4b/4c`: 点が12pxの四角で、ブロック状に大きく見える。見た目ダイアログに対象レイヤー名・丸/四角・12pxのスライダーが出ており、EDLの項目は無い。
  - `l2b-5-second-default.png`: 渋谷は2b と同じ見た目（点の大きさ・形が autzen の変更に影響されていない）。
  - `l2b-6a-context-menu.png`: メニューに「移動」「削除」の2項目。

### 確かめていないこと

- 数億点規模での描画負荷（点の形ごとに組分けする処理の追加コストは測っていない。ノードあたりの `nodeStyle` 呼び出しが2回増えただけ）。
- デスクトップ（Tauri）版・モバイル（renderScale≠1）での見た目。`renderScale` を掛ける式は変えていない（既定の大きさ4に対して従来と同じ）。
- 3つ以上のレイヤー、非表示のレイヤーへの `focusLayer`、アニメーション無効のときの即時移動は、コードの上だけで画面では確かめていない。
- 「移動」ボタン（`LayerActions.tsx`）は未実装（上記）。

### 所有者が自分で確かめる手順

1. 離れた2つの COPC（例: autzen と渋谷）を続けて開く → 2つ目を開いた瞬間にカメラが2つ目へ飛ぶ。
2. レイヤー欄の1つ目の行をダブルクリック → 1つ目へ戻る。右クリックのメニューの「移動」でも同じ。
3. 1つ目を選び、「見た目」で大きさ・形を変える → 1つ目の点だけが変わる。2つ目へ移動して、2つ目は変わっていないこと。
4. 「リセット」（全体を表示）→ 選択中のレイヤーが収まる位置・向きに戻る。

## L2-A の記録（レイヤー欄の整え、操作ボタン列、リボンの表示グループ撤去、設定の整理）

### 何をしたか
1. **レイヤー欄のパディング**: 選択中の行だけ `border-l-[3px]` が付いて、選択していない行より文字・チェックが3pxずれていた。全行に `border-l-[3px]` を付け、非選択は `border-l-transparent` にした。見出し（`レイヤー`・`レイヤー情報`）も左線を3pxにし、レイヤー情報の本文は `pl-[11px]`（3px+行の px-2=8px）で行の文字と揃えた。
2. **`LayerActions.tsx`（新規）**: レイヤー情報の下に `RibbonButton` で「着色」「見た目」「削除」。レイヤーが無いと全部無効。L2-B の `focusLayer` を呼ぶ「移動」も追加（並びは着色・見た目・移動・削除）。ダイアログ（着色・見た目）の開閉はここが持ち、パネルが transform を持つため `document.body` へ portal で出す。「移動」は置いていない（L2-B が足す）。
3. **Delete キー**: 判定は純粋関数 `layer-delete-key.ts`（入力欄・テキストエリア・選択欄・編集可能要素にフォーカスがあるとき、修飾キーつきは消さない）。右クリック・長押しのメニューは残した。
4. **リボンの「表示」グループ撤去**（`RibbonViewGroup.tsx` 削除、`Ribbon.tsx` からダイアログ状態も除去）。
5. **設定**: 「診断」を削除（`DiagnosticsDialog`、そこでしか使われていなかった `IpcBenchPanel`・`NodeConcurrencyBenchPanel`・`WebGpuProbePanel` も削除。datasource 側の計測 API は残してある）。「読み込み優先」（`LoadPriorityDialog` を `ViewDialogs.tsx` から `SettingsPages.tsx` へ移動）と「陰影（EDL）」（`EdlDialog`。viewer に強さの setter が無いのでオン/オフだけ）を専用ページに追加。`settings-nav.ts`・テスト更新。
6. **所有者の追加要望（2026-10-15）**: ダイアログの暗幕を全部ぼかしに統一（`backdrop` プロパティ廃止。モバイルは薄い半透明）。「戻る」があるダイアログから「閉じる」を外した。詳細は ADR-0017 の追記。
7. 閉じる・戻るは灰色（`DIALOG_TERTIARY_BUTTON_CLASS`）のまま。E2E の data-testid は触っていない。

### 他の案
- 各行の右端に「⋯」: 行が狭いため見送り（コーディネーターの決定どおりボタン列）。
- ダイアログの状態を AppShell に置く: ボタンと同じ場所（LayerActions）に閉じたほうが追いやすい。portal で fixed の基準ずれも避けられる。
- EDL の強さのスライダー: viewer に setter が無く、renderer（L2-B の領分）に手を入れることになるため、オン/オフだけ。

### 触ったファイル
`src/ui/shell/`: `LayerActions.tsx`(+test)、`layer-delete-key.ts`(+test)、`LayerList.tsx`、`LayerPanel.tsx`、`LayerInfoSection.tsx`、`Ribbon.tsx`、`RibbonViewGroup.tsx`(削除)、`SettingsModal.tsx`、`SettingsPages.tsx`(+test)、`settings-nav.ts`(+test)、`ViewDialogs.tsx`(+test)、`Dialog.tsx`(+test)。`src/ui/` の3つの診断パネル（削除）。

### 確認したこと（実行した結果）
- `npx tsc --noEmit`: エラーなし。`npm run lint`: エラーなし。`npx vitest run`: 52ファイル・452テスト合格。
- `PCV_E2E_PORT=4871 npx playwright test`: 2 passed（ぼかし統一前に1回、L2-B との rebase 後（移動ボタン追加後）にもう1回、どちらも 2 passed）。
- 実 Edge（headed、adapter.info は vendor=nvidia, architecture=lovelace。SwiftShader ではない）で `autzen-classified.copc.laz` を2回開き、スクリーンショット `l2a-1-layers.png`（レイヤー欄）・`l2a-2-color-dialog.png`・`l2a-3-settings.png`・`l2a-4-edl.png`・`l2a-5-loadpriority.png` を自分で見た。行の実測: 2行とも高さ44px、チェックX=40px、文字X=68px で、選択・非選択で同じ。Delete キーで2→1行、削除ボタンで1→0行になった。
- 所見: 行とチェック・見出し・レイヤー情報の左端が揃った。ボタン列は情報の下、「詳細統計」の上に3つ並ぶ。設定の一覧は9項目（診断なし、読み込み優先・陰影（EDL）あり）。ダイアログの後ろはぼけ、暗くなりすぎない。専用ページのフッターは「戻る」のみ。

### 確認していないこと
- モバイル（glassEnabled=false）でぼかしが薄い半透明に落ちる実機確認。ぼかしの開閉アニメーションの滑らかさ。Tauri・Android 実機。Chrome（Edge のみ使用）。
- 見た目ダイアログの中身（L2-B が変更）。

### 所有者の確認手順
点群を2つ開く → レイヤー欄の行の文字位置が選択で動かないこと、見出しと揃うことを見る → 行を選んで「着色」「見た目」「削除」と Delete キーを試す（レイヤーが無いとボタンがグレー）→ 設定を開き、診断が無く、読み込み優先・陰影（EDL）があること、専用ページに「戻る」だけがあること、後ろがぼけることを見る。

## L2-D record: measurement (distance, height, area)

### What was done

- **Picking** (screen point -> 3D point): the node points are not kept on the CPU, so the drawn depth is read back from the GPU and unprojected.
  The same steps work with EDL on (point-cloud-only offscreen depth) and off (swap-chain depth; sky and grid do not write depth).
  Clicking the background shows "点がありません" and does nothing. Unprojection is done in f64 (the rule of `mat4.ts`).
- **Measurements**: distance (3D distance, with horizontal distance and height difference), height (vertical difference, drawn as a solid vertical line plus a dashed horizontal line),
  area (area and perimeter projected onto the horizontal plane; shoelace formula computed after subtracting the centroid).
  "Horizontal/vertical" follows the camera up axis (default Z).
- **Measurement layer**: a finished measurement becomes a new layer (a `ViewerLayer` with `measurement`) in the list, as ADR-0018 says, and becomes the selection.
  It can be shown, hidden and deleted. Coloring is disabled (`setLayerColorModeInList` ignores measurement layers, and the viewer returns early).
  It has no DataSource file (`cloudId = -1`; `close` is not called on delete).
- **UI**: three buttons "距離", "高さ", "面積" in the ribbon "Tools" group (owner decision: split the buttons once implemented). The active button has an underline.
  A guide at the bottom of the screen (`MeasureHud`: what is measured, the next action, "閉じる" and "やめる"). To stop: Esc, pressing the button again, or "やめる".
  Area: click vertices, then close with double click, Enter or "閉じる". The buttons are disabled when there is no point cloud.

### Decisions and rejected alternatives

- **Read the depth in two stages** (top of `pick-math.ts`). The projection is NEAR=0.01, FAR=1e7 and a 24-bit depth is coarse far away
  (one step = z^2/NEAR * 2^-24 by the formula; about 380 ft at z about 8000, the viewing distance of autzen). Unprojecting the stage-1 depth alone gave points such as elevation 1302
  on a real machine (the data is 406 to 615). So stage 1 gets a distance z, then only the 5x5 pixels around the clicked pixel are redrawn with a narrow projection whose near/far are z/2 to 2z, and that depth is read
  (about 1 mm resolution even at z about 8000).
  Rejected: switching depth to depth32float or reverse-z (affects every pipeline, EDL, sky and grid, and collides with L2-B).
- **Why the margin is a wide z/2 to 2z**: first it was "4 coarse steps", but on a real machine the stage-1 distance was off by about 3x the theoretical quantization error (about 14%),
  so the point fell outside the range and was not hit. **The cause of the offset is not identified.** The resolution stays sufficient with a wide margin, so a proportional margin avoids it (root cause still open).
- **Depth read-back**: depth24plus cannot be copied with `copyTextureToBuffer`, so a tiny compute shader `textureLoad`s it into a storage buffer which is then read (`depth-pick.ts`).
  `TEXTURE_BINDING` was added to the EDL-off depth texture (one line in `gpu-resources.ts`). The window is at most 9x9, which tolerates gaps of a few pixels between points.
- **Lines and labels are a DOM SVG overlay** (`MeasureOverlay.tsx`), without adding a WebGPU pipeline. Reason: labels (numbers) need the DOM, and drawing only lines with WebGPU would make two systems.
  A measurement has a few lines, and projecting again each frame is cheap. It also barely touches the renderer (L2-B was working there).
  Drawback: lines are not hidden by the point cloud (always on top). Lines crossing behind the camera are cut at the near plane before projection (`screen-project.ts`).
  While the camera is still, viewProj does not change, so nothing is re-rendered.
- **Click vs drag**: remember the canvas pointerdown position and treat it as a click only if it moved 5 px or less by `click`. Canvas events are not stopped
  (we only listen alongside orbit-camera.ts). Only `dblclick` is stopped (in the capture phase, so closing an area does not also trigger the fly-to).
  A double click delivers two clicks, so the second (`detail >= 2`) is ignored. Picking is asynchronous, so work is chained on a single Promise and runs in order.
- **Units**: the CRS has no unit field, so decide from the name (`lengthUnitLabel`). Name contains ft/feet/foot/US survey -> "ft"; Japanese plane rectangular and UTM -> "m";
  unknown, no CRS or unreadable -> "座標の単位" (never assert m, because a foot-based file would be 30% off without anyone noticing). Area is "ft²" or "座標の単位²".
  A measurement layer inherits the CRS of the source point-cloud layer (the selection if it is a point cloud, otherwise the first point-cloud layer).
- The layer kind is expressed by `ViewerLayer.measurement?` (measurement if present) rather than a `kind` enum, because L2-A and L2-B touch the same type and a new required field would conflict.

### Files touched

New: `src/renderer/pick-math.ts`, `depth-pick.ts`, `screen-project.ts`, `src/state/measure.ts`, `useMeasureTool.ts`, `src/ui/MeasureOverlay.tsx` (each with a `.test.ts` except the UI and the hook).
Changed: `src/renderer/gpu-resources.ts` (one line for the depth texture usage, `readDepthWindow` and `renderDepthWindow`), `point-cloud-renderer.ts` (`pickPoint`, `getViewSnapshot`, keeping the view matrix and draw options),
`src/state/layers.ts`, `useCopcViewer.ts`, `src/ui/shell/Ribbon.tsx`, `RibbonToolsGroup.tsx`, `AppShell.tsx`.

### What was verified (actually run)

- `npx tsc --noEmit`, `npm run lint` and `npx vitest run` pass (counts are in the report).
- Real GPU: headed Edge (NVIDIA, adapter vendor=nvidia / lovelace, not SwiftShader), vite dev server, opened `autzen-classified.copc.laz`, and measured one distance, one height and one area
  with EDL on and off. The results were identical (distance 3,537.98 ft, horizontal 3,537.97 ft, height difference 7.85 ft; height 20.19 ft; area 2,810,323 ft^2, perimeter 7,222 ft).
  The elevations of the area vertices are 462 to 588 (inside the data range 406 to 615). Clicking the background shows "点がありません". Esc ends measuring.
  The measurement layer checkbox toggles visibility (the label disappears) and the context-menu delete removes it from the list. Screenshots are `l2d-*.png` in the scratchpad.
- Whether the values are "correct" was judged by eye; they were not compared with surveyed ground values. Verified only that distances and areas follow the formulas from the picked positions (unit tests) and that elevations are in range.

### Not verified, and how the owner can check

- Touch: the touch double tap runs its own fly-to in orbit-camera.ts (a separate path from dblclick), so on touch use the "閉じる" button to close an area. Not verified.
- Web build (GitHub Pages), Android and the Tauri build. Only the vite dev server in Edge was checked.
- Accuracy in sparse areas and at very far views (z > 1e5). The cause of the stage-1 distance offset (above).
- Steps: open a file -> press "距離" in the ribbon "Tools" -> click the point cloud twice -> a label appears on screen and "距離 1" appears in the layer list.
  For "面積", click three or more vertices, then double click (or Enter, or "閉じる"). Stop with Esc or by pressing the button again. Also check that dragging moves the camera and that clicking the background shows "点がありません".



## L2-C record: extraction engine, COPC merge, files without a CRS

### What was done

- **Extraction engine** ("read a COPC, write only the matching points into a new COPC"). No new octree/writer code.
  - Read side: `crates/pcv-core/src/extract.rs` (`ExtractFilter` = `ScreenPolygon` | `OrientedBox`, iterator `ExtractPoints`). It builds for wasm32 and has no Tauri dependency. It reads only the nodes whose bounds may intersect the condition (conservative culling: any corner behind the camera -> read; screen polygon = NDC bounding-rectangle overlap; oriented box = separating axes of the 3 box axes + 3 world axes), holds one node of points at a time, and yields the points that pass the exact per-point test.
  - Desktop write side: `crates/pcv-convert/src/extract.rs` (`extract_path_and_timings`) hands the iterator to `write_streaming_with_cancel_and_timings` (same as `merge.rs`).
  - Web write side: `crates/pcv-wasm/src/extract.rs` (`WasmExtractor`: `feed` in small batches, then `finish`), same `SpillWriter` -> `write_copc_from_spill_with_fs_and_timings` on OPFS as the Web conversion.
  - Zero points -> error "選んだ範囲に点がありません" before anything is written (the first point is taken before the writer starts). Attributes (RGB, intensity, classification, GPS time, ...) are carried over (`LasPointRecord::from_las_point`); tested.
  - The node callback (`set_node_callback`) gives per-node progress and a cancellation check during the scan (when few points match, the writer receives nothing for a long time).
- **COPC merge**: the existing `merge.rs` already accepts COPC inputs (`las::Reader` reads COPC as LAZ). No change needed; tested (`merge_accepts_copc_inputs`). Web reuses `runMultiConversion` through a new `toolMergeStart` request.
- **Files without a CRS**: `merge::summarize_headers_lenient` (desktop) and `check_layout_and_crs_match` -> `CrsOutcome` (Web). A file without a CRS never stops the merge; the result CRS is taken from the first file that has one (even if it is not the first file); files that both have a CRS and differ still stop (`CrsMismatch`). Warnings (one per file) go back to the caller: `HeaderSummary::crs_warnings()` -> `ConversionDoneEvent.warnings` (desktop, also for the M4-14 multi-file selection) and `FinishResultDto.warnings` -> `convert-done.warnings` (Web). The dev CLI keeps its old strict / `--assume-missing-crs-is-first` behaviour.

### Final API (TypeScript, `src/datasource/tools.ts` types)

```ts
type ExtractFilter =
  | { kind: "screenPolygon"; viewProj: number[16] /* column-major, world(file coords) -> clip */; polygonNdc: [number, number][] }
  | { kind: "orientedBox"; center: [n,n,n]; axes: [[n,n,n],[n,n,n],[n,n,n]]; halfExtents: [n,n,n] };
interface ToolResult { outputPath: string; pointCount: number; warnings: string[] }
interface ToolOptions { onProgress?: (p: { pointsRead: number; totalPoints: number }) => void; tempDir?: string | null /* desktop only */ }
const EMPTY_SELECTION_MESSAGE = "選んだ範囲に点がありません";

// Desktop: src/datasource/tauri.ts (free functions)
extractToCopc(path: string, filter: ExtractFilter, options?: ToolOptions): Promise<ToolResult>
mergeCopcs(paths: string[], options?: ToolOptions): Promise<ToolResult>
// Web: methods of WebSource in src/datasource/web.ts (same names / shapes; paths are registered file keys "file:N";
//      mergeCopcs options also take isMobile?: boolean)
source.extractToCopc(path, filter, options?)
source.mergeCopcs(paths, options?)
```

- `path` / `paths` are the strings that were passed to `open()` for those layers (desktop: file path; Web: registered key). `outputPath` can be passed to `open()` as is (desktop: a file under `<temp>/pcv-tools/`; Web: a newly registered key for a file on OPFS).
- Failure = a rejected promise with the text on screen (zero points: `EMPTY_SELECTION_MESSAGE`; cancelled: desktop "キャンセルされた" / Web "キャンセルされました"). Warnings are in `result.warnings` and should be put in the error log (ADR-0011) by the caller.
- Progress: desktop reuses the `conversion-progress` event (so the app-wide conversion listener also sees it; the UI that calls the tool decides what to show), Web gets `tool-progress` only through `onProgress`. Cancel: desktop `cancelLasConversion()`, Web `source.cancelConversion()`. One tool or conversion at a time (desktop returns an error if one is already running).
- Desktop done/failed events are NOT emitted for tools (the result is the return value); `onConversionDone` gained a 4th argument `warnings: string[]` (merge of M4-14 fills it); Web `onConvertDone` gained a 5th argument `warnings`.
- Tauri commands: `extract_copc(path, filter, tempDir)` and `merge_copcs(paths, tempDir)` in `src-tauri/src/conversion.rs`; panics are caught at the entry (`catch_unwind`, ADR-0015) and returned as `Err`. Web: worker requests `extractStart` / `toolMergeStart`, responses `tool-progress` / `tool-done` / `tool-failed`; the worker rewrites the merge's `convert-*` messages to `tool-*` at one choke point (`translateForTool` in `copc.worker.ts`) so the result is not opened by the app-wide conversion handler. Web outputs get a sidecar (`opfs.writeToolOutputMeta`) so they show up in the OPFS usage breakdown.

### Alternatives not taken

- Collect matching points in a `Vec`, then write: memory would grow with the selection (hundreds of millions of points).
- Exact polygon-vs-box culling (convex hull of the projected corners): not needed for correctness; the coarse rectangle test only reads a few more nodes.
- Reusing `convert-*` messages for tools on Web: the app-wide listener would open every tool result as a converted file.
- Android `content://` inputs: unsupported (same limit as the M4-14 merge); a clear error is returned.

### Files touched

`crates/pcv-core/src/{extract.rs,lib.rs,copc.rs}`, `crates/pcv-core/Cargo.toml` (serde), `crates/pcv-convert/src/{extract.rs,merge.rs,lib.rs}`, `crates/pcv-convert/examples/extract_copc.rs`, `crates/pcv-convert/Cargo.toml`, `crates/pcv-wasm/src/{extract.rs,convert.rs,dto.rs,lib.rs,pcd_import.rs}`, `crates/pcv-wasm/Cargo.toml`, `src/wasm/pcv-wasm/*` (regenerated), `src-tauri/src/{conversion.rs,lib.rs}`, `src/datasource/{tools.ts,tauri.ts,web.ts,web-protocol.ts,web-protocol.test.ts,copc.worker.ts,opfs.ts}`.

### Measured (commands and outputs from this session)

Machine state: **L2-E's `merge_las_to_copc.exe` was running at the same time for the whole session** (so all times are with a competing heavy process). Memory is "private memory" polled every 100 ms from outside (`measure.ps1`, max of `PrivateMemorySize64`).

- `cargo test -p pcv-core -p pcv-convert`: all pass (11 new tests in `extract` including: attributes kept, node skipping, zero points, memory bound `buffer_is_bounded_by_largest_node` (8000 points / 500 per node: max held = largest node), progress, cancel during scan, non-COPC input, screen polygon, COPC merge; 2 new in `merge` for lenient CRS). `cargo test` for pcv-wasm (38 + integration) and pcv-tauri (16) pass; `cargo clippy -p pcv-tauri -p pcv-convert -p pcv-core --all-targets` clean; `cargo clippy --manifest-path crates/pcv-wasm/Cargo.toml --target wasm32-unknown-unknown --all-targets -- -D warnings` clean; `cargo build -p pcv-core --target wasm32-unknown-unknown` OK; `npm run build:wasm` OK; `npx tsc --noEmit`, `npm run lint`, `npx vitest run` (444 tests) pass.
- `autzen-classified.copc.laz` (10,653,336 points), box x 636500..637500, y 850000..851500, all z: **1,156,505 points out, 47 of 278 nodes read (2,075,794 points scanned, max 70,734 held), 1.58 s, private memory max 30.4 MiB**, output 10,007,553 bytes.
- `tokyo-shibuya-merged-v2.copc.laz` (347,797,138 points), box x -13000..-11000, y -38500..-37000, z -10..300: **154,661,111 points out, 2943 of 6462 nodes read (169,462,858 points scanned, max 100,000 held), 421.4 s, private memory max 274.3 MiB** (versus roughly 154.7M x ~40 bytes = ~6 GB if all points were held), output 2,107,238,455 bytes. Breakdown: read+decode 194.4 s, spill write 18.7 s, LOD index 147.7 s, node compression 41.6 s. The sampled **working set reached 9,577 MiB**; this is page cache of the memory-mapped spill / LOD files (copc-writer's `memmap2`), not private memory (not investigated further: **unverified** explanation). The output file was deleted after the run.

### Not verified

- The Web path (`WasmExtractor`, worker `extractStart` / `toolMergeStart`, `WebSource.extractToCopc` / `mergeCopcs`) was **not run in a browser**; only compiled, linted and unit-tested (message builders). The `serde_wasm_bindgen` decoding of the internally tagged `ExtractFilter` enum on the wasm side is untested.
- Tauri commands were not invoked from the running app (only compiled / clippy). Progress events from a tool will also drive the existing conversion progress UI (not checked).
- Android (`content://`) is unsupported; no device check.
- Time numbers above are under load from another process; do not read them as the engine's speed.

### How the owner can check

1. `cargo run -p pcv-convert --release --example extract_copc -- data/autzen-classified.copc.laz out.copc.laz 636500 850000 0 637500 851500 1000` then open `out.copc.laz` in the viewer (delete it afterwards). Run it without the box arguments to print a file's bounds.
2. Call `extractToCopc` / `mergeCopcs` from the browser devtools or the L2-F UI once it exists; for Web check that OPFS usage (Settings) lists "抽出: ..." / "結合: ..." entries and that they can be deleted.
