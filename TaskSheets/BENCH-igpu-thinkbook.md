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
