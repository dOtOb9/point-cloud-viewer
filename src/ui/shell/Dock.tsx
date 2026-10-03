import { DockLayout } from "./Dock.generated";

interface Props {
  layerOpen: boolean;
  infoOpen: boolean;
  onToggleLayer: () => void;
  onToggleInfo: () => void;
  onOpenSettings: () => void;
  /** M3-8: ガラス表現(backdrop-blur)のオン/オフ。LayerPanelと同じ意味。 */
  glassEnabled: boolean;
}

/**
 * M2-3 (ADR-0005) → I-1 (ADR-0014): 画面下部中央の「フローティングツールドック」。
 *
 * レイアウトと見た目は `Dock.ui`（ui-forgeが`Dock.generated.tsx`に生成する。ADR-0014）
 * が正。ここは`glassEnabled`→`surface`の変換だけを持つ薄い包みで、ロジック(状態や
 * イベントの受け渡し)以外は何も書かない。
 *
 * 選択・計測・断面といったモード切替式のツールはまだ無い(M3以降。
 * TaskSheets/M2-shading-and-ui.mdの「M3以降に送るもの」参照)ため、現時点では
 * パネルの開閉2つと設定モーダルの3ボタンのみ。
 *
 * ADR-0005が指摘した「ドックはモードの状態が見えにくい」対策として、
 * 開いている側のパネルに対応するボタンを背景色反転で明確にハイライトする
 * (アイコンが並ぶだけの横一列ドックでも、今どちらが開いているか一目で分かる)。
 * ハイライト・非ハイライトの実際のクラスは`Dock.ui`の`Button.active`に対応する
 * クラス表（ui-forgeの`src/core/styles.ts`の`BUTTON_ACTIVE_CLASS`/
 * `BUTTON_INACTIVE_CLASS`。元はこのファイルの`ACTIVE_CLASS`/`INACTIVE_CLASS`と
 * 同じ値）にある。
 */
export function Dock({ layerOpen, infoOpen, onToggleLayer, onToggleInfo, onOpenSettings, glassEnabled }: Props) {
  return (
    <DockLayout
      layerOpen={layerOpen}
      infoOpen={infoOpen}
      onToggleLayer={onToggleLayer}
      onToggleInfo={onToggleInfo}
      onOpenSettings={onOpenSettings}
      surface={glassEnabled ? "glass" : "opaque"}
    />
  );
}
