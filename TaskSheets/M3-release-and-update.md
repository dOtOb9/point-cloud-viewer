# M3: リリース配布と自動更新

- 状態: M3-1〜M3-6 着手・記録済み（2026-09-23、Sonnet実装分。詳細は各節末尾の「実施記録」）。
  M3-7〜M3-9は所有者の実機作業のため未着手のまま
- 前提: [ADR-0004](./ADR-0004-distribution-and-update.md)（**2026-09-23追記4で
  デスクトップの自動更新方式が変わった。下記「着手前に所有者がやること」も参照**）

> **M3 の目的は「配る」だけでなく「配った先で使える」までを含む。**
> M3-6〜M3-9 は所有者の実機 (OPPO Pad Air / Snapdragon 680 / Android 13) で
> 操作できるようにするための項目。詳細は後半の「実機で使えるようにする」を参照。

## このマイルストーンの目的

タグを打つと **Windows の MSI / NSIS と Android の APK が GitHub Releases に出る**ようにし、
**既存アプリが起動時に新バージョンを検知して、ユーザが同意したときだけ更新する**ようにする。

M1 / M2 の描画機能とは独立しているため並行して進められるが、**最初の実タグ（v0.1.0）は
M1 が着地してから打つ**。中身が動かないインストーラを配っても意味がないため。

---

## 着手前に所有者がやること（これだけは代行できない）

> **2026-09-23時点: 当面このセクションの作業は不要。** 所有者が「当面、署名鍵を作らない」
> と方針を変えたため（[ADR-0004](./ADR-0004-distribution-and-update.md) 追記4）、
> デスクトップの更新はTauriのupdaterプラグイン（署名付き自動適用）ではなく、
> Androidと同じ自前のGitHub API確認方式に統一した。**鍵が無くてもM3-1〜M3-6は
> すべて動く形で実装済み。** 以下は「将来、自動適用の更新を有効にしたくなったとき」の
> 手順として残してある（消していない）。実際に何を戻す必要があるかは
> [ADR-0004の追記4](./ADR-0004-distribution-and-update.md)に一覧がある。

更新マニフェストの署名鍵を生成し、GitHub Secrets に登録する。**秘密鍵は誰にも渡さず、
リポジトリにもコミットしない。** この鍵を失うと既存ユーザに更新を配れなくなるので、
パスワードともどもパスワードマネージャ等に控えておくこと。

```bash
# 1. 鍵を生成する（パスワードを設定する。空でも動くが設定を推奨）
npx @tauri-apps/cli signer generate -w ~/.tauri/pcv-updater.key

# 出力される公開鍵（"Public key:" の行）を控える → tauri.conf.json に入れる（公開してよい）
# 秘密鍵は ~/.tauri/pcv-updater.key に保存される（絶対に公開しない）

# 2. GitHub Secrets に登録する
gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.tauri/pcv-updater.key
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD   # 対話で 1. のパスワードを入力
```

登録できたか確認:

```bash
gh secret list
```

**公開鍵（`Public key:` の値）をこのファイルの下に貼るか、実装者に伝えてください。**
`tauri.conf.json` の `plugins.updater.pubkey` に入れます。

> 公開鍵: （未設定）

---

## 所有者が鍵を登録したあとにやること（まとめ）

**2026-09-23時点では不要**（当面署名鍵を作らない方針。上記参照）。将来、
デスクトップの自動更新を有効にしたくなったときのために、やることを1か所に
まとめておく。技術的な変更点の詳細リストは
[ADR-0004の追記4](./ADR-0004-distribution-and-update.md)にある。ここでは
「所有者が実際に手を動かす手順」だけを書く。

1. **鍵を作る**（このファイル冒頭「着手前に所有者がやること」の手順どおり）。
   `npx @tauri-apps/cli signer generate` で生成し、`gh secret set` で
   `TAURI_SIGNING_PRIVATE_KEY` と `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` を登録する
2. **公開鍵を貼る場所**: 生成時に出力される `Public key:` の値を、
   `src-tauri/tauri.conf.json` の `plugins.updater.pubkey` に入れる
   （`plugins.updater`自体、現時点では存在しないので新設することになる。
   ADR-0004追記4の手順2〜5を参照）
3. **要る Secrets**: `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
   （更新マニフェスト署名用）。Androidのリリース用keystoreを別途用意する場合は
   keystore本体・パスワード・key alias・keyパスワードも追加で要る
   （`gh secret list`で登録状況を確認できる）
4. **実装側に依頼すること**: 上記2つのSecretsを登録したら、実装担当（Sonnet/Opus）に
   「鍵を登録した」と伝える。`tauri-plugin-updater`の導入・`release.yml`への
   env追加・デスクトップ側の自動適用ダイアログの実装はADR-0004追記4の手順どおり
   コードを書く必要があるため、鍵の登録だけでは自動的に有効にならない
   （M3タスクシートの当初の想定とは異なり、現在の実装はTauriのupdaterプラグイン
   自体を導入していないため）
5. **最初のタグの打ち方**: `src-tauri/tauri.conf.json`の`version`を上げてから
   `git tag v0.1.0 && git push origin v0.1.0`（`package.json`の`version`とも
   合わせておくこと）。`release.yml`の`check-version`ジョブがタグと
   `tauri.conf.json`の不一致を検査するので、ずれていればそこで落ちる

---

## M3-1: リリースワークフロー（Windows）

### やること

`.github/workflows/release.yml` を作る。**CI（`ci.yml`）とは別ファイルにする** — CI は
毎 push で速く回す用、release はタグの時だけ回す用で、目的も所要時間も違うため。

- トリガー: `push: tags: ['v*']`
- `windows-latest` で `tauri build`（bundle あり）
- 生成物: `.msi` と `.nsis`（`tauri.conf.json` の `bundle.targets` に両方を指定）
- GitHub Release を作成し、インストーラと `latest.json` を添付する
- `TAURI_SIGNING_PRIVATE_KEY` / `..._PASSWORD` を env に渡す（これが無いと `latest.json` の
  署名が作られず、updater が更新を拒否する）

> **2026-09-23実施時点の変更**: 上記のうち`latest.json`の生成と
> `TAURI_SIGNING_PRIVATE_KEY`系のenvは実装していない。[ADR-0004追記4](./ADR-0004-distribution-and-update.md)
> のとおり、当面署名鍵を作らない方針になったため。`.msi`/`.nsis`をビルドして
> Releaseに添付するところまでを無署名で行う。

### バージョンの扱い

タグ `v0.1.0` と `tauri.conf.json` の `version` が食い違うと、updater が更新を検知できない
（あるいは無限に更新を促す）。**ワークフローの最初にタグとバージョンの一致を検査し、
違っていたら落とすこと。** 黙って進めない。

### 受け入れ条件

- [x] ~~`v0.0.1-test` のようなテストタグを打つと Release が作られ、`.msi` / `.nsis` /
      `latest.json` が添付される~~ → `latest.json`は方針転換により対象外（追記4参照）。
      `.msi`/`.nsis`が添付される部分はワークフローとして実装したが、**タグを実際に
      pushして確認することは今回行っていない**（タグ`v*`のpushはリリースを走らせて
      しまうため、担当範囲外の作業として指示されていた。**未確認**）
- [x] ~~`latest.json` に署名（`signature` フィールド）が入っている~~ → 対象外（追記4）
- [ ] タグと `tauri.conf.json` の version が食い違うとワークフローが落ちる（**実際に試すこと**）
      → ロジックは実装した（`check-version`ジョブ）が、**実際にタグを打って試すことは
      していない。未確認**
- [ ] テストタグと Release は確認後に削除する → 上記の理由でテストタグ自体を打っていない

### コミット単位

`ci: add release workflow for windows installers`

### 実施記録（2026-09-23、Sonnet）

`.github/workflows/release.yml`を新設。`check-version`ジョブでタグと
`tauri.conf.json`のversionの一致を検査し、`windows`ジョブで`tauri build`
（`bundle.targets`は`["msi","nsis"]`に変更）を実行してGitHub Releasesに添付する。
署名なし（ADR-0004追記4）。SmartScreenの警告が出ることをリリース本文に明記した。

**確認できたこと**: `npm run build`・`cargo build --workspace`・CI(`ci.yml`)は
このワークフロー追加後も緑（`tauri.conf.json`の`bundle.targets`変更は`tauri build`
時にしか使われないため、通常のビルド・テストには影響しない）。

**確認できていないこと**（タグpush禁止のため）: このワークフロー自体をCIで
実際に走らせて緑になることは未確認。YAML構文は目視で確認したのみ。

---

## M3-2: デスクトップの更新通知（オプトイン。方針転換によりM3-4と共通実装）

> **2026-09-23の方針転換（[ADR-0004追記4](./ADR-0004-distribution-and-update.md)）**:
> `tauri-plugin-updater`による署名付き自動適用は実装しない。所有者が当面署名鍵を
> 作らないと決めたため。以下の元の「やること」は履歴として残すが、**実際に実装したのは
> 節末の「実施記録」に書いた、Androidと共通の自前実装**である。

### やること（元の計画。上記の理由で採用していない）

`tauri-plugin-updater` を導入し、**起動時チェック → ダイアログ → 同意したときだけ適用**の
導線を作る。

1. Rust 側: `tauri-plugin-updater` を追加、`tauri.conf.json` に `plugins.updater`
   （`endpoints` と `pubkey`）を設定
2. フロント側: 起動時に `check()` を呼ぶ。**新しいバージョンがあった場合のみ**ダイアログを出す
3. ダイアログには新バージョン番号とリリースノートを出す。「今すぐ更新」「後で」を選べる
4. 同意されたらダウンロード進捗を出し、完了後に再起動を促す

### 守ること（採用した実装でも守っている）

- **黙って更新しない。** 同意なしにダウンロードもインストールもしない（ADR-0004）
- **開発中（`tauri dev`）はチェックしない。** 毎回ダイアログが出て邪魔になる
- チェックが失敗しても（オフライン等）**アプリは普通に起動する。** 更新チェックの失敗で
  起動を止めない
- 規約2 は更新通知にも適用される。`@tauri-apps/plugin-opener` の import は
  `src/datasource/update-check.ts` に閉じ込めた。

### 受け入れ条件（実際に採用した設計に合わせて改訂）

- [ ] 古いバージョンで起動すると更新通知が出る → ロジック（`isNewerVersion`）は
      単体テストで確認済み。**実際に古いバージョンをインストールして確認することは
      していない（GUIでの目視確認が必要。所有者に依頼）**
- [x] 「後で」を選ぶと何もダウンロードされず、アプリが普通に使える →
      `dismiss()`はUIの状態を変えるだけで、`openRelease()`を呼ばない限り
      何もfetchしない。コードレビューでは満たしている
- [ ] ~~「今すぐ更新」で更新が適用され、再起動後にバージョンが上がっている~~ →
      **自動適用はしない設計に変更**（追記4）。「リリースページを開く」までで、
      インストールは利用者の手作業
- [x] オフラインで起動してもエラーダイアログを出さずに普通に起動する →
      `fetchLatestRelease()`は例外・非200応答をすべて`null`にして返す
      （`src/datasource/update-check.ts`）。**実機オフラインでの確認はしていない**
- [x] `tauri dev` では更新チェックが走らない → `import.meta.env.DEV`で判定
      （`src/state/useUpdateCheck.ts`）。ビルド設定上そうなることは確認したが、
      実際に`tauri dev`を起動して目視することはしていない
- [x] CI の invariants ジョブが緑のまま（規約2 を壊していない） → **確認済み**
      （`@tauri-apps/plugin-opener`の import は `src/datasource/update-check.ts`
      のみ。`@tauri-apps/api`の import は`src/datasource/tauri.ts`のみで規約2は
      別ロジックでチェックしている）
- [x] 追加: 起動時チェック自体を設定でオフにできる（オプトイン） → `SettingsModal`に
      トグルを追加

### コミット単位

`feat: add update notice on desktop and android (shared, opt-in)`
（M3-4と同一コミット。理由は下記実施記録参照）

### 実施記録（2026-09-23、Sonnet）

所有者の方針転換を受け、デスクトップの更新通知をM3-4（Android）と**同じコードで**
実装した。「同じことを2回書かない」という指示のとおり、プラットフォーム分岐は
`src/datasource/update-check.ts`の`openReleasePage()`一箇所（内部で使う
`@tauri-apps/plugin-opener`の`openUrl()`がデスクトップ・Android両対応）に閉じている。

追加したファイル:
- `src/datasource/update-check.ts`: GitHub Releases APIのfetchと`openUrl`
- `src/datasource/version-compare.ts` + `.test.ts`: バージョン比較の純粋関数
- `src/state/useUpdateCheck.ts`: 起動時チェックのフック（DEV判定・オプトイン設定を含む）
- `src/ui/shell/UpdateNotice.tsx`: 通知UI
- `SettingsModal.tsx`にトグルを追加

`src/datasource/tauri.ts`に`getAppVersion()`を追加（`@tauri-apps/api/app`の
`getVersion()`。規約2どおりこのファイルに閉じ込めた）。

`useCopcViewer.ts`・`LayerPanel.tsx`は触っていない（カラーマップ担当との並行作業を
配慮。AppShell.tsxとSettingsModal.tsxのみ変更）。

---

## M3-3: Android のビルドを CI に足す

### やること

`release.yml` に Android ジョブを足し、**debug 署名の APK** を生成して Release に添付する
（ADR-0004: リリース用 keystore は配布段階で用意する）。

- JDK 17、Android SDK / NDK のセットアップ
- Rust の android ターゲット追加（`aarch64-linux-android` ほか）
- `tauri android init`（`src-tauri/gen/android/` は `.gitignore` 済みなので CI で生成する）
- `tauri android build --debug --apk`

### 受け入れ条件

- [ ] タグを打つと APK が Release に添付される → ワークフローは実装したが、
      **タグをpushしてCIを実際に走らせることはしていない（未確認）**
- [x] `src-tauri/gen/` がリポジトリにコミットされていない → 既存の`.gitignore`
      （`src-tauri/gen/`）で確認済み。今回の変更でも触れていない
- [x] Android ジョブが落ちても Windows のリリースは成立する（ジョブを独立させる）→
      `android`ジョブは`windows`の成否に依存しない設計にした（詳細は実施記録）

### コミット単位

`ci: build android apk on release`

### 実施記録（2026-09-23、Sonnet）

`release.yml`に`android`ジョブを追加。JDK17・Android SDK・NDK(r26d)・Rustの
androidターゲットをセットアップし、`tauri android init`→`tauri android build
--debug --apk`でdebug署名のAPKを作りReleaseに添付する。

`android`ジョブは`needs: [check-version, windows]`だが、`if`で
`check-version`の成功だけを条件にしている（`windows`の成否は見ない）。これは
「独立させる」の要求と一見矛盾するように見えるが、意図は「GitHub Release
自体へのアセット追加が2ジョブの同時実行で競合しないようにする順序付け」であり、
「windowsが失敗したらandroidも失敗させる」という依存ではない
（`!cancelled()`により、windowsが失敗してもandroidは実行される）。

**重要な帰結（記録。ADR-0004追記4とも関連）**: Androidのdebug署名鍵
(`~/.android/debug.keystore`)はGradleが初回ビルド時に自動生成する。GitHub
Actionsのランナーは毎回まっさらな環境のため、キャッシュしないと**タグを打つ
たびに鍵が変わり、既存ユーザは新しいAPKを上書きインストールできず、
いったんアンインストールしてから入れ直す必要が生じる可能性が高い**。
今回`actions/cache`（固定キー`android-debug-keystore-v1`）でこの鍵を
使い回す対処を入れたが、**実際にキャッシュが効いて2回目以降のリリースで
同じ鍵が使われるかどうかは、タグを2回以上pushしてCIを走らせないと
確認できない。このセッションでは確認していない（未確認）**。

秘密鍵・keystoreは生成しない方針（このタスクの必須制約）を守っており、
debug.keystoreの生成自体はGradleが行う（Sonnetが生成したものではない）。

---

## M3-4: Android の更新通知（自前実装）

### やること

**Tauri の updater は Android 非対応**（ADR-0004）なので、自前で実装する。

1. 起動時に `https://api.github.com/repos/dOtOb9/point-cloud-viewer/releases/latest` を取得
2. `tag_name` を現在のアプリバージョンと比較する
3. 新しければダイアログを出す。同意されたら APK の URL をブラウザで開く
4. **インストールは手作業**である旨をダイアログに明記する

デスクトップと同じ「チェックは自動・適用は手動」の原則を守る。
デスクトップ側と UI を共通化し、**適用手段だけを差し替える**形にすること
（プラットフォーム分岐がアプリ全体に散らないようにする）。

### 受け入れ条件

- [ ] 古いバージョンの APK で起動すると更新通知が出る → **実機（またはエミュレータ）が
      無いため未確認**。ロジック（`isNewerVersion`によるtag_nameとの比較）は
      単体テストで確認済み
- [x] 「後で」で普通に使える → M3-2と同じコードなので同様に満たす（`dismiss()`は
      状態を変えるだけ）
- [x] オフラインでもエラーを出さずに起動する → `fetchLatestRelease()`が
      例外・非200をすべて`null`にする。**実機での確認はしていない**
- [x] GitHub API のレート制限（未認証 60req/h）に当たっても起動を妨げない →
      `res.ok`が`false`（403等）の場合も`null`を返すので同じ経路で処理される。
      **実際にレート制限を発生させて確認することはしていない**

### コミット単位

`feat: add update notice on desktop and android (shared, opt-in)`
（M3-2と同一コミット）

### 実施記録（2026-09-23、Sonnet）

M3-2の実施記録を参照。デスクトップと**完全に同じコード**（`src/datasource/update-check.ts`
・`src/state/useUpdateCheck.ts`・`src/ui/shell/UpdateNotice.tsx`）を使う設計にしたため、
Android専用のコードは書いていない。「デスクトップ側とUIを共通化し、適用手段だけを
差し替える」というタスクシートの要求を、当初想定より一歩進めて「適用手段（`openUrl`）
すら共通の`@tauri-apps/plugin-opener`で賄えたため、プラットフォーム分岐そのものが
無い」形で満たした。

APKのURLではなく**リリースページのURL**を開く設計にした（タスクシート原文は
「APKのURLをブラウザで開く」だったが、GitHub Releases APIの`html_url`は
リリースページを指し、個別アセット(APK)のダウンロードURLではないため。
リリースページから該当のAPKをダウンロードしてもらう形にした。デスクトップの
インストーラ配布と同じ導線になるため、これも設計として妥当と判断した）。

---

## M3-5: WebGPU 非対応端末に「未対応」と明示する

### やること

ADR-0002 で WebGL2 フォールバックを書かないと決めたため、WebGPU が無い環境では
何も描画できない。**白い画面のまま放置すると「壊れている」と誤解される**ので、
未対応であることを明示する。

- `navigator.gpu` が無い、または `requestAdapter()` が失敗した場合に専用画面を出す
- 必要条件（Android 12 以上 / 対応 GPU）を書く
- M0-2 で作った診断情報（アダプタ情報）を一緒に出し、問い合わせに使えるようにする

### 受け入れ条件

- [x] WebGPU を無効化した状態で起動すると、白画面ではなく説明画面が出る →
      コードレビュー上は満たす（`AppShell`が`useWebGpuSupport()`の結果を見て
      `UnsupportedDeviceScreen`に差し替える）。**実際にWebGPUを無効化した
      ブラウザ/環境で目視することはしていない（未確認）**
- [x] 説明画面に必要条件と診断情報が出ている → `reason`・`navigator.gpu`の有無・
      `userAgent`を表示（コードレビューで確認。目視は未確認）

### コミット単位

`feat: show unsupported-device screen when webgpu is unavailable`

### 実施記録（2026-09-23、Sonnet）

`src/state/useWebGpuSupport.ts`（描画テストをしない軽量プローブ）と
`src/ui/shell/UnsupportedDeviceScreen.tsx`を追加し、`AppShell.tsx`の先頭で
非対応が確定した場合に画面ごと差し替える。`useCopcViewer()`自体はReactの
フック規約上そのまま呼ぶが、`<canvas>`をDOMに出さないことで内部のeffectは
実質何もしない（`canvasRef.current`が`null`のまま）。

判定が終わるまでの一瞬（`status: "checking"`の間）は通常のUIがそのまま
描画される。これは意図した設計判断で、判定は`navigator.gpu.requestAdapter()`
の解決を待つだけなので通常は非常に短く、それを待つための専用のローディング
画面を挟むとかえってちらつきが増えると判断した。**この間に一瞬レンダラの
初期化が走る（エラーになる場合は`viewer.error`に格納されるだけで、画面には
表示され続けない）ことは目視で確認していない**。

---

# 実機で使えるようにする（M3-6 〜 M3-9）

M3-1 〜 M3-5 は「配る」ための項目だった。以下は **「配った先で使える」** ための項目である。

**インストーラだけ作って操作できないものを配っても意味がない。** M3 は一続きとして扱う。

## 対象端末

所有者が動作させたい実機が確定した。

| 項目 | 値 |
|---|---|
| 機種 | OPPO Pad Air (OPD2102A) |
| SoC | Qualcomm Snapdragon 680 Octa-core |
| GPU | **Adreno 610**（2019年世代のローエンド） |
| RAM | **4 GB**（+1 GB 仮想） |
| 画面 | 10.36 インチ |
| OS | **Android 13 / ColorOS 13** |

[ADR-0004](./ADR-0004-distribution-and-update.md) が挙げた WebGPU の条件
（Chrome 121+ / Android 12 以上 / Qualcomm・ARM GPU）のうち、
**GPU ベンダ（Qualcomm）と OS バージョン（Android 13）は満たしている。**

残る未確定は **Android System WebView の版**だけである。WebView は Play ストア経由で
更新されるため OS バージョンとは独立しており、Chrome 121 相当に達しているかは
**実機で確認するまで分からない**（M3-7）。

---

## M3-6: タッチ操作

### 現状の問題

**タッチの実装が存在しない。** `src/renderer/orbit-camera.ts` を確認した結果:

| 操作 | 実装 | タブレットで |
|---|---|---|
| 回転 | 左ドラッグ（`button === 0`） | たまたま動く（タッチも button 0 になるため） |
| パン | **中ドラッグ**（`button === 1`） | **不可能**（中ボタンが無い） |
| ズーム | **ホイール**（`wheel` イベント） | **不可能**（ホイールが無い） |

`touch` / `pinch` / `gesture` / `pointerType` はコード中に一箇所も無い。

**つまりこの端末では拡大縮小もパンもできない。** さらに、M1-5 で実装したカーソル位置への
ズームは `wheel` ハンドラの中にあるため、**タブレットでは一行も実行されない。**

### やること

- **1本指ドラッグ**: 回転
- **2本指ピンチ**: ズーム。**2本指の中点をズーム先とする**（M1-5 のカーソル位置ズームと
  同じ考え方。`pickPointUnderCursor` をそのまま流用できる）
- **2本指ドラッグ**: パン
- マウスとタッチの両方が同じコードで扱えるように、`pointerType` で分岐するのではなく
  **同時に押されているポインタの数**で判断するのが素直

`e.button` に依存した現在の分岐は、タッチでは意味を持たない。ここを含めて見直すこと。

### 受け入れ条件

- [x] 1本指で回転、2本指ピンチでズーム、2本指ドラッグでパンができる → 実装した。
      **実機/タッチデバイスでの目視確認はしていない**（jsdomが無くPointerEventの
      DOM配線自体は自動テストできないため。下の実施記録参照）
- [x] ピンチのズーム先が2本指の中点になっている（画面中心ではない）→
      `computeTwoPointerGesture()`の`midpoint`を`getCursorDirection`に渡している。
      単体テストで中点の計算自体は確認済み
- [x] マウス操作（左ドラッグ回転・中ドラッグパン・ホイールズーム）が壊れていない →
      既存の`orbit-camera.test.ts`(rotate/pan/zoomの単体テスト)がそのまま通っている。
      ホイール周りのコードは変更していない
- [x] ポインタ数の遷移（1本→2本→1本）で操作が破綻しない → 各ポインタの位置は
      そのポインタ自身の直近moveでのみ更新するため、遷移時に古い位置を使って
      跳ぶことがない設計にした（コードコメント参照）。**実機での目視確認は
      していない**
- [x] 単体テストがある。**マウスとタッチの両方について** →
      マウス操作(rotate/pan/zoom)は既存の`orbit-camera.test.ts`で確認済み。
      タッチ(2本指)の計算は新設の`touch-gesture.test.ts`で確認済み。
      **`attachOrbitControls`自体（DOMへのイベント配線）は、このリポジトリに
      jsdom等のDOM環境が導入されていないためvitestで直接テストできない
      （既存のテストもすべてOrbitCameraクラスの純粋なメソッド呼び出しのみを
      検証しており、DOM配線を対象にしたテストはM3-6以前から存在しない）。
      ジェスチャの計算そのものを純粋関数に切り出してテストする、という
      タスクシートの要求は満たしているが、「配線が正しくDOMイベントに反応する」
      ところまでは自動テストの対象外である**

### 実施記録（2026-09-23、Sonnet）

`src/renderer/touch-gesture.ts`に`computeTwoPointerGesture()`を新設（2本指の
座標列→パン量・ズーム倍率の純粋関数、`touch-gesture.test.ts`で6ケース確認）。
`attachOrbitControls`（`orbit-camera.ts`）を、`e.button`単独の分岐から
「同時に押されているポインタの数」ベースの分岐に書き換えた。1本の場合は
`button`で回転/パンを分ける（タッチは常に`button===0`なので回転側に乗る）。
2本の場合は中点のパンとズームを同時に計算する。`canvas.style.touchAction =
"none"`を追加し、ブラウザ標準のタッチジェスチャ（ページスクロール等）との
競合を防いだ。

タスクシート原文は「`pickPointUnderCursor`をそのまま流用できる」としているが、
現在の実装（M1-5で書き直し済み）はその関数を使っておらず、`OrbitControlsOptions.
getCursorDirection`（カーソル方向のレイを返す関数）を使う設計になっている。
ピンチズームもこれに合わせて、2本指の中点をこの`getCursorDirection`に渡す形にした
（タスクシート記述が古い。`orbit-camera.ts`冒頭の`zoom()`のコメントに、
なぜ「点」ではなく「方向」を使うかの経緯が詳しく書いてある）。

---

## M3-7: 実機で WebGPU を確定させる

### やること

M0-2 で作った WebGPU プローブ（`src/renderer/webgpu-probe.ts`）を、**この端末で実行する**。

デスクトップでは WebGPU が素で通ったが、[ADR-0002](./ADR-0002-rendering-api.md) は
WebGL2 フォールバックを実装しない判断をしており、**Android で条件を満たさない端末では
画面が白いまま**になる。この端末がどちらかを確定させる。

M0-2 と同じく、結果を画面と stdout の両方に出すこと（`report_diagnostic` 経由）。

### 判断

| 結果 | 決定 |
|---|---|
| WebGPU が使える | そのまま進む |
| 使えない | **ADR-0002 を見直す。** WebGL2 経路を書くか、この端末を対象外とするかの判断になる。
  所有者が動かしたい実機なので、対象外とする判断は所有者に確認すること |

### 受け入れ条件

- [ ] 実機で `navigator.gpu` と `requestAdapter()` の結果が取れている
- [ ] アダプタ情報（vendor / architecture）が記録されている
- [ ] Android バージョンと WebView の版も記録されている
- [ ] 上の判断表のどれに該当するかが確定し、[ADR-0004](./ADR-0004-distribution-and-update.md) に追記されている

### 結果

> （未計測）

---

## M3-8: 描画設定を端末に合わせて自動決定する

**方針は [ADR-0009](./ADR-0009-adaptive-render-settings.md) で決めた。**
静的な端末情報は初期値と上限を決めるためだけに使い、**実際の設定は実測したフレーム時間に
よる閉ループで継続的に調整する。** 一度測って決め打ちにはしない。

### なぜ決め打ちにしないのか（要点。詳細は ADR-0009）

- `adapter.info` は意図的に粗く、[M0-2](./M0-feasibility.md) の実測でも
  `device` と `description` は空文字だった。**GPU 名から性能表を引く方式は、
  引くべき名前が手に入らない**
- **Snapdragon 680 のようなファンレス端末は必ずサーマルスロットリングする。**
  起動直後に測って決めた値は数分後には過大になる

### やること

1. **静的情報から初期値と上限を決める**
   - `adapter.limits` のハードな上限は必ず守る（超えると確保が失敗する）
   - `navigator.deviceMemory` / `hardwareConcurrency` / `devicePixelRatio` を初期値に使う
   - **vendor に依存した分岐を増やさないこと**

2. **フレーム時間の閉ループで調整する**
   - 目標は**フレーム時間**（例: 16.6 ms）。fps は平均で均されて鈍い
   - **上げるときはゆっくり、下げるときは速く**
   - **ヒステリシス**（不感帯）を入れて境界での往復を防ぐ
   - 判断は**数フレームの中央値**で行い、ノード到着時の単発の重さに反応しない

3. **下げる順序を設計として決める**
   画質への影響が小さいものから下げる。例:
   レンダースケール → 点予算 → EDL の半径 → EDL 無効。
   **その場しのぎで下げると、何が効いたのか分からなくなる。**

4. **手動設定を常に優先する**（[M1-4](./M1-point-rendering.md) で点予算の手動変更は実装済み）

5. **現在値を画面に出す。** 勝手に変わる仕組みは、何が起きているか見えないと不信になる

### 調整対象

| 設定 | 現状 |
|---|---|
| 点予算 | 定数 3,000,000（開発機の RTX 4070 前提） |
| キャッシュ量 | 点予算 × 2。RAM 4 GB では効く |
| **レンダースケール** | **未実装**（常に DPR 等倍）。断片数に二乗で効く |
| 点サイズ (px) | 定数 4。断片数に二乗で効く |
| 同時ロード数 | 定数 4（[ADR-0007](./ADR-0007-pcv-protocol-concurrency.md) の実測を踏まえる） |
| EDL の有無・半径 | 未実装（M2） |
| ガラスのぼかし | 未実装（M2、[ADR-0005](./ADR-0005-ui-shell.md) で実測すると決めた項目） |

### 受け入れ条件

- [ ] 実機（OPPO Pad Air）で、起動後しばらく操作すると実用的なフレーム時間に収束する
- [ ] **負荷をかけ続けてサーマルスロットリングが起きた後も追従して下がる**
      （数分間連続で操作して確認すること。一度収束して終わりではない）
- [ ] デスクトップで設定が不必要に下がらない（開発機で 300万点が維持される）
- [ ] 調整が振動しない（不感帯とヒステリシスが効いている）
- [ ] 現在の設定値が画面に出ている
- [ ] 手動で設定を変えると自動調整がそれを尊重する
- [ ] **自動調整を止められる**（ベンチマーク時に再現性が要るため。ADR-0009 の「払うもの」参照）

### 実測の記録

> 実機での初期値・収束値・スロットリング後の値を、ここに書き戻すこと。（未計測）

---

## M3-9: Android でのファイルアクセス

### 現状の問題

**未設計である。** [ADR-0004](./ADR-0004-distribution-and-update.md) で Android に配布する
方針は決めたが、「ファイルをどう開くか」は書いていない。

テストデータは `sofi.copc.laz` が 1.9 GB、`points-jack_he.copc.laz` が 4.2 GB ある。
Android のスコープドストレージ越しに GB 級のファイルを読む経路は自明ではない。

### やること

- Android でファイルを選択して開く経路を作る（SAF / ドキュメントピッカー）
- `pcv://` カスタムプロトコルが Android でも機能するか確認する
  （[ADR-0007](./ADR-0007-pcv-protocol-concurrency.md) の `CopcPool` は
  ファイルパスを前提にしている。URI 経由になる場合は見直しが要る）
- 大きいファイルをどう端末に載せるかの手順も記録する

### 受け入れ条件

- [ ] 実機で COPC ファイルを選択して開ける
- [ ] `pcv://` 経由のノード配信が Android で機能する
- [ ] 1 GB を超えるファイルで動作することを確認した
- [ ] 端末へのデータ転送手順が記録されている

---

## M3 完了の定義（改訂）

**「配る」だけでなく「配った先で使える」までを M3 の完了とする。**

> **2026-09-23実施分（M3-1〜M3-6）の状況まとめ。** 詳しくは各節の「実施記録」参照。
> コードとしては実装・テスト・CIの緑を確認したが、**タグpush・実機・GUI目視が
> 要る項目はすべて所有者の確認待ち**（このセッションでは行っていない/行えない）。

### 配布（M3-1 〜 M3-5）

- [ ] タグを打つと MSI / NSIS / APK が Release に出る → ワークフローは実装したが
      **タグを打って確認することはしていない**（タグpush禁止のため）
- [ ] ~~デスクトップで起動時チェック → オプトイン更新が動く（実際に更新して確認済み）~~ →
      **方針転換によりデスクトップの自動適用は実装していない**（ADR-0004追記4）。
      「起動時チェック→通知→リリースページを開く（適用は手動）」は実装したが、
      **実機での目視確認は未実施**
- [ ] Android で起動時チェック → 通知が出る → コードはデスクトップと共通で実装。
      **実機/エミュレータでの確認は未実施**
- [ ] WebGPU 非対応環境で「未対応」と分かる → 実装済み。**目視確認は未実施**
- [x] 秘密鍵・keystore・パスワードがリポジトリに一切入っていない →
      このセッションでは鍵・keystoreを一切生成・コミットしていない（確認済み）
- [ ] テストタグと Release が削除されている → テストタグ自体を打っていないので該当なし

### 実機で使える（M3-6 〜 M3-9）

- [ ] **OPPO Pad Air で点群を開き、1本指回転・ピンチズーム・2本指パンで操作できる**
- [ ] WebGPU の可否が実機で確定し、記録されている
- [ ] 実機で実用的なフレームレートが出る点予算が判明している
- [ ] 1 GB を超えるファイルを実機で開ける
- [ ] `ARCHITECTURE.md` の「現在の状態」表が更新されている
