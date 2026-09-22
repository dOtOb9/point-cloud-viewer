import { WebGpuProbePanel } from "./ui/WebGpuProbePanel";

function App() {
  return (
    <main className="flex h-screen w-screen flex-col items-center justify-center gap-4 bg-slate-900 text-slate-100">
      <h1 className="text-2xl font-semibold">Hello, point-cloud-viewer</h1>
      <WebGpuProbePanel />
    </main>
  );
}

export default App;
