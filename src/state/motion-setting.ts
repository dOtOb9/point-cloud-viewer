/**
 * ADR-0017 (AN-3): 「アニメーション」のオン/オフ設定の保存と、<html>の`data-motion`属性。
 *
 * - オフのとき`<html data-motion="off">`にする。`src/index.css`がこの属性で`--motion-*`を0msにし、
 *   UIのCSSアニメーション(AN-3)を止める。点群側(AN-1/AN-2)は`useCopcViewer`が
 *   rendererの`setAnimationEnabled`へ同じ値を渡して止める。
 * - OSの`prefers-reduced-motion`は、この設定に関わらず常に動きを止める(CSSの@mediaとrendererの
 *   `resolveMotionEnabled`)。
 * - 保存先は他の設定(テーマ・更新確認)と同じ`localStorage`。使えない環境では既定(オン)になる。
 * DOMやlocalStorageを直接触る部分を小さく分けてあるので、vitestで検証できる(`motion-setting.test.ts`)。
 */

export const MOTION_STORAGE_KEY = "pcv-animation-enabled";

/** 保存された値を読む。無い・読めないときは既定のオン。 */
export function readStoredAnimationEnabled(storage: Pick<Storage, "getItem"> | undefined): boolean {
  try {
    return storage?.getItem(MOTION_STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

/** 設定を保存する。保存できなくても動作に支障はない(次回起動時にオンへ戻るだけ)。 */
export function storeAnimationEnabled(storage: Pick<Storage, "setItem"> | undefined, enabled: boolean): void {
  try {
    storage?.setItem(MOTION_STORAGE_KEY, String(enabled));
  } catch {
    // 保存できなくても続行する。
  }
}

/** `<html>`の`data-motion`へ反映する。オンのときは属性を外す(CSSは`[data-motion="off"]`だけを見る)。 */
export function applyMotionAttribute(root: { dataset: DOMStringMap }, enabled: boolean): void {
  if (enabled) delete root.dataset.motion;
  else root.dataset.motion = "off";
}

/** 閉じるアニメーションを待たずにDOMから外してよいか(OSの設定、またはアプリの設定がオフ)。 */
export function shouldSkipExitWait(root: { dataset: DOMStringMap } | undefined, osReducedMotion: boolean): boolean {
  return osReducedMotion || root?.dataset.motion === "off";
}
