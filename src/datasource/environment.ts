// 実行環境がTauriのwebviewかブラウザかを判定する。Tauriのnpmパッケージは
// import しない（判定に使うだけなら、Tauriが起動時にwindowへ生やす目印
// `__TAURI_INTERNALS__`を見れば十分で、規約2に触れない）。
//
// `src/state/useCopcViewer.ts`が`TauriSource`/`WebSource`のどちらを使うかを
// ここで決め、`src/datasource/tauri.ts`が`reportToBackendConsole`等をブラウザで
// 誤って呼ばないようにするのにも使う。

export function isTauriEnvironment(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}
