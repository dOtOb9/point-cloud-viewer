import { useIpcBench } from "../state/useIpcBench";

function formatSize(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(0)}MiB`;
}

/** M0-3: pcv:// カスタムプロトコルと invoke のスループット比較パネル。 */
export function IpcBenchPanel() {
  const { status, results, rerun } = useIpcBench();

  return (
    <section className="flex w-[640px] flex-col gap-2 rounded border border-slate-700 bg-slate-800 p-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">IPC throughput bench (pcv:// vs invoke)</h2>
        <button
          type="button"
          onClick={() => rerun()}
          disabled={status === "running"}
          className="rounded bg-slate-700 px-2 py-1 text-xs hover:bg-slate-600 disabled:opacity-50"
        >
          {status === "running" ? "計測中…" : "再計測"}
        </button>
      </div>
      <table className="w-full font-mono text-xs">
        <thead>
          <tr className="text-slate-400">
            <th className="text-left">method</th>
            <th className="text-left">size</th>
            <th className="text-right">time</th>
            <th className="text-right">throughput</th>
          </tr>
        </thead>
        <tbody>
          {results.map((r, i) => (
            <tr key={i}>
              <td>{r.method}</td>
              <td>{formatSize(r.sizeBytes)}</td>
              <td className="text-right">{r.ms !== null ? `${r.ms.toFixed(1)}ms` : r.note}</td>
              <td className="text-right">
                {r.mbPerSec !== null ? `${r.mbPerSec.toFixed(1)}MB/s` : "-"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
