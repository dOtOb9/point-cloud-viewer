# RF-safety-net: 安全網（RF-0 文書、RF-1 層の規約の検査、RF-15 wasm の鮮度）

- 元: [REVIEW-architecture-2026-11.md](./REVIEW-architecture-2026-11.md) の A-3・A-6・A-9 と、RF-0・RF-1・RF-15
- 作業: 作業エージェント（ブランチ `trendpoint-parity`、開始時の HEAD `9a312db`）
- 方針: 振る舞いは変えない。push しない。CI は手元で動かせないので、`ci.yml`・`pages.yml` の変更は「同じコマンドを手元で実行して確かめた」ことと「CI では未確認」を分けて書く

---

## RF-0 文書を現状に合わせる

### やったこと

- `TaskSheets/ARCHITECTURE.md`
  - ディレクトリの図を実際に合わせた: `src/app/`・`crates/pcv-convert/`・`vendor/`・`e2e/`・`scripts/`・`docs/book/`・`src/ui/toolbar/`・`src/ui/section/` を足し、
    無い `ribbon/` を消した。`src/ui/tools/` の説明を、いまある物（抽出・間引き・フィルタ・DTM・視点・ラスタの窓）に直した
  - 規約の数: 「この4つが崩れると」→「この5つ」。規約 1・2・3・5 が `invariants` ジョブの検査で、4 は検査の対象外と明記（CLAUDE.md の書き方に合わせた）
  - 規約 3 の後半（`src/ui/` はレンダラを直接触らない）は、検査されておらず実際には破られていると書いた（A-3）。決め直しは RF-1 で行う
  - 「WebGPU の API を直接叩くのは `gpu-resources.ts` だけ」を取り消した。`edl.ts`・`sky.ts`・`ground-grid.ts`・`depth-pick.ts` も `device.create*` を呼ぶ（`grep` で 5 ファイルを確かめた）
  - 状態の表: I-1（`Dock.ui`・ui-forge。削除済み）の行を消した。M4-9 の「Web版へは未配線」を「R7 で配線済み」に直した。
    ピック・計測・抽出・結合、断面、ラスタ・DTM・間引き・フィルタ、視点（TP-1）の行を足した
  - 末尾に「これから」の節を足した。ADR-0022（TEA）・ADR-0023（プラグイン）で**決まっただけで、まだコードに無い**形を短く書き、無いものを「ある」と読まないよう明記した
- `TaskSheets/ROADMAP.md`: マイルストーン表の「状態」を実装に合わせた（M2 実装済み、M3 は M3-1〜6 実装済み、M4 実装済み、M5 は一部、G1〜G3・TP の行を追加）。
  土台の表のうち、空間クエリ層・ピッキング・カメラのナビゲーション・2D プロファイル描画は「ある」に直した（メッシュ描画パイプラインだけ「無い」のまま）
- 古いコメント: `Cargo.toml` の `pcv-convert`（「M4-1 のスパイク」→ 本番の変換器）、`eslint.config.js`（ui-forge の生成物の説明）、
  `src/datasource/DataSource.ts` の見出し（「HttpSource を差し替える想定」→ `TauriSource`・`WebSource` が実装している。ツールはまだ入っていない）、
  `ci.yml` の「この2つが崩れると」。コードのコメントは CLAUDE.md に従い英語にした（`ci.yml` の既存の日本語のコメントは日本語のまま）
- `HANDOFF.md` には触っていない（コーディネーターの担当）

### 採らなかった案

- ARCHITECTURE.md の「現在の状態」の長い表の書き直し: 行ごとの文が長く（1 行 1,000 字級）、全面的に直すと差分が読めない。事実と食い違う行（I-1・M4-9・WebGPU の注記）だけを直し、足りない領域は行を足した
- 規約 4（`pcv://` で運ぶ）の検査を足す案: RF-0 の範囲（文書）を超える。必要なら別タスク

### 触ったファイル

`TaskSheets/ARCHITECTURE.md`、`TaskSheets/ROADMAP.md`、`TaskSheets/RF-safety-net.md`（新規）、`Cargo.toml`、`eslint.config.js`、`.github/workflows/ci.yml`、`src/datasource/DataSource.ts`

### 確かめ方（AC）

- AC-1（ARCHITECTURE.md のパスがすべて存在する）。リポジトリのルートで次を実行する。「これから」の節の前までを見る（その後ろは、まだ無い物を書いているため）。何も出なければ合格:

  ```sh
  sed '/^## これから/,$d' TaskSheets/ARCHITECTURE.md \
    | grep -oE '(src|crates|src-tauri|TaskSheets|docs|e2e|scripts|vendor)/[A-Za-z0-9_./*-]+' \
    | sed 's/[.,]*$//' | sort -u \
    | while read -r p; do case "$p" in *'*'*) continue;; esac; [ -e "$p" ] || echo "MISSING: $p"; done
  ```

  実行結果: 出力なし（RF-0 のコミット時点）。同じ検査をリンク（`./ADR-*.md` など）にも行い、欠けは無かった
- AC-2（ROADMAP の状態が実装と一致）: 表の各行を、実在するコード（`crates/pcv-core/src/{extract,section_line,profile,raster,dtm,thin,outlier}*`、`src/renderer/depth-pick.ts`・`raycast.ts`・`projection.ts`、`src/ui/section/`、`.github/workflows/release.yml`、`src/datasource/update-check.ts`）の存在と突き合わせた。
  動くかどうかの確認ではなく、「あるものを無いと書いていない」ことの確認
- AC-3（規約の番号と数）: CLAUDE.md（規約 1・2・3・5、4 は対象外）、ARCHITECTURE.md（5 つ、検査は 1・2・3・5）、`ci.yml`（`invariants` の 3 段: 規約 1、2、3・5）で一致。
  RF-1 の後は検査の中身が変わるので、そこで改めて合わせる（RF-1 の節）
