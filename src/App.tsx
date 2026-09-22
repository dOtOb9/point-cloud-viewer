import { ViewerPanel } from "./ui/ViewerPanel";
import { WebGpuProbePanel } from "./ui/WebGpuProbePanel";
import { IpcBenchPanel } from "./ui/IpcBenchPanel";
import { NodeConcurrencyBenchPanel } from "./ui/NodeConcurrencyBenchPanel";

function App() {
  return (
    <main className="flex h-screen w-screen flex-col items-center gap-4 overflow-auto bg-slate-900 px-4 py-4 text-slate-100">
      <h1 className="text-2xl font-semibold">point-cloud-viewer</h1>
      <div className="w-full max-w-6xl">
        <ViewerPanel />
      </div>
      <details className="w-full max-w-6xl">
        <summary className="cursor-pointer text-sm text-slate-400">M0の診断パネル（WebGPU probe / IPC bench）</summary>
        <div className="mt-4 flex flex-col items-center gap-4">
          <WebGpuProbePanel />
          <IpcBenchPanel />
          <NodeConcurrencyBenchPanel />
        </div>
      </details>
    </main>
  );
}

export default App;
