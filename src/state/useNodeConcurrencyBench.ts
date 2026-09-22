import { useEffect, useState } from "react";
import { TauriSource, reportToBackendConsole, resolveBenchDataPath } from "../datasource/tauri";

// M2: `pcv://` への並行リクエストが直列化していないかを計測する。
//
// TaskSheets/M1-point-rendering.md の「追記: 原因の候補を特定した」で立てた仮説
// （同期版 register_uri_scheme_protocol はRustのメインスレッドで直列に実行される）を
// 実測で検証する。M0-3 (useIpcBench.ts) と同じ考え方: 起動時に自動計測し、
// GUIを目視できなくても `npm run tauri dev` の標準出力（report_diagnostic 経由）で
// 結果が読めるようにする。
//
// 計測方法: 同じ `NODE_LIMIT` 個のノードキーを、並行数を変えながら繰り返し取得する。
// 直列化しているなら、並行数を増やしても nodes/sec はほぼ変わらないはずである
// （Rustのメインスレッドという単一の実行資源を奪い合うだけなので）。

const CONCURRENCIES = [1, 4, 8];
const NODE_LIMIT = 64;
// sofi.copc.laz (3.6億点) でも計測する意味はあるが、起動のたびに走らせるには
// 大きすぎる (2GB)。日常的な計測は軽いautzenで行い、sofiでの再現確認は
// ADR-0007に手動実行の結果として別途記録する。
const BENCH_FILE = "autzen-classified.copc.laz";

export type NodeConcurrencyBenchStatus = "idle" | "running" | "done" | "skipped" | "error";

export function useNodeConcurrencyBench() {
  const [status, setStatus] = useState<NodeConcurrencyBenchStatus>("running");
  const [summary, setSummary] = useState<string | null>(null);

  useEffect(() => {
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
  }, []);

  return { status, summary };
}
