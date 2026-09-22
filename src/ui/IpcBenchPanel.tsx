import { IPC_BENCH_ESTIMATED_SECONDS, useIpcBench } from "../state/useIpcBench";

function formatSize(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(0)}MiB`;
}

/**
 * M0-3: pcv:// カスタムプロトコルと invoke のスループット比較パネル。
 * 起動時には自動実行しない（1MiB+10MiB+100MiBをpcv://とinvoke両方で転送するため
 * 実測で20秒前後かかり、起動のたびに走るとビューア本体の点群読み込みと
 * リーダープール/IPC帯域を奪い合ってフリーズしていた。
 * TaskSheets/M1-point-rendering.md「実機確認で見つかった不具合」参照）。
 * ボタンを押したときだけ計測する。
 */
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
          {status === "running" ? "計測中…" : status === "idle" ? "計測開始" : "再計測"}
        </button>
      </div>
      <p className="text-xs text-slate-400">
        {status === "idle" && `未計測（ボタンを押すと計測します。${IPC_BENCH_ESTIMATED_SECONDS}かかります。固まったように見えても正常です）`}
        {status === "running" && `計測中…（${IPC_BENCH_ESTIMATED_SECONDS}かかります。しばらくお待ちください）`}
        {status === "done" && "計測完了"}
      </p>
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
