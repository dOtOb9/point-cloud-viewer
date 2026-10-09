import { Layers, MousePointerClick, Ruler, Slice, type LucideIcon } from "lucide-react";
import { RibbonButton } from "./RibbonButton";
import { RIBBON_GROUP_CLASS, RIBBON_GROUP_LABEL_CLASS } from "./ribbon-styles";

/** 未実装のツール一覧(タスクシートの指定そのまま)。計測は距離・面積・高さの
 *  3種を1つのボタンにまとめて表記する(個別の実装が無いため、現時点では
 *  分ける意味が無い。実装が入ったらボタンを分ける)。 */
const UNIMPLEMENTED_TOOLS: { icon: LucideIcon; label: string }[] = [
  { icon: Ruler, label: "計測（距離・面積・高さ）" },
  { icon: Slice, label: "断面" },
  { icon: MousePointerClick, label: "点の選択" },
  { icon: Layers, label: "複数レイヤー" },
];

/**
 * ADR-0017 (UIシェル再構築): トップリボンの「ツール」グループ。
 *
 * 所有者の決定: まだ実装していないツールは、押せそう・動きそうに見せない。
 * アイコンとラベルは他のボタンと同じく残したまま`disabled`にして(無効スタイル)、
 * クリックしても何も起きないことをHTMLレベルで保証し、`title`に
 * 「未実装（予定）」と表示する(ホバーで分かる。タッチ端末では`title`が出ない
 * 機種もあるため、見た目のグレーアウト自体も根拠にする)。
 */
export function RibbonToolsGroup() {
  return (
    <div className={RIBBON_GROUP_CLASS}>
      <span className={RIBBON_GROUP_LABEL_CLASS}>ツール</span>
      <div className="flex flex-wrap items-center gap-1">
        {UNIMPLEMENTED_TOOLS.map((tool) => (
          <RibbonButton key={tool.label} icon={tool.icon} label={tool.label} disabled title="未実装（予定）" />
        ))}
      </div>
    </div>
  );
}
