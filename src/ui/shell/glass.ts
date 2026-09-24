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

/**
 * M3-8: モバイルでは`backdrop-filter`(backdrop-blur)を切り、不透明のtintに
 * する。理由: ADR-0005自身が引き受けたリスクとして「backdrop-filterは背景
 * (3D canvas)が毎フレーム変化するため、コンポジタがぼかしを毎フレーム
 * 計算し直し、GPUを点群描画と奪い合う」と明記している。所有者の実機
 * (Adreno 610)はこの負荷を最も避けたい対象なので、tint(単色の薄い層)は
 * ADR-0005のリスク2対策としてそのまま残しつつ、ぼかしだけを外す。
 * 不透明度は`GLASS_SURFACE`のtintと同じ値(ライト65%/ダーク70%相当)を
 * ベースに、ぼかしが無い分だけ可読性を落とさないよう完全不透明にした。
 */
export const OPAQUE_GLASS_SURFACE =
  "bg-white text-slate-900 border border-black/10 " + "dark:bg-slate-950 dark:text-slate-100 dark:border-white/10";

/**
 * `glassEnabled`に応じて、ぼかしありのガラス面/不透明なtint面のどちらかの
 * Tailwindクラス文字列を返す。呼び出し側(LayerPanel/InfoPanel/Dock/
 * UpdateNotice)は`GLASS_SURFACE`を直接importする代わりにこの関数を使う。
 */
export function glassSurfaceClass(glassEnabled: boolean): string {
  return glassEnabled ? GLASS_SURFACE : OPAQUE_GLASS_SURFACE;
}
