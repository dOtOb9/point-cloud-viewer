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
- **Units (revised 2026-10-15, owner request: always show meters by default)**. The earlier guess from the CRS name was replaced. Rust now reads the real unit factors from the WKT
  (`crates/pcv-core/src/crs/describe.rs`: `horizontal_unit_to_meter` from the `UNIT[...]` directly inside `PROJCS[`, ignoring the GEOGCS degree unit; `vertical_unit_to_meter` from `VERT_CS[`),
  carried in `CrsInfo` and both DTOs (`CrsInfoDto`, snake_case) to `CrsInfo.horizontalUnitToMeter` / `verticalUnitToMeter` in TypeScript. Recognized systems (JGD plane rectangular, UTM) are metric by definition (1.0).
  **Horizontal and vertical units can differ**: the real autzen WKT has horizontal international foot 0.3048 and vertical US survey foot 0.304800609601219 (tested with that exact WKT). So each quantity is
  converted with the factor of its axis: horizontal distance, area and perimeter with the horizontal factor, height with the vertical factor, and the 3D distance as hypot of the two converted parts (`units.ts`).
  If the WKT has no vertical CS the vertical unit is assumed equal to the horizontal one (an assumption, recorded here). WKT2 (`PROJCRS[`) and GeoTIFF-key-only files give no factor (unknown), because guessing would be worse.
  Unknown factor: never converted; the raw number is shown with "座標の単位（m かどうか不明）".
  A measurement layer inherits the CRS (so the factors) of the source point-cloud layer (the selection if it is a point cloud, otherwise the first point-cloud layer).
- **Display unit setting**: a "単位" button in the settings list opens a page with radios "メートル" (default) and "フィート" (international foot, exactly 0.3048 m). It is stored in localStorage
  (every read and write in try/catch) by a tiny module-level store (`useDisplayUnit.ts`, `useSyncExternalStore`) so the settings page, the measurement overlay and the layer info read it without prop threading.
  It switches the measurement results and the bounding box in the layer info (coordinates are converted from the file unit to meters, then to the chosen unit; x/y use the horizontal factor and z the vertical one).
  Conversion and formatting are pure functions with unit tests (`units.ts`, `units.test.ts`). The page footer is only "戻る" (L2-A rule). wasm was regenerated for the new DTO fields.
- The layer kind is expressed by `ViewerLayer.measurement?` (measurement if present) rather than a `kind` enum, because L2-A and L2-B touch the same type and a new required field would conflict.

### Files touched

New: `src/renderer/pick-math.ts`, `depth-pick.ts`, `screen-project.ts`, `src/state/measure.ts`, `useMeasureTool.ts`, `src/ui/MeasureOverlay.tsx` (each with a `.test.ts` except the UI and the hook).
Changed: `src/renderer/gpu-resources.ts` (one line for the depth texture usage, `readDepthWindow` and `renderDepthWindow`), `point-cloud-renderer.ts` (`pickPoint`, `getViewSnapshot`, keeping the view matrix and draw options),
`src/state/layers.ts`, `useCopcViewer.ts`, `src/ui/shell/Ribbon.tsx`, `RibbonToolsGroup.tsx`, `AppShell.tsx`.

### What was verified (actually run)

- `npx tsc --noEmit`, `npm run lint` and `npx vitest run` pass (counts are in the report).
- Real GPU: headed Edge (NVIDIA, adapter vendor=nvidia / lovelace, not SwiftShader), vite dev server, opened `autzen-classified.copc.laz`, and measured one distance, one height and one area
  with EDL on and off. The results were identical (distance 3,537.98 ft, horizontal 3,537.97 ft, height difference 7.85 ft; height 20.19 ft; area 2,810,323 ft^2, perimeter 7,222 ft).
  After the unit change (default meters): distance 1,078.38 m (horizontal 1,078.37 m, height difference 2.39 m), height 6.15 m, area 261,087.58 m², perimeter 2,201.33 m; the layer-info bounding box
  became min=[193,724.11, 258,739.28, 123.79] / max=[194,768.34, 260,158.28, 187.53] m (width 1,044.2 m = 3,426 ft). Switching the setting to feet gave the earlier ft values (3,537.98 ft, 20.19 ft,
  2,810,323.35 ft²; bounding box back to 635,577.79 ... 615.26 ft), and back to meters restored the m values (screenshots `l2d-units-meter.png`, `l2d-units-foot.png`).
  The elevations of the area vertices are 462 to 588 ft (inside the data range 406 to 615 ft). Clicking the background shows "点がありません". Esc ends measuring.
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

## L2-F record: point selection, cross section, multi-layer UI, per-layer elevation range

### What was done

- **Point selection** (ribbon "点の選択"): click vertices on the 3D view, close with double click / Enter / the "閉じる" button, cancel with Esc / "やめる". Dragging is still the camera. The polygon is drawn as an SVG over the view (`LayerToolOverlay.tsx`). On close it calls `viewer.extractFromLayer(selectedLayerId, {kind:"screenPolygon", viewProj, polygonNdc}, "選択")`.
  - **viewProj needed no new "f64 outlet"**: `PointCloudRenderer.getViewSnapshot().viewProj` is already `proj * view` in f64 over the file's real coordinates. The rendering origin shift is applied per node in f32 (node-local positions), and never enters this matrix. So it is sent to Rust as it is. Unit test (`tool-math.test.ts`): with autzen-like coordinates (x about 6.4e5, y about 8.5e5) the look-at target projects to NDC (0, 0) within 1e-6, right/up offsets get the right signs, and a point behind the camera is null.
  - **The polygon is thrown away when the camera moves** while it is being drawn (compared with the viewProj of the first vertex, polled every frame; also checked at close). Reason: the vertices are screen pixels, so a moved camera would send a polygon that no longer sits on the same points. Alternative not taken: converting each vertex with its own viewProj (not a polygon any more).
- **Cross section** (ribbon "断面"): two clicks on the cloud (L2-D `pickPoint`), then a dialog ("断面を作る"): thickness (default 1, total width, split on both sides) and height range (default: the whole height range of the layer). The slab is `{kind:"orientedBox"}` with axes [along the line, horizontal normal, up]; only the horizontal part of the two picks defines the line (`sectionBox` in `tool-math.ts`). Both points on one vertical line -> a notice. After the result opens, the camera goes to it at pitch 0 looking at the face of the slab (`focusLayer(id, {yaw, pitch: 0})`; yaw from `sectionYaw`, tested against `OrbitCamera.eye()`).
  - **Units follow the L2-D "単位" setting**: values are typed in the display unit (m by default, or ft) and converted to the file's unit with the CRS factors (`displayLengthToFile`; horizontal factor for thickness, vertical for the height range). If the file's unit is unknown the numbers are taken as the file's unit and the dialog says "座標の単位（m かどうか不明）".
- **Multiple layers**: Ctrl/Cmd click toggles, Shift click selects the range between the primary and the clicked row; a plain click selects just one. `selectedLayerId` stays the **primary = the one chosen last**; the action buttons (着色/見た目/移動/削除) and the Delete key act on it only. The other selected rows have a lighter version of the selected look. The extra list (`layer-selection.ts`) is only trusted while it contains the primary, so a plain click, an open or a delete need no reset. Ribbon "複数レイヤー" is disabled unless two or more point-cloud layers are selected (measurement layers are ignored) and calls `viewer.mergeSelectedLayers()` (`mergeCopcs(paths)`). Touch has no Ctrl/Shift, so merging is **not reachable on touch** yet (not addressed).
- **Results are new layers** (`openToolOutput` = shared `addOpenedLayer`, the tail of `openFile` moved out unchanged): names "選択 - <name>", "断面 - <name>", "結合 (N)". `ViewerLayer.sourcePath` (the string given to `open()`) was added so a tool can pass it to Rust; measurement layers have none. Progress: a new `ToolProgressDialog` (title, points read / total, cancel). **The desktop tool progress rides on the existing `conversion-progress` event, so the conversion listener now ignores it while a tool runs** (`toolRunningRef`); the conversion dialog opens only on `status === "converting"`, which tools never set, so it cannot open by mistake (unit-level reasoning; **not run on desktop**). Failures and `warnings` go to the existing error log with a new source "tool" ("点群ツール") and open the error dialog with the text as it is (zero points: "選んだ範囲に点がありません"). Cancel: Web `cancelConversion()`, desktop `cancelLasConversion()`. One tool at a time (the ribbon buttons are disabled while one runs).
- **Elevation color range per layer** (L2-B's open item): each layer's own z range (`layer.elevationRange`) instead of the union of all visible layers. Reason: with layers far apart the union is wide and every layer's color differences vanish. Cost: two adjacent tiles opened as separate layers get different color scales at the seam; merging them into one layer fixes it.
- No unimplemented tool button remains in the ribbon. Measurement (L2-D) and the three tools are mutually exclusive on the 3D view: starting one stops the others (`AppShell.tsx`).
- **Coordinator's small fixes to L2-D**: a measurement layer's layer info now shows the kind and the values (the same lines as the label, in the display unit) instead of point count / CRS / bounding box; "着色" and "見た目" are disabled for a measurement layer ("移動" moves to the box around the measured points via the new `PointCloudRenderer.focusBox`, "削除" works); labels that would overlap on screen are moved down (`labelShifts`). Each label was already at the middle of its own line (distance: midpoint, height: middle of the vertical line, area: vertex average).

### Alternatives not taken

- Sharing the click handling with `useMeasureTool.ts`: it is written again in `useLayerTool.ts` (with a comment) to leave the finished measurement tool untouched. They could be merged later.
- Opening a tool result through `openFile`: on desktop that goes through `start_las_conversion` and sets conversion UI state. A direct `open()` is simpler.
- Showing the tool progress in the conversion dialog: that dialog is about conversion results (breakdown, download), so a separate small dialog is clearer.

### Files touched

New: `src/state/{tool-math,layer-selection,useLayerTool}.ts` (+ tests for the first two), `src/ui/LayerToolOverlay.tsx`, `src/ui/shell/ToolDialogs.tsx`.
Changed: `src/state/{useCopcViewer,layers}.ts`, `src/renderer/{point-cloud-renderer,screen-project,gpu-error-log}.ts`, `src/ui/MeasureOverlay.tsx`, `src/ui/shell/{AppShell,Ribbon,RibbonToolsGroup,LayerList,LayerActions,LayerInfoSection,ErrorDialog}.tsx` and tests.

### What was verified (actually run)

- `npx tsc --noEmit`, `npm run lint`, `npx vitest run` pass (see the report for counts). `PCV_E2E_PORT=4893 npx playwright test`: 2 passed.
- **Web path in a real browser** (headed Edge, `adapter.info` = vendor nvidia / lovelace, not SwiftShader; vite dev server; `autzen-classified.copc.laz`, 10,653,336 points). This is the first time L2-C's Web path ran in a browser: `serde_wasm_bindgen` reads `ExtractFilter` (both kinds) without problems.
  - Point selection: polygon of 4 vertices -> progress dialog ("5,592,337 / 5,592,337" read in one run; the 3,123,595-point result appeared about 40 s later) -> a new layer "選択 - autzen-classified.copc.laz" with **3,123,595 points**; hiding the original left only the selected part (a rectangle-shaped piece of the cloud). The result is larger than the polygon looks because the view is oblique and depth is not limited (trees behind the polygon on the same rays are included, as designed).
  - Cross section: 2 picks -> dialog (thickness 1 m, height 123.79 to 187.53 m = the layer's range in m) -> "断面 - ..." with **8,897 points**; the camera went to yaw -2.906, pitch 0 and the screenshot shows a thin side profile (ground, a mound, trees). A second section gave 2,470 points.
  - Merge (small): sections 8,897 + 2,470 -> "結合 (2)" with **11,367 points** (exact sum). Selection 3,123,595 + section of it 2,925 -> **3,126,520 points** (exact sum). The merge button is disabled with one layer selected and enabled with two (Ctrl or Shift click).
  - **Merge of autzen with another layer FAILED on Web**: autzen (10,653,336) + a small layer in a persistent Edge profile (storage quota 10,240 MiB) -> panic `capacity overflow` (`alloc/raw_vec`) -> shown as "点群ツール: unreachable(メモリ不足の可能性があります…)" in the error dialog, nothing else broke and the layer list was unchanged. The same happened with autzen + autzen (21,306,672 points). In a non-persistent profile (Playwright default) the same merge instead stopped at the known OPFS error "異常な値 4294967288 ... ファイル位置=268434432" (M4-15). **Cause not identified.** Extraction from the same autzen works, and merges up to 3.1M points work. The M4-14 record says Web merges of LAS passed up to 24M points, so this looks specific to a large COPC as a merge input, but that is unverified. **So "open autzen twice and merge -> 2x points" was not achieved on Web.** Desktop merge of large COPC inputs was not run either.
  - Findings: (1) merge progress shows `pointsRead` up to twice `totalPoints` (6,250,115 / 3,126,520); the dialog clamps the bar to 100%, the cause (probably two passes) is not looked into. (2) Merging extraction outputs of autzen shows two warnings "CRS(座標系)の情報がありません…" although the layer info shows EPSG:2992: the merge's CRS check uses the `Crs` enum, which knows only some CRSs (EPSG:2992 is not one), so the warning wording is misleading for such files.
- Screenshots (scratchpad `l2f-*.png`) opened and looked at: `l2f-1-polygon` (polygon with 4 dots over the cloud, guide bar "頂点をクリック（4点）…閉じる/やめる"), `l2f-2-progress` (progress dialog with bar and cancel), `l2f-3/4` (selection layer and original hidden), `l2f-5-section-dialog`, `l2f-6/6b` (section profile), `l2f-7-multi-selected`, `l2f-10-merge-small`.
- Not seen: the section line itself over the cloud (the dialog's blurred backdrop covers it in the screenshot), and the labels of several measurements overlapping on screen (only a unit test of `labelShifts`).

### Not verified

- Desktop (Tauri): the extract/merge commands from the running app, the conversion UI staying closed while a tool runs, and large-COPC merges. Android. Chrome (Edge only). Touch (long press, no Ctrl/Shift).
- The cause of the large-COPC Web merge failure (above).
- Memory behaviour of the Web tools was not measured.

### How the owner can check

1. Open a COPC. "点の選択" -> click 3 or more vertices on the cloud -> Enter. A progress dialog appears, then a new layer "選択 - ..." ; hide the original to see only the selected part. Dragging the camera while drawing clears the polygon (a notice says so).
2. "断面" -> click two points on the cloud -> set thickness / height in the dialog -> "作る". A new layer "断面 - ..." opens and the camera looks at it from the side.
3. Open two small COPCs (or make two results with the tools), select one, Ctrl-click the other, press "複数レイヤー" -> "結合 (2)" with the summed point count. Try autzen + another layer on Web to see the unresolved failure.
4. Select a measurement layer: the layer info shows the kind and values, "着色" / "見た目" are gray.

## L2-G record: Web merge of a large COPC (capacity overflow), merge progress, CRS check

### The cause (the coordinator's guess was close, but the place was different)

The guess was that the plan or the buffer assumed fixed-size chunks (`chunk_size x point size`). **That is not it.** autzen's laszip VLR does have `chunk_size = 4294967295` (variable; read with a small script from the file, beer.copc.laz the same), but no code of ours uses it.

What was done to find it: a debug wasm build (`CARGO_PROFILE_RELEASE_DEBUG=2`, `wasm-bindgen --keep-debug`) with a temporary panic hook that also prints `Error().stack` (limit raised to 60 frames; not committed). The panic was at 5 s into the merge, in a Worker, and the stack was:
`Vec<u8>::resize` <- `laz::las::point6::v3::LasPoint6Decompressor` (layered decompressor) <- `LasZipDecompressor::decompress_one` <- `las::Reader::fill_points` <- `LazRangeDecompressor::feed` (our parallel decompression Worker).
So a Worker read a garbage layer size and tried to resize to it; on wasm32 a size over 2 GiB is `capacity overflow`.

The garbage comes from `LasZipDecompressor::seek` in laz 0.12.2: `delta = point_idx % chunk_table[chunk].point_count`. That is the offset inside the chunk only for fixed-size chunks. COPC chunks have different point counts, so after `Reader::seek(start)` the decoder was at the wrong point. Native test on autzen with the 8 ranges of `pointRangesFor` (`RangeDecompressorCore::open` + `feed`): starts 0, 1331667, ... 7990002 returned 75,905,019 bytes each, but start 9321669 and start 10000000 returned `IoError: failed to fill whole buffer` (64-bit: an error; wasm32: the panic). A full read from 0 returned 607,240,152 bytes = 10,653,336 x 57, so the file is fine and only the seek is wrong.

**Side finding (not measured on content, only from the code and the test): ranges that did not fail were probably also starting at the wrong point**, so a Web conversion/merge of a COPC above 500,000 points (the parallel path) could have silently dropped/duplicated points while still giving the right count (L2-F's "exact sum" checks counted points, they did not compare points). The new test compares bytes. Inputs that are LAS/LAZ with fixed chunks (M4-14's 24M-point LAS merge) were not affected.

### What was changed

1. **`vendor/laz`** (copy of laz 0.12.2 with one change, `vendor/laz/PATCH.md`): `delta = point_idx - points_before_chunk`. Added to `[patch.crates-io]` of the root workspace and of `crates/pcv-wasm` (both needed, as for copc-reader/copc-writer). Alternative not taken: choosing the seek point in our code so that the buggy modulo gives the right offset (depends on the bug; breaks silently when upstream fixes it). Alternative not taken: avoiding `seek` by decoding from 0 (too slow).
2. **Test** `range_of_variable_chunk_copc_matches_the_same_slice_of_a_full_read` (`crates/pcv-wasm/src/convert.rs`): builds a COPC in memory (5,000 scattered points, 50 per node -> many chunks of different sizes), reads it whole, then reads 8 equal ranges and 6 awkward ranges and compares bytes with the same slice. It failed before the patch (`range [2500, +625) differs`) and passes after.
3. **Progress doubling**: in the multi-file path the serial branch reported `result.points_read`, which is the converter's counter over all files, and then `reportReadingProgress` added the finished files again. Now it subtracts `pointsCompletedBeforeCurrentFile` (`src/datasource/copc.worker.ts`). The parallel branch was already per file.
4. **CRS**: new `pcv_core::crs::CrsId { Missing, Epsg(u32), Other(String) }` and `crs_id_from_las_header`. "Missing" means no CRS information (also an empty WKT record: beer.copc.laz has a 1-byte one, which first showed up as a false CRS mismatch in my browser run and was fixed with a test). A CRS outside `Crs` keeps its EPSG code (WKT or GeoTIFF key, projected key first, then geodetic) or its WKT text. Comparison is on `CrsId`. Used by desktop `merge.rs` (`summarize_headers*`, `HeaderSummary.crs` is now `CrsId`, `MergeError::CrsMismatch` carries `CrsId`) and by Web `check_layout_and_crs_match`/`WasmConverter`; the header summary's `crs_label` is now the Debug text of `CrsId`, so `copc.worker.ts` compares with `"Missing"` instead of `"Unknown"`. `Crs`/`detect_crs_from_las_header` are unchanged (still used for units and display).
   Alternative not taken: comparing the existing `CrsInfo` (describe.rs); it reads the CRS for the screen and carries a name and units, a plain comparable id is simpler.

### Verified (actually run)

- `cargo test --lib` in `crates/pcv-wasm`: 40 passed. `cargo test -p pcv-core -p pcv-convert`: all passed (pcv-core crs tests 34 passed; merge tests 15 passed, with the new `crs_outside_supported_range_is_not_reported_as_missing`). `cargo check --workspace` and `cargo build -p pcv-core --target wasm32-unknown-unknown` OK. `npm run build:wasm` (artifacts committed), `npx tsc --noEmit`, `npm run lint`, `npx vitest run` (59 files, 542 tests passed).
- **Real browser** (headed Edge, persistent profile; `adapter.info` vendor nvidia / lovelace, not SwiftShader; vite dev server of this worktree; script in the session scratchpad):
  - autzen opened twice, Ctrl-click, "複数レイヤー": no error; the progress dialog showed "21,306,672 / 21,306,672 点（100.0%）" and the layer "結合 (2)" has **21,306,672 points**, CRS "NAD83 / Oregon GIC Lambert (ft) (EPSG:2992)", drawn normally (screenshots `l2g-d-progress.png`, `l2g-d-end.png`, opened and looked at). About 55 s in total in that run (another agent may have been running at the same time, so the time is only a rough number). No error dialog, so no false "CRS" warning.
  - autzen + a 5,000-point COPC that has no CRS (made by a test helper, point format 7): progress went 2,162,688 -> ... -> 10,653,336 -> 10,658,336 / 10,658,336 (100.0%), never above 100% (this is the serial branch that used to double); result 10,658,336 points (exact sum, count only); one warning, for the small file only, with the true text "small7.copc.laz: CRS(座標系)の情報がありません…" (`l2g-h-log.png`, looked at).
  - autzen + beer.copc.laz (66,848,096 points, an empty-WKT CRS): stops at 96.5% with "invalid COPC input: spill size overflow". 77,501,432 points x 57 bytes is over the 4 GiB of wasm32, so this is the known size limit of the Web merge and not part of this task; not changed.

### Not verified

- **Desktop (Tauri)**: the merge command in the running app was not run (a GUI app was not driven). Only the Rust unit tests above cover the desktop `merge.rs` change. The laz patch also changes `laz` for desktop (`laz-parallel` of pcv-convert does not use `seek`; not checked further).
- Point content of the 21M merge was not compared (only counts and the picture). Android, Chrome, Firefox. Playwright's own E2E (`npx playwright test`) was not re-run after the last commit (see the report).

### How the owner can check

1. Web: open autzen-classified.copc.laz twice, click one row and Ctrl-click the other, press "複数レイヤー". Expect 21,306,672 points, a bar that stops at 100%, and no error dialog.
2. `cargo test --lib range_of_variable` in `crates/pcv-wasm`; to see it fail, comment out the `laz` line of `[patch.crates-io]` in `crates/pcv-wasm/Cargo.toml`.
