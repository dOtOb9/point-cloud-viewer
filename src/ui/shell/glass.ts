// M2-3 (ADR-0005): 半透明の「ガラス」面の共通スタイル。
//
// ADR-0005が引き受けたリスク2「点群の上ではガラスが読めなくなりやすい」への対処として、
// ぼかし(backdrop-blur)の上に単色のtint(白系/暗いスレート系)を重ねている。
// tintの不透明度はやや高め(ライト65% / ダーク70%)にしてある。理由:
// - 点群は色が任意かつ高周波ノイズを持つため、tintが薄いと文字のコントラストが
//   背景の点群次第になってしまう(ADRが明記した懸念そのもの)
// - 特にライトテーマ×暗い点群×白いガラスの組み合わせが最も破綻しやすいとADRに
//   明記されているため、ライトのtintも控えめな薄さにはしなかった
// - ぼかし自体は残しているので、「完全に不透明」な設定モーダルとは質感が区別できる
//
// 断り書き: この不透明度の値は設計時の判断であり、fpsは測っていない。
// backdrop-filterの描画コスト実測はM2-4の担当(TaskSheets/M2-shading-and-ui.md参照)。
export const GLASS_SURFACE =
  "backdrop-blur-md bg-white/65 text-slate-900 border border-black/10 " +
  "dark:bg-slate-950/70 dark:text-slate-100 dark:border-white/10";
