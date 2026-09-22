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

// 1MiB + 10MiB + 100MiB を pcv:// と invoke の両方で転送するため、実測では
// 合計20秒前後かかる（ADR-0007 / M0-3参照）。呼び出し側のUIはこれを明記すること。
export const IPC_BENCH_ESTIMATED_SECONDS = "20〜30秒程度";

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
  const [status, setStatus] = useState<BenchStatus>("idle");
  const [results, setResults] = useState<BenchResult[]>([]);
  // マウント時には何もしない。ボタン押下で runId をインクリメントしたときだけ
  // 下のeffectが起動する（起動のたびに20秒前後の重い転送が走ってビューア本体の
  // 点群読み込みとリーダープール/IPC帯域を奪い合っていた不具合の修正。
  // TaskSheets/M1-point-rendering.md「実機確認で見つかった不具合」参照）。
  const [runId, setRunId] = useState(0);

  useEffect(() => {
    // runId === 0 はまだボタンが押されていない初期状態なので何もしない。
    if (runId === 0) return;

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
