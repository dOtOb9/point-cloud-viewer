import type { CopcViewerState } from "../../state/useCopcViewer";
import { useNarrowViewport } from "../../state/useNarrowViewport";
import { glassSurfaceClass } from "./glass";
import { LayerInfoSection } from "./LayerInfoSection";
import { LayerStatsDetails } from "./LayerStatsDetails";

/** レイヤー1件(ADR-0018)。今は名前だけ。将来は「どのレイヤーから何の操作で作ったか」を持たせる。 */
interface Layer {
  id: string;
  name: string;
}

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
 * 開いているファイルを1件のレイヤーとして表示する(複数レイヤーの重ね合わせは
 * まだ実装していない。リボンの「複数レイヤー」ツールが未実装（予定）なのと
 * 同じ理由)。その下にレイヤー情報(`LayerInfoSection`: ファイル名・点数・CRS・
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
  // ADR-0018(機能は「選んだレイヤーから新しいレイヤーを作る」向き)に備え、レイヤー一覧と
  // 「選択中のレイヤーid」の形で持つ。今は`useCopcViewer`が1ファイルしか持たないため、
  // 一覧は最大1件・選択は常にその1件。state(`src/state`)は変えず、ここで形だけ揃えた
  // (ADR-0017に記録)。複数レイヤー化するときは、この`layers`/`selectedLayerId`を
  // stateへ引き上げるだけで、下の描画はそのまま使える。
  const loading = viewer.status === "opening" || viewer.status === "converting";
  const layers: Layer[] =
    viewer.openedFileName !== null
      ? [{ id: "current", name: viewer.openedFileName }]
      : loading
        ? [{ id: "current", name: "読み込み中…" }]
        : [];
  const selectedLayerId: string | null = layers[0]?.id ?? null;

  const tree = (
    <div className="flex flex-col gap-1">
      <h3 className="border-l-2 border-tertiary pl-2 text-xs font-semibold uppercase tracking-wide opacity-70">レイヤー</h3>
      {layers.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {layers.map((layer) => (
            <li
              key={layer.id}
              aria-selected={layer.id === selectedLayerId}
              className={`flex items-center gap-2 rounded px-2 py-1.5 text-xs ${
                layer.id === selectedLayerId ? "border-l-[3px] border-l-primary bg-black/5 dark:bg-white/10" : ""
              }`}
            >
              <span aria-hidden="true">📄</span>
              <span className="min-w-0 flex-1 truncate" title={layer.name}>
                {layer.name}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-2 py-1.5 text-xs opacity-60">開いているファイルはありません</p>
      )}
    </div>
  );

  const panelBody = (
    <section
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
        {open && (
          <button
            type="button"
            aria-label="レイヤーパネルを閉じる"
            onClick={onToggleOpen}
            className="fixed inset-0 z-10 bg-black/30"
          />
        )}
        <div className="pointer-events-none fixed bottom-11 left-0 top-[4.5rem] z-10 flex max-w-[88vw] items-stretch">
          {open && panelBody}
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
    <div className="pointer-events-none absolute bottom-14 left-3 top-28 z-10 flex items-start gap-2">
      {open && panelBody}

      <button
        type="button"
        onClick={onToggleOpen}
        aria-label={open ? "レイヤーパネルを畳む" : "レイヤーパネルを開く"}
        title={open ? "レイヤーパネルを畳む" : "レイヤーパネルを開く"}
        className={`pointer-events-auto rounded-full px-2 py-2 text-xs shadow-lg ${glassSurfaceClass(glassEnabled)}`}
      >
        {open ? "◀" : "▶"}
      </button>
    </div>
  );
}
