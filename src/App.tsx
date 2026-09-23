import { AppShell } from "./ui/shell/AppShell";

/**
 * M2-3 (ADR-0005): 全面ビューア + 浮かぶガラス面のUIシェル。
 * 中身はすべてsrc/ui/shell/AppShell.tsxに集約している(M0の診断パネルは
 * 設定モーダル内に移した。src/ui/shell/SettingsModal.tsx参照)。
 */
function App() {
  return <AppShell />;
}

export default App;
