# I-1: Dock を ui-forge の生成物に置き換える

- 状態: 完了（受け入れ基準1〜6。7〜8は所有者の目視待ち）
- 前提: [ADR-0014](./ADR-0014-ui-forge.md)、[ADR-0005](./ADR-0005-ui-shell.md)

## やること

`src/ui/shell/Dock.tsx` を、ui-forge が `Dock.ui` から生成したコンポーネントで置き換える。
**見た目と振る舞いは変えない。** ADR-0014 の構成（`Dock.ui` / `Dock.generated.tsx` / 薄い `Dock.tsx`）にする。

### 1. ui-forge を依存に入れる

```json
"devDependencies": { "ui-forge": "github:dOtOb9/ui-forge#<ref>" }
```

- `<ref>` は ui-forge に `v0.1.0` 以降のタグがあればそのタグ、無ければ I-0 が入った後の
  main のコミット SHA。どちらにしたかを実装記録に書く（後でタグに切り替えるため）
- `package.json` に scripts を足す:
  - `"ui:gen": "ui-forge gen src/ui/shell/Dock.ui src/ui/shell/Dock.generated.tsx"`
  - `"ui:check": "ui-forge check src/ui/shell/Dock.ui src/ui/shell/Dock.generated.tsx"`
  - 対象のファイルは今は 1 組だけなので、一覧を scripts に直書きする（汎用の探索は作らない）

### 2. `Dock.ui` を書く

ui-forge の `examples/Dock.ui`（I-0 で `layer` と `textSize` が足されたもの）を出発点にする。
`"$schema"` は `../../../node_modules/ui-forge/schema/ui.schema.json` を指す（VS Code の補完のため）。

### 3. `Dock.tsx` を薄い包みにする

```tsx
// レイアウトと見た目は Dock.ui（ADR-0014）。ここはロジックだけを持つ。
export function Dock({ glassEnabled, ...rest }: Props) {
  return <GeneratedDock {...rest} surface={glassEnabled ? "glass" : "opaque"} />;
}
```

- `Props` は今の `Dock.tsx` と同じ（`AppShell.tsx` は変更しない）
- 今の `Dock.tsx` にある ADR-0005 のコメント（ハイライトの理由など）は、意味が残る形で
  `Dock.tsx` か `Dock.ui` の近く（`Dock.ui` は JSON でコメントが書けないので `Dock.tsx` 側）に残す

### 4. CI

`.github/workflows/ci.yml` の npm のジョブに `npm run ui:check` を足す（`npm run typecheck` の前）。
`Dock.ui` だけを直して生成し忘れると CI が落ちる。

### 5. 生成物を lint / 書式検査の対象にするか

生成物は人間が直さないので、ESLint の対象から外してよい（`eslint.config.js` の ignores に
`**/*.generated.tsx`）。外すかどうかと理由を実装記録に書く。

### 6. 記録

`ARCHITECTURE.md` の構成図と状況の表、`docs/book/src/frontend/ui-shell.md`（Dock の節）、
`TaskSheets/HANDOFF.md` を更新する。ROADMAP には載せない（機能ではなく作り方の変更のため）。

## 受け入れ基準

1. `npm run typecheck` / `lint` / `test` / `build` / `ui:check` が通る
2. 置き換え前後で、ドックのボタン 3 つのクラスと、ドックの外枠のクラスの集合が一致する
   （外枠は、生成物では `Canvas` の層と `Panel` と `HBox` の 3 つの要素に分かれる。
   その 3 つのクラスの和集合が、元の外枠のクラスから `fixed` を除き `absolute` `inset-0`
   `pointer-events-none` を足したものと一致すること）。`glassEnabled` が true / false の両方について、
   `renderToStaticMarkup` で確かめるテストを書く
3. `layerOpen` / `infoOpen` に応じてボタンのハイライトが切り替わること、各ボタンを押すと対応する
   コールバックが呼ばれることをテストで確かめる
4. `Dock.ui` の `"gap": "xs"` を `"gap": "huge"` にすると `npm run ui:check` が失敗する（確かめた後に戻す）
5. 規約 2（Tauri の import は `src/datasource/tauri.ts` だけ）の CI 検査が引き続き通る
6. `mdbook build docs/book` が通る

所有者の目視:

7. デスクトップ・Web・Android で、ドックの見た目と挙動が置き換え前と同じ（ガラス / 不透明の両方）
8. ui-forge のプレビューアプリで `src/ui/shell/Dock.ui` を開き、ラベルを変えて `npm run ui:gen` すると、
   本体のドックに反映される

## 範囲外

- `Dock` 以外のパネルの置き換え（ADR-0014 の判断基準を見てから）
- ui-forge 側の変更（語彙が足りなければ、ここでは止めて報告する）

## 実装記録

### 1. ui-forge を依存に入れる

ui-forge にはまだ `v0.1.0` 以降のタグが無いため、I-0 が入った後の main のコミット
`19f02462ef7af49e7d07dbe268fd6d3fb986bdc2`（短縮形 `19f0246`。`git -C <ui-forge> rev-parse 19f0246`
で確認済み）に固定した。

```json
"ui-forge": "github:dOtOb9/ui-forge#19f02462ef7af49e7d07dbe268fd6d3fb986bdc2"
```

**タグ `v0.1.0` が切られたら、`package.json` のこの行を `"github:dOtOb9/ui-forge#v0.1.0"`
（または npm の通常の semver 指定）に切り替えること。** コミット SHA 固定は「ui-forge 側が
force-push 等で main の履歴を書き換えても、この依存だけは動かない」という利点はあるが、
タグより読みにくい。

`package.json` に `ui:gen` / `ui:check` の scripts を追加した（タスクシートどおり、対象ファイルを
直書き。汎用の探索は作らない）。

### 2. `Dock.ui` を書く

ui-forge の `examples/Dock.ui`（I-0 で `layer`/`textSize` が足された状態）を見たところ、
`component` 以外はそのまま point-cloud-viewer の `Dock.tsx` の値（ラベル・bind名・event名・
`gap: xs`・`padding: xs`・`radius: full`・`shadow: true`・`textSize: sm`・
`slot: {anchor: bottom-center, margin: md}`）と一致していたため、`component` だけ変えて
`src/ui/shell/Dock.ui` として採用した。

**`"component"` は `"DockLayout"` にした**（タスクシートが懸念した「生成物の名前が薄い包みの
`Dock` と衝突する」問題の回避）。他の案（`DockGenerated`、`DockView`）より、「レイアウトの層」
であることが名前から読めることを優先した。

`$schema` は `"../../../node_modules/ui-forge/schema/ui.schema.json"`（VS Code 補完用。
`npm install` 後にファイルが存在することを確認済み）。

`npx ui-forge fmt src/ui/shell/Dock.ui` を実行したが、差分は出なかった（手で書いた時点で
正規化済みの形になっていた）。

### 3. `Dock.tsx` を薄い包みにする

`DockLayout` を `./Dock.generated` から import し、`glassEnabled ? "glass" : "opaque"` を
`surface` として渡すだけにした。旧 `Dock.tsx` にあった `ACTIVE_CLASS`/`INACTIVE_CLASS`・
`glassSurfaceClass` の呼び出しは無くなった（それぞれ ui-forge の `src/core/styles.ts` の
`BUTTON_ACTIVE_CLASS`/`BUTTON_INACTIVE_CLASS`・`SURFACE_CLASS` に値そのまま移っている。
文字列は同一であることを受け入れ基準2のテストで確認済み）。

ADR-0005 の「開いている側のボタンをハイライトする」理由のコメントは、`Dock.ui` が JSON で
コメントを持てないため `Dock.tsx` に残した（意味を保つよう、ハイライトの実クラスが
`Dock.ui` のどのプロパティ・どのファイルに対応するかも書き添えた）。

### 4. CI

`.github/workflows/ci.yml` の `frontend` ジョブに `npm run ui:check` を `npm run typecheck` の
前に追加した。

### 5. 生成物を lint の対象にするか

**ESLint の対象から外した**（`eslint.config.js` の `ignores` に `**/*.generated.tsx`）。
理由: `Dock.generated.tsx` は人間が直さないファイルであり、内容の正しさ（`Dock.ui` と
同期しているか）は `npm run ui:check` が別途保証する。ESLint にかけても「生成されたコードが
ESLint のルールに沿っているか」を検査するだけで、`Dock.ui` の記述が正しいかには関与しない。
typecheck の対象からは外していない（`tsconfig.json` の `include: ["src"]` にそのまま含まれ、
`DockLayoutProps` の型が `Dock.tsx` の呼び出しと合っているかは `tsc` が見る）。

### 6. 記録

ARCHITECTURE.md（ディレクトリ図・状況表）、`docs/book/src/frontend/ui-shell.md`（`Dock` の節に
小見出しを追加）、`TaskSheets/HANDOFF.md`（決めたこと・まだ確かめていないことの表）を更新した。
ROADMAP.md は変更していない（機能の変更ではないため、タスクシートの指示どおり）。

### 受け入れ基準2の式についての2つの補正（実測して分かったこと）

タスクシートの式は「元の外枠のクラスから `fixed` を除き `absolute` `inset-0`
`pointer-events-none` を足したものと一致する」だったが、実際に生成された3要素
（`Canvas`/`Panel`/`HBox`）のクラスを調べると、次の2点が式と食い違う。どちらも
**見た目には影響しない**ことを確認済みで、`Dock.test.tsx` はこの実測どおりの式で
書いてある。

1. **`fixed` は消えずに残る。** ui-forge の `Canvas` 自身が `CANVAS_CLASS`
   （`"pointer-events-none fixed inset-0"`）を持つ。旧外枠に対応する `Panel` は
   `fixed` → `absolute` に変わる一方、新しく挟まった `Canvas` が `fixed` を引き継ぐ。
   そのため正しい式は「元のクラスから `fixed` を引く」のではなく、**「元のクラスに
   `absolute` `inset-0` `pointer-events-none` を足すだけ」**（`fixed` はそのまま残る）。
   これは ADR-0014 自身が明記している「`Canvas`（`fixed inset-0` の層）の中にドックを置く」
   という記述と整合している。
2. **`items-stretch` が増える。** `HBox` の `align` を省略すると、ui-forge の
   `generate.ts`（`pushEnumClass`）が既定値 `stretch` のクラス（`items-stretch`）を
   常に書き出す仕様になっている（`gap`/`padding` は既定値が空文字なので付かないが、
   `align` の既定値だけ非空のため付く）。横一列 flex の `align-items` の既定の挙動と
   同じクラスなので、見た目は変わらない。

どちらも ui-forge 側のコード（`src/core/styles.ts`・`src/codegen/generate.ts`）を見て
確認した事実で、ui-forge 側は変更していない（指示どおり「語彙が足りなければ止めて報告する」
対象ではなく、語彙の表現力の問題ではないため、報告した上でテストの期待値側を実測に
合わせた）。

### テスト（受け入れ基準2・3）

既存のコードベースには React コンポーネントのテストが無かった（`src/ui/` 配下に
`*.test.*` が無い）。`@testing-library/react` 等を増やさず、`react-dom/server` の
`renderToStaticMarkup`（基準2）と `react-dom/client` の `createRoot` + `act`（基準3）を
直接使う形にした。理由: 依存を1つ(`jsdom`)に絞れる、既存のテストと書き方の質感が
揃う（このリポジトリの既存テストは外部ライブラリに頼らない素の vitest が多い）。

`jsdom` は `devDependencies` に追加。最新版（30.x）は Node の実行環境要件
（`^22.22.2` 等）がこちらの Node（`v22.16.0`）より新しく、`npm install` が
`EBADENGINE` 警告を出したため、Node `>=18` の `jsdom@26.1.0` に固定した。

`Dock.test.tsx` の環境は `// @vitest-environment jsdom`（このファイルだけ jsdom。
他のテストは既定の node 環境のままなので全体の実行時間は変わらない）。

### 所有者が確かめる手順（受け入れ基準7・8）

7. デスクトップ（`npm run tauri dev`）・Web（`npm run dev` をブラウザで）・Android で、
   画面下部中央のドックの見た目（ガラス/不透明の両方。設定画面の「ガラス表現」を
   オン/オフして比較）とボタンの挙動（レイヤー/情報パネルの開閉、設定モーダルを開く、
   開いている側がハイライトされる）が、この変更の前と同じに見えることを確認する。
8. ui-forge 側（`C:\rust\ui-forge`）で `npm run dev` のプレビューアプリから
   `src/ui/shell/Dock.ui`（point-cloud-viewer側のファイル）を開き、たとえば
   `settings_button` の `label` を「設定」から別の文字列に変えて保存し、
   point-cloud-viewer 側で `npm run ui:gen` を実行すると、`Dock.generated.tsx` が
   更新され、`npm run tauri dev`（または `npm run dev`）で見ているドックのラベルが
   変わることを確認する。確認後はラベルを元に戻し、`npm run ui:gen` を再実行して
   `Dock.generated.tsx` を元の内容に戻す。

### 追記（Opus、2026-10-04）: タグへの切り替えと改行コード

- ui-forge の `v0.1.0` が出たので、依存を `github:dOtOb9/ui-forge#v0.1.0` に切り替えた。
  `v0.1.0` には F2（エディタ）も入っている。生成物は変わらない（`ui:check` で確認）
- origin/main の M4-8 などの上に rebase したところ、`core.autocrlf=true` のせいで `Dock.ui` が
  CRLF で書き直され、`npm run ui:check` が「正規化されていません」で落ちた
  （ui-forge の正規化は LF。CI の Linux では起きない）。`.gitattributes` で `*.ui` と
  `*.generated.tsx` を常に LF にして解決した
