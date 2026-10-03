# I-1: Dock を ui-forge の生成物に置き換える

- 状態: 未着手（ui-forge 側の I-0 が main に入ってから着手する）
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

（実装者が記入する）
