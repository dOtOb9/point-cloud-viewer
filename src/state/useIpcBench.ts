import { useCallback, useEffect, useState } from "react";
import { TauriSource, fetchBenchViaInvoke, reportToBackendConsole } from "../datasource/tauri";

// M0-3: pcv:// カスタムプロトコルと invoke のスループットを比較する。
// invoke は大きいサイズだと JSON 配列のシリアライズ/パースで著しく遅くなりうるため、
// 一定時間で切り上げるタイムアウトを設ける。

const SIZES_BYTES = [1 * 1024 * 1024, 10 * 1024 * 1024, 100 * 1024 * 1024]; // 1MiB, 10MiB, 100MiB
const INVOKE_TIMEOUT_MS = 60_000;

export interface BenchResult {
  method: "pcv://" | "invoke";
  sizeBytes: number;
  ms: number | null; // null はタイムアウト/失敗
  mbPerSec: number | null;
  note?: string;
}

export type BenchStatus = "idle" | "running" | "done";

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

function formatSize(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(0)}MiB`;
}

function toMbPerSec(bytes: number, ms: number): number {
  return bytes / (1024 * 1024) / (ms / 1000);
}

export function useIpcBench() {
  const [status, setStatus] = useState<BenchStatus>("running");
  const [results, setResults] = useState<BenchResult[]>([]);
  // ボタンでの再計測は runId をインクリメントして effect を再実行させる。
  const [runId, setRunId] = useState(0);

  useEffect(() => {
    // マウント時（と再計測時）に自動実行する。
    // 結果を随時 setState するのは、useWebGpuProbe と同様にこのエフェクト内で
    // 定義したローカル関数からだけにする（react-hooks/set-state-in-effect 対策）。
    let cancelled = false;

    async function run() {
      const source = new TauriSource();
      const collected: BenchResult[] = [];

      for (const size of SIZES_BYTES) {
        const t0 = performance.now();
        try {
          const buf = await source.fetchBench(size);
          const ms = performance.now() - t0;
          if (buf.byteLength !== size) {
            collected.push({ method: "pcv://", sizeBytes: size, ms: null, mbPerSec: null, note: `size mismatch: got ${buf.byteLength}` });
          } else {
            collected.push({ method: "pcv://", sizeBytes: size, ms, mbPerSec: toMbPerSec(size, ms) });
          }
        } catch (e) {
          collected.push({ method: "pcv://", sizeBytes: size, ms: null, mbPerSec: null, note: String(e) });
        }
        if (!cancelled) setResults([...collected]);
      }

      for (const size of SIZES_BYTES) {
        const t0 = performance.now();
        try {
          const length = await withTimeout(fetchBenchViaInvoke(size), INVOKE_TIMEOUT_MS);
          const ms = performance.now() - t0;
          if (length !== size) {
            collected.push({ method: "invoke", sizeBytes: size, ms: null, mbPerSec: null, note: `size mismatch: got ${length}` });
          } else {
            collected.push({ method: "invoke", sizeBytes: size, ms, mbPerSec: toMbPerSec(size, ms) });
          }
        } catch (e) {
          collected.push({ method: "invoke", sizeBytes: size, ms: null, mbPerSec: null, note: String(e) });
        }
        if (!cancelled) setResults([...collected]);
      }

      if (cancelled) return;
      setStatus("done");

      const summary = collected
        .map((r) => {
          const size = formatSize(r.sizeBytes);
          if (r.ms === null) return `${r.method} ${size}: failed (${r.note})`;
          return `${r.method} ${size}: ${r.ms.toFixed(1)}ms ${r.mbPerSec!.toFixed(1)}MB/s`;
        })
        .join(" | ");
      reportToBackendConsole(`[M0-3] IPC bench: ${summary}`).catch((e) =>
        console.error("reportToBackendConsole failed", e),
      );
    }

    run();
    return () => {
      cancelled = true;
    };
  }, [runId]);

  const rerun = useCallback(() => {
    setStatus("running");
    setResults([]);
    setRunId((n) => n + 1);
  }, []);

  return { status, results, rerun };
}
