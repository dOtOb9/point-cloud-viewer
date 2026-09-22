# M3: リリース配布と自動更新

- 状態: 未着手（**所有者の事前作業あり。下記「着手前に所有者がやること」を参照**）
- 前提: [ADR-0004](./ADR-0004-distribution-and-update.md)

## このマイルストーンの目的

タグを打つと **Windows の MSI / NSIS と Android の APK が GitHub Releases に出る**ようにし、
**既存アプリが起動時に新バージョンを検知して、ユーザが同意したときだけ更新する**ようにする。

M1 / M2 の描画機能とは独立しているため並行して進められるが、**最初の実タグ（v0.1.0）は
M1 が着地してから打つ**。中身が動かないインストーラを配っても意味がないため。

---

## 着手前に所有者がやること（これだけは代行できない）

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

### バージョンの扱い

タグ `v0.1.0` と `tauri.conf.json` の `version` が食い違うと、updater が更新を検知できない
（あるいは無限に更新を促す）。**ワークフローの最初にタグとバージョンの一致を検査し、
違っていたら落とすこと。** 黙って進めない。

### 受け入れ条件

- [ ] `v0.0.1-test` のようなテストタグを打つと Release が作られ、`.msi` / `.nsis` /
      `latest.json` が添付される
- [ ] `latest.json` に署名（`signature` フィールド）が入っている
- [ ] タグと `tauri.conf.json` の version が食い違うとワークフローが落ちる（**実際に試すこと**）
- [ ] テストタグと Release は確認後に削除する

### コミット単位

`ci: add release workflow for windows installers`

---

## M3-2: デスクトップの自動更新（オプトイン）

### やること

`tauri-plugin-updater` を導入し、**起動時チェック → ダイアログ → 同意したときだけ適用**の
導線を作る。

1. Rust 側: `tauri-plugin-updater` を追加、`tauri.conf.json` に `plugins.updater`
   （`endpoints` と `pubkey`）を設定
2. フロント側: 起動時に `check()` を呼ぶ。**新しいバージョンがあった場合のみ**ダイアログを出す
3. ダイアログには新バージョン番号とリリースノートを出す。「今すぐ更新」「後で」を選べる
4. 同意されたらダウンロード進捗を出し、完了後に再起動を促す

### 守ること

- **黙って更新しない。** 同意なしにダウンロードもインストールもしない（ADR-0004）
- **開発中（`tauri dev`）はチェックしない。** 毎回ダイアログが出て邪魔になる
- チェックが失敗しても（オフライン等）**アプリは普通に起動する。** 更新チェックの失敗で
  起動を止めない
- 規約2 は updater にも適用される。`@tauri-apps/plugin-updater` の import も
  `src/datasource/` 配下か、それに準じた1ファイルに閉じ込めること。
  **Web 版にはそもそも updater が不要なので、Web ビルドで剥がせる形にする**

### 受け入れ条件

- [ ] 古いバージョンをインストールした状態で起動すると更新ダイアログが出る
- [ ] 「後で」を選ぶと何もダウンロードされず、アプリが普通に使える
- [ ] 「今すぐ更新」で更新が適用され、再起動後にバージョンが上がっている
- [ ] オフラインで起動してもエラーダイアログを出さずに普通に起動する
- [ ] `tauri dev` では更新チェックが走らない
- [ ] CI の invariants ジョブが緑のまま（規約2 を壊していない）

### 自分で確かめる手順

```bash
# 1. v0.0.1-test をリリースする
# 2. その installer をインストールする
# 3. version を上げて v0.0.2-test をリリースする
# 4. インストール済みアプリを起動 → ダイアログが出るか
# 5. 「後で」→ 普通に使えるか / 再起動 → また出るか
# 6. 「今すぐ更新」→ 更新されるか
```

### コミット単位

`feat: add opt-in updater on desktop`

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

- [ ] タグを打つと APK が Release に添付される
- [ ] `src-tauri/gen/` がリポジトリにコミットされていない
- [ ] Android ジョブが落ちても Windows のリリースは成立する（ジョブを独立させる）

### コミット単位

`ci: build android apk on release`

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

- [ ] 古いバージョンの APK で起動すると更新通知が出る
- [ ] 「後で」で普通に使える
- [ ] オフラインでもエラーを出さずに起動する
- [ ] GitHub API のレート制限（未認証 60req/h）に当たっても起動を妨げない

### コミット単位

`feat: add update check on android`

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

- [ ] WebGPU を無効化した状態で起動すると、白画面ではなく説明画面が出る
- [ ] 説明画面に必要条件と診断情報が出ている

### コミット単位

`feat: show unsupported-device screen when webgpu is unavailable`

---

## M3 完了の定義

- [ ] タグを打つと MSI / NSIS / APK が Release に出る
- [ ] デスクトップで起動時チェック → オプトイン更新が動く（実際に更新して確認済み）
- [ ] Android で起動時チェック → 通知が出る
- [ ] WebGPU 非対応環境で「未対応」と分かる
- [ ] 秘密鍵・keystore・パスワードがリポジトリに一切入っていない
- [ ] テストタグと Release が削除されている
- [ ] `ARCHITECTURE.md` の「現在の状態」表が更新されている
