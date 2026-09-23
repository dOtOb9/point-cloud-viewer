# ADR-0004: 配布と自動更新の方式

- 状態: 採択
- 日付: 2026-09-22
- 前提: [ADR-0001](./ADR-0001-architecture.md), [ADR-0002](./ADR-0002-rendering-api.md)

## 決定

GitHub Releases でインストーラを配布し、**デスクトップは Tauri の updater プラグインで
オプトイン自動更新**、**Android は自前の更新通知**とする。Windows は MSI と NSIS の
両方を出し、**更新のターゲットは NSIS** にする。

> **追記4（2026-09-23）**: 上記のうち「デスクトップは Tauri の updater プラグイン」は
> 当面取り下げた。所有者が署名鍵を作らない方針にしたため、デスクトップも Android と
> 同じ自前の通知方式（GitHub API確認 → 手動で適用）に統一している。詳細は本文末尾の
> 「追記4」を参照。MSI/NSIS 両方を出す方針自体は変わっていない。

## 背景

ADR-0001 で「インストーラ・コード署名・自動更新が Tauri 組み込みで手に入る」ことを
Bevy を却下した理由の1つに挙げた。ここでそれを実際に使う。

## 各決定の理由

### 配布は GitHub Releases、トリガーはタグ push（`v*`）

リポジトリが public なので追加のホスティングが要らない。updater が読む `latest.json` も
`https://github.com/dOtOb9/point-cloud-viewer/releases/latest/download/latest.json` で
配信できる。main への push ごとにリリースを作ると履歴が汚れるため、**タグを打った時だけ**
リリースする。

### Windows は MSI と NSIS の両方を出し、更新は NSIS 経由にする

Tauri v2 が推奨するのは NSIS で、理由は2つある。

- **MSI は更新のたびに UAC の昇格が要る。** 起動時にオプトインで更新するという要件と相性が悪い
- **MSI は WiX の制約で Windows 上でしかビルドできない。** NSIS はクロスビルドできる

一方で MSI を要求される場面（企業の配布管理など）はあるため、**両方を bundle する**。
`msi → nsis` への移行は Tauri がサポートしているが **`nsis → msi` は不可**なので、
両方出しておけば将来どちらにも倒せる。更新の導線だけを NSIS に寄せる。

### デスクトップの更新は必ずオプトインにする

起動時に静かにチェックし、新しいバージョンがあった場合**のみ**ダイアログを出す。
ユーザが同意したときだけダウンロードとインストールを行う。黙って更新しない。

点群の解析作業中に勝手に再起動されるのは業務上の実害になるため、
「チェックは自動・適用は手動」を守る。

### Android は Tauri の updater を使えない

**Tauri の updater プラグインは Linux / Windows / macOS のみで、Android / iOS は非対応。**
したがって Android では以下を自前で実装する。

1. 起動時に GitHub Releases API（`/repos/dOtOb9/point-cloud-viewer/releases/latest`）を叩く
2. `tag_name` を現在のアプリバージョンと比較する
3. 新しければダイアログを出し、同意されたら APK のダウンロード URL をブラウザで開く
4. **インストールはユーザの手作業**（サイドロード）

これは「更新を検知して知らせる」までで、自動適用はできない。Play ストアに出せば
ストア側の更新機構に乗るが、それは現時点のスコープ外とする。

### Android は対応端末限定で割り切る

ADR-0002 で WebGL2 フォールバックを書かないと決めた。この判断は WebView2 が evergreen な
Windows では妥当だったが、Android では端末の断片化が効く。

**Android WebView の WebGPU は Chrome 121+ / Android 12 以上 / Qualcomm・ARM GPU が条件**で、
満たさない端末では `navigator.gpu` が無く画面が白いままになる。

そこで **WebGPU が取得できなかった場合に「この端末は未対応です」と明示する画面を出す**
ことで割り切る。WebGL2 経路は書かない。レンダラを1本に保つ利益のほうが大きく、
Android 12+ は現役端末の大半をカバーするため。

この判断は ADR-0002 を書いた時点では想定していなかった条件に基づくので、
**Android の対応端末を広げる必要が出たら ADR-0002 ごと見直す。**

### 署名

| 対象 | 方式 | 理由 |
|---|---|---|
| 更新マニフェスト | `tauri signer generate` の鍵。秘密鍵は GitHub Secrets、**公開鍵だけ** `tauri.conf.json` に置く | updater の必須要件。これが無いと更新が成立しない。**→ 追記4: 当面この鍵は作らないと決めたため、tauri-plugin-updater自体を導入していない（デスクトップもAndroidと同じ自前の通知方式）** |
| Android APK | 当面 **debug 署名** | まず CI で APK が生成できるところまでを確認する段階。配布時に改めてリリース用 keystore を用意する |
| Windows MSI / NSIS | **無署名** | コード署名証明書は有償。SmartScreen の警告は受け入れる |

**秘密鍵・keystore・パスワードはリポジトリに一切コミットしない。** すべて GitHub Secrets に置く。

## 帰結

**得たもの**
- タグを打つだけでインストーラが出て、既存ユーザに更新が届く
- 更新の適用タイミングをユーザが握れる（解析作業を中断されない）

**払うもの**
- 更新署名鍵の管理責任が発生する。**この鍵を失うと既存ユーザに更新を配れなくなる**
- Android の更新は「通知するだけ」で、適用は手作業
- 無署名の MSI / NSIS は SmartScreen の警告を出す

**引き受けたリスク**
- Android で WebGPU 非対応の端末に当たった場合、アプリは動かない。
  未対応である旨を明示することで、壊れているのか未対応なのかを区別できるようにする

## 却下した案

| 案 | 却下理由 |
|---|---|
| MSI だけを出す | 更新のたびに UAC 昇格が必要で、オプトイン更新の体験が悪い。`nsis → msi` の移行が不可なので将来の逃げ道も塞ぐ |
| NSIS だけを出す | 企業配布で MSI を要求される場面がある。両方出すコストは低い |
| 黙って自動更新する | 解析作業中の再起動は実害。要件としてもオプトインが指定されている |
| Android にも WebGL2 経路を書く | レンダラが実質2本になり維持コストが倍。Android 12+ でカバーできる範囲を優先する |
| main への push ごとにリリース | 履歴が汚れる。タグで明示的に切る |

---

## 追記4（2026-09-23）: 当面は署名鍵を作らない

M3着手時点でこのADRが決めていた「更新マニフェストの署名鍵を所有者が生成し、
GitHub Secretsに登録する」という前提を、所有者の判断で**当面取り下げる**。
理由は明記されていない（所有者の運用上の判断）が、結果として実装側は
「鍵が無くても壊れない」形を最初から要求されていたため、後戻りは小さかった。

### 変わったこと

| 項目 | 変更前（このADR本文の決定） | 変更後（当面） |
|---|---|---|
| デスクトップの更新 | `tauri-plugin-updater`による署名付き自動適用（オプトイン） | Androidと同じ自前実装（GitHub API確認 → 同意でリリースページを開く。適用は手動） |
| 更新マニフェストの署名鍵 | 所有者が生成しGitHub Secretsへ登録 | **生成しない**（M3タスクシートの「着手前に所有者がやること」は当面不要） |
| `tauri.conf.json`の`plugins.updater` | 導入する | **導入しない**（`tauri-plugin-updater`自体を依存に加えていない） |
| Windowsインストーラの配布 | 上記と同じ(MSI/NSIS、無署名は変更前から決定済み) | 変更なし。ただしlatest.json(更新manifest)は作らない |
| Android の keystore | 当面debug署名、将来リリース用keystoreを用意 | 変更なし（デバッグ署名のみ、永続的なkeystoreは持たない前提を明確化） |

### できなくなったこと（払うものが増えた）

- **デスクトップの更新が自動適用できない。** チェックして知らせるところまでで、
  ダウンロード・インストールは利用者の手作業になる（Androidと同じ制約が
  デスクトップにも及んだ）
- **Androidのdebug署名APKは、CIの実行ごとに鍵が変わりうる。** 上書きインストール
  できない可能性が高く、その場合は利用者がいったんアンインストールしてから
  新しいAPKを入れる必要がある（M3-3で`actions/cache`によるdebug.keystoreの
  使い回しを試みたが、実際に効くかは未確認。TaskSheets/M3-release-and-update.md
  M3-3参照）
- **Windowsインストーラは元々無署名の決定だったが、SmartScreenの警告を回避する
  手段（コード署名証明書の導入）を検討する動機も無くなった。** 警告が出ることを
  利用者向けに明記する運用でしのぐ

### 将来、署名鍵を作ることにしたら何を戻すか

ここに戻すべき変更をまとめておく（実装済みのコードは削除していないものはない。
以下はすべて「新しく追加する」作業になる）。

**デスクトップの自動更新を有効にする場合:**
1. 所有者が更新マニフェストの署名鍵を生成し、GitHub Secretsに登録する
   （手順はこのファイル冒頭の「着手前に所有者がやること」相当。M3タスクシートに
   残してある）
2. `src-tauri/Cargo.toml`に`tauri-plugin-updater`を追加する
3. `src-tauri/tauri.conf.json`に`plugins.updater`（`endpoints`と`pubkey`）を追加する
4. `src-tauri/capabilities/default.json`に`updater:default`権限を追加する
5. `src-tauri/src/lib.rs`で`tauri_plugin_updater::Builder::new().build()`を
   プラグインとして登録する
6. フロントに`@tauri-apps/plugin-updater`を導入し、`src/datasource/`配下に
   閉じ込めた形で`check()`/`downloadAndInstall()`を呼ぶコードを書く
   （`src/datasource/update-check.ts`は今のGitHub API方式のままAndroid専用にするか、
   デスクトップ側だけ差し替えるかは実装時に判断する）
7. `.github/workflows/release.yml`の`windows`ジョブに
   `TAURI_SIGNING_PRIVATE_KEY`/`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`を環境変数として渡し、
   `latest.json`が生成・添付されるようにする（`tauri-apps/tauri-action`の利用も検討）

**Androidのリリース用keystoreを用意する場合:**
1. 所有者がリリース用keystoreを生成し、GitHub Secrets
   （keystore本体・パスワード・key alias・keyパスワード）に登録する
2. `.github/workflows/release.yml`の`android`ジョブに、Secretsの有無で分岐する
   署名ステップを追加する（Secretsがあれば署名、無ければ現状どおりdebug署名）
3. debug.keystoreのキャッシュ(`actions/cache`)は、リリース署名に切り替わっても
   デバッグビルド用としては残してよい
