# ADR-0022: 状態と手順は Elm の TEA（Model / Msg / update / view）の形にする

- 状態: 採択（所有者の方針 2026-11-16「Elm のような TEA の構造を参考にするとよくなる」。細部はコーディネーターが決めた）
- 日付: 2026-11-16
- 関係: [ADR-0021](./ADR-0021-thin-react.md)（React は表示だけ。RF-5 の改訂で「状態はクラスでない小さなストア」）、
  [REVIEW-architecture-2026-11](./REVIEW-architecture-2026-11.md) の A-2（`useState`＋ref の二重持ち）・A-12（`CopcViewerState` 57 欄）、
  [ADR-0023](./ADR-0023-plugins.md)（プラグイン。各プラグインがこの形の1単位になる）

## 決定

ADR-0021 の RF-5 の改訂（`{ get, set, subscribe }` のストア）を一歩進め、**状態を変える道を `dispatch(msg)` の1本にする**。

```ts
// src/app/tea.ts（約 60 行の想定。ライブラリは入れない）
type Effect<Msg> = (dispatch: (msg: Msg) => void) => void | Promise<void>;
type Update<Model, Msg> = (model: Model, msg: Msg) => [Model, Effect<Msg>[]];

function createProgram<Model, Msg>(init: Model, update: Update<Model, Msg>): {
  getModel(): Model;
  dispatch(msg: Msg): void;
  subscribe(listener: () => void): () => void;
};
```

- **Model**: 1つの関心（視点・表示範囲・計測・土量・レイヤー一覧…）の状態。読み取り専用のただのオブジェクト
- **Msg**: 起きたこと（`{ type: "presetClicked", preset: "top" }`、`{ type: "volumeFinished", result }`）。判別可能な union
- **update**: `(model, msg) -> [新しい model, 効果の一覧]` の**純粋な関数**。I/O・レンダラ・時刻・乱数に触らない。テストは入力と出力を比べるだけ
- **Effect**: I/O（`DataSource`、レンダラ、ファイルの保存、タイマー）をするのはここだけ。結果は `dispatch` で Msg として戻す。
  効果は `src/app/` の普通の関数で、必要な物（DataSource・レンダラ）はプログラムを作るときに閉じ込める
- **view**: React の部品は `useProgram(program, select)`（`useSyncExternalStore` の薄い包み）で Model を読み、操作されたら `dispatch` するだけ
- **Subscriptions**: キー入力・レンダラの stats・ポインタのような外から来る出来事は、登録する関数が Msg に変えて `dispatch` する

## なぜ

- A-2 の ref の箱は「非同期の手順が、始まった後の最新の状態を読みたい」から生まれた。TEA では手順の続きは Msg として戻ってきて、
  その時点の Model を受け取る `update` が判断する。**最新値を読みに行く必要そのものが無くなる**
- 「何が状態を変えうるか」が Msg の union を見れば全部分かる。所有者が追える（CLAUDE.md の最優先）。F12 で `update` に飛べば遷移が全部ある
- 遷移の不具合（カメラが動いたら多角形を捨てる、3点未満では確定しない、結果が届いたときにレイヤーがもう無い）が、React も GPU も無しでテストできる
- ADR-0021 の「クラスにしない・副作用を見えるようにする」とそのまま合う。副作用は `Effect` という名前の付いた場所にしか無い

## 採らなかった案

- **Redux / Zustand / XState などのライブラリ**: 60 行で書ける物に依存を足さない。REVIEW の「状態管理ライブラリの導入はやらない」と同じ
- **アプリ全体で Model を1つ（Elm そのまま）**: 57 欄の `CopcViewerState` を1つの巨大な Model に移すだけになる。関心ごと（プラグインごと）に1プログラムにし、
  プログラム同士は Msg ではなく、ホストの API（ADR-0023）を通して話す
- **`{ get, set, subscribe }` のまま（RF-5 の改訂のまま）**: `set` がどこからでも呼べるので、変える道が散る。手順の続きが最新を読むために `get()` を呼ぶ形が残る

## 移行

- 「触ったところから」（ADR-0015）。新しい機能（TP-2・TP-3）は最初からこの形。既存は RF-4・RF-6 とプラグイン化（ADR-0023）で関心ごとに移す
- TP-1 で作った `{ get, set, subscribe }` のストアは、プラグイン化のときにこの形に移す
- `src/state/use*` のフックは、移し終えたものから消す

## 受け入れの目安（PL-0 のタスクで確かめる）

- `src/app/tea.ts` に `createProgram` とテスト（効果が順に走る、効果の中の `dispatch` が次の `update` に届く、効果の例外が Msg のエラーとして戻る）
- 効果の例外を黙って捨てない（ADR-0015: 既存のエラーのバナーとログに流す）
