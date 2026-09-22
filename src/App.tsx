import { WebGpuProbePanel } from "./ui/WebGpuProbePanel";
import { IpcBenchPanel } from "./ui/IpcBenchPanel";

function App() {
  return (
    <main className="flex h-screen w-screen flex-col items-center justify-center gap-4 overflow-auto bg-slate-900 py-4 text-slate-100">
      <h1 className="text-2xl font-semibold">Hello, point-cloud-viewer</h1>
      <WebGpuProbePanel />
      <IpcBenchPanel />
    </main>
  );
}

export default App;
