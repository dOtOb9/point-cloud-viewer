import type { CSSProperties } from "react";
import type { CopcViewerState } from "../../state/useCopcViewer";
import { useNarrowViewport } from "../../state/useNarrowViewport";
import { glassSurfaceClass } from "./glass";
import { LayerInfoSection } from "./LayerInfoSection";
import { LayerList } from "./LayerList";
import { LayerStatsDetails } from "./LayerStatsDetails";
import { useTransitionMount } from "./useTransitionMount";

/** パネルが滑って消えるまでの時間(ms)。index.cssの`--motion-panel`と同じ値(未検証の初期値)。 */
const PANEL_EXIT_MS = 220;

interface Props {
  viewer: CopcViewerState;
  open: boolean;
  onToggleOpen: () => void;
  /** M3-8: ガラス表現(backdrop-blur)のオン/オフ。既定はモバイル判定に従う。 */
  glassEnabled: boolean;
}

/**
 * ADR-0017 (UIシェル再構築): 画面左の「レイヤーパネル」。
 *
 * デスクトップの点群/GIS系ソフトに多い「レイヤーツリー」の最小構成として、
 * 開いているファイルをレイヤーの一覧として表示する(L1-D: 開くたびに足される。
 * 各行のチェックで表示・非表示、クリックで選択、右クリックで削除)。その下にレイヤー情報(`LayerInfoSection`: ファイル名・点数・CRS・
 * バウンディングボックス・変換の内訳)と、折りたたみ式の詳細統計
 * (`LayerStatsDetails`)を続ける。
 *
 * 以前の`LayerPanel.tsx`(ファイルを開く操作+点予算+背景+グリッド+進捗+
 * エラー+ダウンロード+内訳)と`InfoPanel.tsx`(cloudInfoの先頭+統計+カメラ)を
 * 1つの左パネルへ統合した形になる。ファイルを開く操作自体はリボンの
 * 「ファイル」グループ(`RibbonFileGroup.tsx`)へ移した(タスクシートの
 * レイアウト指定: 開く操作はリボン、ファイル名等の情報は左パネル)。
 *
 * 折りたたみ可能(`open`/`onToggleOpen`、以前と同じ)。768px未満
 * (`useNarrowViewport`)では、固定幅のパネルではなく画面を覆うドロワーに
 * 変える(タスクシートの要求: 「the panels become drawers」)。
 */
export function LayerPanel({ viewer, open, onToggleOpen, glassEnabled }: Props) {
  const narrow = useNarrowViewport();
  // L1-D: レイヤー一覧・選択は `useCopcViewer` が持つ（ADR-0018）。一覧の描画は `LayerList`。
  const tree = (
    <div className="flex flex-col gap-1">
      <h3 className="border-l-2 border-tertiary pl-2 text-xs font-semibold uppercase tracking-wide opacity-70">レイヤー</h3>
      <LayerList viewer={viewer} />
    </div>
  );

  // AN-3: パネルは横へ滑って出入りする(transformだけ。ガラスのぼかしの大きさは動かさない)。
  const { mounted, shown } = useTransitionMount(open, PANEL_EXIT_MS);
  const slide: CSSProperties = {
    transitionProperty: "transform, opacity",
    transitionDuration: "var(--motion-panel)",
    transitionTimingFunction: shown ? "var(--motion-ease-out)" : "var(--motion-ease-in)",
  };
  const panelBody = (
    <section
      style={{ ...slide, transform: shown ? "translateX(0)" : "translateX(-110%)", opacity: shown ? 1 : 0 }}
      className={`pointer-events-auto flex w-72 max-w-[38vw] flex-col gap-4 overflow-y-auto rounded-2xl p-4 text-sm shadow-lg ${glassSurfaceClass(glassEnabled)} ${narrow ? "!w-full !max-w-none !rounded-none" : ""}`}
    >
      {tree}
      <div className="flex flex-col gap-1">
        <h3 className="border-l-2 border-tertiary pl-2 text-xs font-semibold uppercase tracking-wide opacity-70">レイヤー情報</h3>
        <LayerInfoSection viewer={viewer} />
      </div>
      <LayerStatsDetails viewer={viewer} />
    </section>
  );

  if (narrow) {
    // ドロワー: 開いている間は画面全体を覆う半透明の背景(タップで閉じる)の上に
    // パネル本体を左から出す。ガラス面が点群の上で読みにくくなるリスク
    // (ADR-0005)は、ドロワーが開いている間は点群そのものがほぼ覆われるため、
    // デスクトップのフロート表示より影響が小さいと判断した(未検証の判断。
    // 実機での見た目は所有者の確認手順に記載)。
    return (
      <>
        {mounted && (
          <button
            type="button"
            aria-label="レイヤーパネルを閉じる"
            onClick={onToggleOpen}
            style={{ ...slide, transitionProperty: "opacity", opacity: shown ? 1 : 0 }}
            className={`fixed inset-0 z-10 bg-black/30 ${shown ? "" : "pointer-events-none"}`}
          />
        )}
        <div className="pointer-events-none fixed bottom-11 left-0 top-[4.5rem] z-10 flex max-w-[88vw] items-stretch">
          {mounted && panelBody}
        </div>
        <button
          type="button"
          onClick={onToggleOpen}
          aria-label={open ? "レイヤーパネルを畳む" : "レイヤーパネルを開く"}
          title={open ? "レイヤーパネルを畳む" : "レイヤーパネルを開く"}
          className={`pointer-events-auto fixed bottom-16 left-3 z-10 flex h-11 w-11 items-center justify-center rounded-full text-xs shadow-lg ${glassSurfaceClass(glassEnabled)}`}
        >
          {open ? "◀" : "▶"}
        </button>
      </>
    );
  }

  return (
    // 上はリボン(top-3 + 高さ約4.5rem)、下はステータスバー(約2.75rem)に重ならない位置にする。
    // パネルと開閉ボタンは、どちらも絶対配置+transformで動かす(flexの並びだと、パネルが
    // DOMから消えた瞬間に開閉ボタンの位置が飛ぶため)。ボタンはパネル幅(w-72=18rem)+隙間ぶん右へずらす。
    <div className="pointer-events-none absolute bottom-14 left-3 top-28 z-10">
      {mounted && <div className="absolute left-0 top-0 flex max-h-full">{panelBody}</div>}

      <button
        type="button"
        onClick={onToggleOpen}
        aria-label={open ? "レイヤーパネルを畳む" : "レイヤーパネルを開く"}
        title={open ? "レイヤーパネルを畳む" : "レイヤーパネルを開く"}
        style={{ ...slide, transitionProperty: "transform", transform: shown ? "translateX(18.5rem)" : "translateX(0)" }}
        className={`pointer-events-auto absolute left-0 top-0 rounded-full px-2 py-2 text-xs shadow-lg ${glassSurfaceClass(glassEnabled)}`}
      >
        {open ? "◀" : "▶"}
      </button>
    </div>
  );
}
