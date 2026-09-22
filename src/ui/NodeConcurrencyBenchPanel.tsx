import { NODE_CONCURRENCY_BENCH_ESTIMATED_SECONDS, useNodeConcurrencyBench } from "../state/useNodeConcurrencyBench";

/**
 * M2: `pcv://` 並行リクエストのスループット計測パネル。GUIを目視しなくても
 * `npm run tauri dev` のRust側stdout（report_diagnostic経由）に同じ内容が出る。
 * 起動時には自動実行しない（64ノード×並行数1/4/8=192回のノード読み出しが
 * CopcPoolを占有し、ビューア本体の点群読み込みとリーダープールを奪い合って
 * 起動のたびにフリーズしていた。TaskSheets/M1-point-rendering.md
 * 「実機確認で見つかった不具合」参照）。ボタンを押したときだけ計測する。
 */
export function NodeConcurrencyBenchPanel() {
  const { status, summary, rerun } = useNodeConcurrencyBench();

  return (
    <section className="flex w-[640px] flex-col gap-2 rounded border border-slate-700 bg-slate-800 p-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">pcv:// node concurrency bench (M2)</h2>
        <button
          type="button"
          onClick={() => rerun()}
          disabled={status === "running"}
          className="rounded bg-slate-700 px-2 py-1 text-xs hover:bg-slate-600 disabled:opacity-50"
        >
          {status === "running" ? "計測中…" : status === "idle" ? "計測開始" : "再計測"}
        </button>
      </div>
      <p className="font-mono text-xs text-slate-300">
        {status === "idle" &&
          `未計測（ボタンを押すと計測します。${NODE_CONCURRENCY_BENCH_ESTIMATED_SECONDS}かかります。固まったように見えても正常です）`}
        {status === "running" && `${summary ?? "計測中…"}（${NODE_CONCURRENCY_BENCH_ESTIMATED_SECONDS}かかります）`}
        {status === "skipped" && summary}
        {status === "error" && summary}
        {status === "done" && summary}
      </p>
    </section>
  );
}
