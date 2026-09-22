import { useNodeConcurrencyBench } from "../state/useNodeConcurrencyBench";

/** M2: `pcv://` 並行リクエストのスループット計測パネル。GUIを目視しなくても
 * `npm run tauri dev` のRust側stdout（report_diagnostic経由）に同じ内容が出る。
 */
export function NodeConcurrencyBenchPanel() {
  const { status, summary } = useNodeConcurrencyBench();

  return (
    <section className="flex w-[640px] flex-col gap-2 rounded border border-slate-700 bg-slate-800 p-3">
      <h2 className="text-sm font-semibold">pcv:// node concurrency bench (M2)</h2>
      <p className="font-mono text-xs text-slate-300">
        {status === "running" && (summary ?? "計測中…")}
        {status === "skipped" && summary}
        {status === "error" && summary}
        {status === "done" && summary}
      </p>
    </section>
  );
}
