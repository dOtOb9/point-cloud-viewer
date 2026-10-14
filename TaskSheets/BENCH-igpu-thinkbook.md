# BENCH-igpu: 内蔵 GPU の PC（ThinkBook）で測る環境

- 状態: SSH 接続まで完了。**ブラウザから GPU が見えない問題が未解決**（所有者の判断待ち）
- 日付: 2026-10-14
- 担当: コーディネーター

## 目的

LOD 改善 B（内蔵 GPU 向けの設定）と HQ-2（止まったら最大まで読む）の効き目は、
開発機（RTX 4070）では測れない。開発機の内蔵 GPU は BIOS で無効（HQ-0 の記録）。
所有者の別 PC（ThinkBook、内蔵 GPU）で、コーディネーターやエージェントが自分で測れるようにする。

## 機材

| 項目 | 値 |
|---|---|
| 名前 / ユーザー | `TAKO` / `tako\masa1`（管理者グループ） |
| IP アドレス | `192.168.10.104`（家の LAN。開発機は `192.168.10.103`） |
| GPU | Intel(R) Iris(R) Xe Graphics |
| 入っているもの | OpenSSH サーバー（Windows 標準、OpenSSH_for_Windows_9.5）、Node.js v24.20.0、Git 2.55.0 |

## 準備で行ったこと（所有者が ThinkBook の管理者 PowerShell で実行）

1. OpenSSH サーバーを追加し、自動起動にした
2. ネットワークをプライベートにし、SSH の受け付けを同じネットワーク内（`LocalSubnet`）に限った
3. 開発機の公開鍵（`~/.ssh/thinkbook_ed25519.pub`、指紋 `SHA256:3ZJJnp4nfqWO/dPgwIqR61b3X+1JDj2pukHUSMos/hk`）を
   `C:\ProgramData\ssh\administrators_authorized_keys`（権限は SYSTEM と Administrators のみ）と
   `~\.ssh\authorized_keys` に置いた
4. Node.js と Git を winget で入れた

秘密鍵は開発機の `C:\Users\Masa1\.ssh\thinkbook_ed25519` にある（リポジトリには入れない）。

### つまずいたこと

- ThinkBook に `ssh-keygen` が無く、指紋の確認は PowerShell で公開鍵の SHA256 を計算して代わりにした
- 鍵を PowerShell 7 で `ssh-keygen -N '""'` として作ったため、パスフレーズが空ではなく `""`（引用符2文字）になり、
  サーバーは鍵を受け付けたのにクライアント側で署名できず `Permission denied` になった。
  `ssh-keygen -p -P '""' -N ''`（bash から）で空に直して解決

## 接続の仕方（開発機の bash から）

```bash
ssh -i ~/.ssh/thinkbook_ed25519 -o BatchMode=yes masa1@192.168.10.104 "whoami"
```

`C:\pcv-bench\` に Playwright（npm）と Chromium を入れてある。

## 未解決: SSH から起動したブラウザでは GPU が見えない（実測）

`C:\pcv-bench\probe.mjs`（Web 版の Pages を開き、`navigator.gpu.requestAdapter()` の結果を出す）を SSH から実行すると、
headless でも画面ありでも **`adapter なし`** になった。Windows の SSH はサービス用の別セッション（セッション0）で動き、
GPU と画面に触れないためと考えられる **[推定]**。

ログイン中のユーザーのセッションでブラウザを起動すれば GPU が使える見込み **[未検証]**。
その方法として、SSH 越しにタスクスケジューラへ登録して起動する案を試したが、
Claude Code の自動の許可判定に「リモートに持続する仕組みを作る操作」として止められた。

**所有者に決めてもらうこと**（次のセッションのコーディネーターが聞く）:

1. ThinkBook のデスクトップで所有者が直接 `cd C:\pcv-bench; node probe.mjs` を実行し、GPU が見えるかをまず確かめる
   （これで Iris Xe が出れば、ログイン中のセッションなら測れることが確定する）
2. そのうえで、測るたびに所有者が ThinkBook で計測スクリプトを起動する運用にするか、
   所有者がタスクの登録を許可する（Claude Code の許可設定に規則を足す）かを決める

## 所有者の確認手順

- 開発機の bash で上の「接続の仕方」のコマンドを実行し、`tako\masa1` と出ること
- 使わないときに SSH を止めるには、ThinkBook の管理者 PowerShell で `Stop-Service sshd; Set-Service sshd -StartupType Disabled`

## 計測一式（`scripts/igpu-bench/`）

- 状態: 小さな版は ThinkBook で成功（所有者が実行。adapter intel / gen-12lp、autzen 全体見下ろし 790,853 点で中央値 16.7ms、ドラッグで p95 33.4ms。コーディネーターが回収して確認）。
  **完全版（下の「完全版の構成」）を作り、ThinkBook に送る。所有者の実行待ち。**
- 日付: 2026-10-14

### 運用（所有者が ThinkBook のデスクトップで1行実行する）

SSH から起動したブラウザは GPU が見えない（上の節）。ログイン中の画面で起動した画面ありの Chromium では
`adapter.info` が intel / gen-12lp で取れた（所有者の確認）。そのため計測は所有者が実行し、
エージェントは SSH で準備と結果の回収だけをする。タスクスケジューラへの登録などはしない。

```
cd C:\pcv-bench; node bench.mjs
```

### 作ったもの

| ファイル | 役割 |
|---|---|
| `scripts/igpu-bench/bench.mjs`（ThinkBook では `C:\pcv-bench\bench.mjs`） | 配信サーバー（Range・CORS 付き、127.0.0.1:8765）を立て、画面ありの Chromium で GitHub Pages の Web 版を `?pcvDebug` 付きで開き、`C:\pcv-bench\data\` の COPC を URL から開いて計測する。結果は `C:\pcv-bench\out\<日時>\` に `result.json` と png。各段階にタイムアウトを付け、失敗したらエラー全文を残して終了する |
| `scripts/igpu-bench/collect.sh` | 結果を開発機へ scp で回収する |

計測の中身: `adapter.info`、画面解像度と `devicePixelRatio`、`deviceMemory`、`pointer: coarse`、renderer が実際に使っている
device-profile の値（モバイル扱いか、点予算の上限、解像度、点の形、EDL）、止めたまま N 秒の描画点数の推移・フレーム間隔
（中央値/p95/最大）、ドラッグ N 秒のフレーム間隔と点予算の最小・最大、スクリーンショット。
小さな版は止めて 30 秒・ドラッグ 5 秒（環境変数 `BENCH_IDLE_SEC`・`BENCH_DRAG_SEC` で変えられる）。
設定を変える比較（解像度 0.5、点予算 1/4）は `CONFIGS` に `scale05`・`budgetQuarter` として書いてあるが、
小さな版では呼んでいない。方法はページ内の `window.__pcvRenderer` のメソッド（`setRenderScale(0.5)`、
`setAutoPointBudgetEnabled(false)` + `setPointBudget(上限/4)`）を直接呼ぶ。

### 開発機で確かめたこと（RTX 4070 の開発機で、同じスクリプトを短くして実行）

- 実行した: 止めて 10 秒・ドラッグ 3 秒。adapter nvidia / lovelace、device-profile は非モバイル（上限 26,843,545 点、解像度 1、丸、EDL あり）、
  最大 790,853 点、フレーム中央値 16.7 ms（60fps 上限で張り付き）。エラーなしで終了した（約 17 秒）。
- **つまずき（重要）**: https の Pages から `http://127.0.0.1` のファイルを開くと、**そのままでは要求が1つも出ず「読み込み中」のまま 150 秒止まった**
  （Chromium の「ローカルネットワークへのアクセス」の許可待ちと推定 **[原因は未特定。フラグで直ったことだけ確認]**）。
  起動引数 `--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessSendPreflights,BlockInsecurePrivateNetworkRequests`
  を付けると要求が通り、206 で読めた。スクリプトには付けてある。配信サーバーは `Access-Control-Allow-Private-Network: true` も返す。
  ThinkBook の Chromium のバージョンが違う場合に挙動が変わりうる **[未確認]**。
- ビルドの新しさ: ページの `<script src>`（例 `assets/index-BVb7X9mt.js`）と `document.lastModified` を結果に残す。最新かどうかの判定は結果を見て人が行う。

### 確かめていないこと

- ThinkBook（Iris Xe）での実行。Chromium のバージョン差、LNA フラグの効き
- 渋谷 v2（4.2GB）の転送完了（開発機から `scp` を実行中。完了はファイルサイズで確かめる）

### 所有者の確認手順

1. ThinkBook のデスクトップで PowerShell を開き、`cd C:\pcv-bench; node bench.mjs`（約 1.5〜2 分）
2. Chromium のウィンドウが出て、点群が表示されること。終わるとコンソールに結果の場所が出る
3. 結果の回収は開発機で `sh scripts/igpu-bench/collect.sh <保存先>`

### 完全版の構成（`bench.mjs` 引数なし。約 10〜11 分の見込み）

「セッション」= データ1つ + 設定1つ。セッションごとにブラウザを起動し直す（GPU が落ちても次へ進むため）。
1セッションで視点3つ（全体見下ろし・街区・通り）を、止めたまま N 秒 → ドラッグ 5 秒で測る。

| データ | 設定 | 止める秒数 | 何を見るか |
|---|---|---|---|
| autzen | default / scale05 / big | 25 / 12 / 12 | 基準、解像度の効き、画素数の効き |
| 渋谷 v2 | default / scale05 / big / budgetQuarter / edloff | 25 / 12 / 12 / 12 / 12 | 同上 + 点予算を下げた効き + EDL の効き |

- **画素数の比較**（コーディネーターの推定「全画面の処理は点予算の自動調整では下がらない」を確かめる）: 窓 1280x720・解像度 1.0（default、画素数 1）、
  解像度 0.5（scale05、1/4）、窓を最大化して解像度 1.0（big、画面の大きさ）の3点で、同じ視点のフレーム時間を比べる。
  各セッションの `configApplied.canvasPx` に実際のキャンバスの画素数が入る。EDL オフ（edloff）は、全画面処理が EDL に由来するかの切り分け。
- 設定の変え方（記録する）: ページ内の `window.__pcvRenderer` のメソッドを直接呼ぶ。`setRenderScale(0.5)`、`setEdlEnabled(false)`、
  `setAutoPointBudgetEnabled(false)` + `setPointBudget(上限/4)`。big は設定ではなく窓を最大化（`--start-maximized`、ビューポート固定なし）。
- 視点: 渋谷は HQ-0 と同じ世界座標（街区 target=[-12000,-37800,40] distance=400 pitch=0.6 yaw=2.0、通り distance=40 pitch=0.1 yaw=0.5）。
  autzen は座標を知らないので、開いた直後のカメラの target・distance からの相対（街区 0.3 倍・通り 0.05 倍）。使ったカメラは `result.json` に残る。
- 安全策: セッション全体 4 分でタイムアウト（固まったらエラーを記録してブラウザを閉じ、次のセッションへ）。全体 14 分を超えたら残りは始めずに `skipped` に記録。
  各視点でタイムアウト・クラッシュ系のエラーが出たらそのセッションを打ち切る。
- 動作確認用: `node bench.mjs <名前の一部>`（例 `shibuya-edloff`、`autzen-big`）で一致するセッションだけ実行。

### 開発機での動作確認（RTX 4070、ドラッグ 2〜5 秒に短縮）

- `autzen-big`: 窓が 1920x945 になり、`canvasPx` も [1920, 945] で取れた。`shibuya-budgetQuarter`: 点予算 6,710,886 に固定され、全視点で完走。
  `shibuya-edloff`: EDL オフが反映された。いずれもエラーなし。
- **異常値の記録**: autzen-big の通りの視点のドラッグで、フレーム間隔が約 1016ms になった回が1回あった（点予算の最小は 200,000）。
  同じ設定の他の視点や、直後の別セッションでは再現しなかった。原因は未調査（開発機の画面が他の作業で隠れた・負荷がかかった可能性があるが **[推定]**）。
  ThinkBook の結果でも「1回だけ飛び抜けた値」が出たら、同種のノイズの可能性がある。
- 全セッションの通し実行（約 10〜11 分）は開発機では**していない**（所要時間は個別セッションの実測からの見積り）。

### 完全版を所有者が実行する手順

1. ThinkBook のデスクトップで PowerShell を開き、`cd C:\pcv-bench; node bench.mjs`（約 10〜11 分。途中でウィンドウに触らない・スリープさせない）
2. セッションごとに Chromium が開いて閉じる。終わるとコンソールに結果の場所が出る
3. 開発機で `sh scripts/igpu-bench/collect.sh <保存先>`
