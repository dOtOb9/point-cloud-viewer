import { GLASS_SURFACE } from "./glass";

interface Props {
  layerOpen: boolean;
  infoOpen: boolean;
  onToggleLayer: () => void;
  onToggleInfo: () => void;
  onOpenSettings: () => void;
}

const ACTIVE_CLASS = "bg-slate-900 text-white dark:bg-white dark:text-slate-900";
const INACTIVE_CLASS = "hover:bg-black/5 dark:hover:bg-white/10";

/**
 * M2-3 (ADR-0005): 画面下部中央の「フローティングツールドック」。
 *
 * 選択・計測・断面といったモード切替式のツールはまだ無い(M3以降。
 * TaskSheets/M2-shading-and-ui.mdの「M3以降に送るもの」参照)ため、現時点では
 * パネルの開閉2つと設定モーダルの3ボタンのみ。
 *
 * ADR-0005が指摘した「ドックはモードの状態が見えにくい」対策として、
 * 開いている側のパネルに対応するボタンを背景色反転で明確にハイライトする
 * (アイコンが並ぶだけの横一列ドックでも、今どちらが開いているか一目で分かる)。
 */
export function Dock({ layerOpen, infoOpen, onToggleLayer, onToggleInfo, onOpenSettings }: Props) {
  return (
    <div
      className={`pointer-events-auto fixed bottom-4 left-1/2 z-20 flex -translate-x-1/2 gap-1 rounded-full p-1.5 text-sm shadow-lg ${GLASS_SURFACE}`}
    >
      <button
        type="button"
        onClick={onToggleLayer}
        className={`rounded-full px-3 py-1.5 ${layerOpen ? ACTIVE_CLASS : INACTIVE_CLASS}`}
      >
        レイヤー
      </button>
      <button
        type="button"
        onClick={onToggleInfo}
        className={`rounded-full px-3 py-1.5 ${infoOpen ? ACTIVE_CLASS : INACTIVE_CLASS}`}
      >
        情報
      </button>
      <button type="button" onClick={onOpenSettings} className={`rounded-full px-3 py-1.5 ${INACTIVE_CLASS}`}>
        設定
      </button>
    </div>
  );
}
