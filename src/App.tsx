function App() {
  return (
    <main className="flex h-screen w-screen flex-col items-center justify-center gap-4 bg-slate-900 text-slate-100">
      <h1 className="text-2xl font-semibold">Hello, point-cloud-viewer</h1>
      <canvas
        id="viewport"
        className="rounded border border-slate-700 bg-black"
        width={640}
        height={360}
      />
    </main>
  );
}

export default App;
