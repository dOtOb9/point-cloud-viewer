import { Hexagon, Layers, MousePointerClick, MoveVertical, Ruler, Slice, type LucideIcon } from "lucide-react";
import type { MeasureKind } from "../../state/measure";
import type { MeasureToolState } from "../../state/useMeasureTool";
import { RibbonButton } from "./RibbonButton";
import { RIBBON_GROUP_CLASS, RIBBON_GROUP_LABEL_CLASS } from "./ribbon-styles";

/** 未実装のツール一覧(タスクシートの指定そのまま)。 */
const UNIMPLEMENTED_TOOLS: { icon: LucideIcon; label: string; title: string }[] = [
  { icon: Slice, label: "断面", title: "選択中のレイヤーから断面レイヤーを作る（未実装）" },
  { icon: MousePointerClick, label: "点の選択", title: "選択中のレイヤーから選んだ点のレイヤーを作る（未実装）" },
  { icon: Layers, label: "複数レイヤー", title: "選択中の複数のレイヤーから結合レイヤーを作る（未実装）" },
];

/** 計測は距離・高さ・面積の3つのボタンに分けた（実装が入ったらボタンを分ける、という所有者の決定）。 */
const MEASURE_TOOLS: { kind: MeasureKind; icon: LucideIcon; label: string; title: string }[] = [
  { kind: "distance", icon: Ruler, label: "距離", title: "2点をクリックして距離を測る（結果は計測レイヤーになる）" },
  { kind: "height", icon: MoveVertical, label: "高さ", title: "2点をクリックして高さの差を測る（結果は計測レイヤーになる）" },
  { kind: "area", icon: Hexagon, label: "面積", title: "頂点をクリックして面積を測る。ダブルクリックか Enter で閉じる（結果は計測レイヤーになる）" },
];

/**
 * ADR-0017 (UIシェル再構築): トップリボンの「ツール」グループ。
 *
 * ADR-0018: ここのツールは「選択中のレイヤーに対する操作で、結果は新しいレイヤー」として
 * 並べる(元のレイヤーは書き換えない)。ツールチップもその言い方にしている。
 *
 * 所有者の決定: まだ実装していないツールは、押せそう・動きそうに見せない。
 * アイコンとラベルは他のボタンと同じく残したまま`disabled`にして(無効スタイル)、
 * クリックしても何も起きないことをHTMLレベルで保証し、`title`に
 * 「選択中のレイヤーから〜レイヤーを作る（未実装）」と表示する(ホバーで分かる。タッチ端末では`title`が出ない
 * 機種もあるため、見た目のグレーアウト自体も根拠にする)。
 *
 * L2-D: 計測(距離・高さ・面積)を実装した。押すと計測が始まり、計測中のボタンは下線(active)が出る。
 * もう一度押すか Esc でやめる。点群が1つも無いときは押せない(測る対象が無いため)。
 */
export function RibbonToolsGroup({ measure, hasPointCloud }: { measure: MeasureToolState; hasPointCloud: boolean }) {
  return (
    <div className={RIBBON_GROUP_CLASS}>
      <span className={RIBBON_GROUP_LABEL_CLASS}>ツール</span>
      <div className="flex flex-nowrap items-center gap-1">
        {MEASURE_TOOLS.map((tool) => (
          <RibbonButton
            key={tool.kind}
            icon={tool.icon}
            label={tool.label}
            title={tool.title}
            active={measure.mode === tool.kind}
            disabled={!hasPointCloud && measure.mode !== tool.kind}
            onClick={() => measure.toggle(tool.kind)}
          />
        ))}
        {UNIMPLEMENTED_TOOLS.map((tool) => (
          <RibbonButton key={tool.label} icon={tool.icon} label={tool.label} disabled title={tool.title} />
        ))}
      </div>
    </div>
  );
}
