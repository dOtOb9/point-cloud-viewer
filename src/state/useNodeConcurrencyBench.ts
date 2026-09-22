import { useCallback, useEffect, useState } from "react";
import { TauriSource, reportToBackendConsole, resolveBenchDataPath } from "../datasource/tauri";

// M2: `pcv://` への並行リクエストが直列化していないかを計測する。
//
// TaskSheets/M1-point-rendering.md の「追記: 原因の候補を特定した」で立てた仮説
// （同期版 register_uri_scheme_protocol はRustのメインスレッドで直列に実行される）を
// 実測で検証する。M0-3 (useIpcBench.ts) と同じ考え方: GUIを目視できなくても
// `npm run tauri dev` の標準出力（report_diagnostic 経由）で結果が読めるようにする。
//
// 計測方法: 同じ `NODE_LIMIT` 個のノードキーを、並行数を変えながら繰り返し取得する。
// 直列化しているなら、並行数を増やしても nodes/sec はほぼ変わらないはずである
// （Rustのメインスレッドという単一の実行資源を奪い合うだけなので）。
//
// 計測はボタン押下時のみ実行する（起動時に自動実行すると、64ノード×並行数1/4/8=
// 192回のノード読み出しが CopcPool を占有し、ビューア本体の点群読み込みと
// リーダープールを奪い合って起動のたびにフリーズしていた。
// TaskSheets/M1-point-rendering.md「実機確認で見つかった不具合」参照）。

const CONCURRENCIES = [1, 4, 8];
const NODE_LIMIT = 64;
// sofi.copc.laz (3.6億点) でも計測する意味はあるが、この計測は数秒〜十数秒かかる
// 上にCopcPoolを占有するため大きすぎる (2GB)。日常的な計測は軽いautzenで行い、
// sofiでの再現確認はADR-0007に手動実行の結果として別途記録する。
const BENCH_FILE = "autzen-classified.copc.laz";

// 64ノード×並行数1/4/8=192回のノード読み出しにかかる目安時間。
// 実測レートから数秒〜十数秒（ADR-0007 / M2参照）。呼び出し側のUIはこれを明記すること。
export const NODE_CONCURRENCY_BENCH_ESTIMATED_SECONDS = "数秒〜十数秒程度";

export type NodeConcurrencyBenchStatus = "idle" | "running" | "done" | "skipped" | "error";

export function useNodeConcurrencyBench() {
  const [status, setStatus] = useState<NodeConcurrencyBenchStatus>("idle");
  const [summary, setSummary] = useState<string | null>(null);
  // マウント時には何もしない。ボタン押下で runId をインクリメントしたときだけ
  // 下のeffectが起動する。
  const [runId, setRunId] = useState(0);

  useEffect(() => {
    // runId === 0 はまだボタンが押されていない初期状態なので何もしない。
    if (runId === 0) return;

    let cancelled = false;

    async function run() {
      const path = await resolveBenchDataPath(BENCH_FILE);
      if (cancelled) return;
      if (!path) {
        const note = `[M2] node concurrency bench skipped: data/${BENCH_FILE} not found (see TaskSheets/TEST-DATA.md)`;
        setStatus("skipped");
        setSummary(note);
        await reportToBackendConsole(note);
        return;
      }

      const source = new TauriSource();
      const opened = await source.open(path);
      if (cancelled) return;

      // 各並行数ラウンドは別々のノード集合を使う。同じノードを2回目以降に読むと
      // OSのページキャッシュが効いてディスクI/Oが速くなり、「並行数を上げたから
      // 速くなった」のか「2回目だから速くなった」のか区別できなくなる。
      // levelの浅い順に並んだ一覧をラウンド数で割った剰余で振り分けることで、
      // 各ラウンドが同じくらいの深さの混在（＝同じくらいのノードサイズの混在）を
      // 持つ、重複の無い集合になる。
      const allKeys = opened.nodes.map((n) => n.key);
      const rounds = CONCURRENCIES.length;
      const perRound = Math.min(NODE_LIMIT, Math.floor(allKeys.length / rounds));
      const keySets = Array.from({ length: rounds }, (_, round) =>
        allKeys.filter((_, i) => i % rounds === round).slice(0, perRound),
      );

      const lines: string[] = [];
      for (let round = 0; round < rounds; round++) {
        if (cancelled) return;
        const concurrency = CONCURRENCIES[round];
        const keys = keySets[round];
        let bytes = 0;
        let nextIndex = 0;
        const worker = async () => {
          for (;;) {
            const i = nextIndex++;
            if (i >= keys.length) return;
            const buf = await source.readNode(keys[i]);
            bytes += buf.byteLength;
          }
        };

        const t0 = performance.now();
        await Promise.all(Array.from({ length: concurrency }, () => worker()));
        const ms = performance.now() - t0;

        const nodesPerSec = keys.length / (ms / 1000);
        const mibPerSec = bytes / (1024 * 1024) / (ms / 1000);
        lines.push(
          `concurrency=${concurrency}: ${keys.length}nodes/${ms.toFixed(0)}ms = ${nodesPerSec.toFixed(1)}nodes/s ${mibPerSec.toFixed(1)}MiB/s`,
        );
        setSummary(lines.join(" | "));
      }

      if (cancelled) return;
      const result = `[M2] pcv:// node concurrency bench (${BENCH_FILE}, ${perRound} nodes/round, disjoint node sets per round): ${lines.join(" | ")}`;
      console.log(result);
      setStatus("done");
      setSummary(result);
      await reportToBackendConsole(result);
    }

    run().catch((e: unknown) => {
      if (cancelled) return;
      setStatus("error");
      const note = `[M2] node concurrency bench failed: ${String(e)}`;
      setSummary(note);
      reportToBackendConsole(note).catch((err) => console.error("reportToBackendConsole failed", err));
    });

    return () => {
      cancelled = true;
    };
  }, [runId]);

  const rerun = useCallback(() => {
    setStatus("running");
    setSummary(null);
    setRunId((n) => n + 1);
  }, []);

  return { status, summary, rerun };
}
