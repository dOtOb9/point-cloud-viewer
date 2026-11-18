import type { NodeReader } from "../datasource/DataSource";
import { parseNodeBuffer, type ParsedNode } from "../datasource/node-format";
import { StaleNodeRequestError } from "../datasource/stale-node-error";

export interface NodeLoadRequest {
  key: string;
  priority: number;
}

const FALLBACK_CONCURRENT_REQUESTS = 8;
const MIN_CONCURRENT_REQUESTS = 4;

function defaultMaxConcurrent(): number {
  const cores = typeof navigator !== "undefined" ? navigator.hardwareConcurrency : undefined;
  if (!cores || !Number.isFinite(cores)) return FALLBACK_CONCURRENT_REQUESTS;
  return Math.max(MIN_CONCURRENT_REQUESTS, cores);
}

const DEFAULT_MAX_CONCURRENT = defaultMaxConcurrent();

export class NodeLoader {
  private readonly dataSource: NodeReader;
  private readonly onLoaded: (key: string, node: ParsedNode) => void;
  private readonly onFailed: (key: string, error: unknown) => void;
  private readonly maxConcurrent: number;

  private pending = new Map<string, number>();
  private inFlight = new Set<string>();

  private generation = 0;

  constructor(
    dataSource: NodeReader,
    onLoaded: (key: string, node: ParsedNode) => void,
    onFailed: (key: string, error: unknown) => void,
    maxConcurrent = DEFAULT_MAX_CONCURRENT,
  ) {
    this.dataSource = dataSource;
    this.onLoaded = onLoaded;
    this.onFailed = onFailed;
    this.maxConcurrent = maxConcurrent;
  }

  get loadingCount(): number {
    return this.inFlight.size;
  }

  get queuedCount(): number {
    return this.pending.size;
  }

  setWanted(requests: NodeLoadRequest[], isAlreadyAvailable: (key: string) => boolean): void {
    this.pending.clear();
    for (const request of requests) {
      if (this.inFlight.has(request.key) || isAlreadyAvailable(request.key)) continue;
      this.pending.set(request.key, request.priority);
    }
    this.pump();
  }

  reset(): void {
    this.generation++;
    this.pending.clear();
    this.inFlight.clear();
  }

  dispose(): void {
    this.pending.clear();
    this.inFlight.clear();
    this.generation++;
  }

  private pump(): void {
    while (this.inFlight.size < this.maxConcurrent && this.pending.size > 0) {
      const nextKey = this.pickHighestPriority();
      if (nextKey === null) break;
      this.pending.delete(nextKey);
      this.startLoad(nextKey);
    }
  }

  private pickHighestPriority(): string | null {
    let bestKey: string | null = null;
    let bestPriority = -Infinity;
    for (const [key, priority] of this.pending) {
      if (priority > bestPriority) {
        bestPriority = priority;
        bestKey = key;
      }
    }
    return bestKey;
  }

  private startLoad(key: string): void {
    this.inFlight.add(key);
    const requestGeneration = this.generation;
    this.dataSource
      .readNode(key)
      .then((buffer) => {
        if (requestGeneration !== this.generation) return;
        const parsed = parseNodeBuffer(buffer);
        this.onLoaded(key, parsed);
      })
      .catch((error: unknown) => {
        if (error instanceof StaleNodeRequestError) return;
        if (requestGeneration !== this.generation) return;
        this.onFailed(key, error);
      })
      .finally(() => {
        if (requestGeneration !== this.generation) return;
        this.inFlight.delete(key);
        this.pump();
      });
  }
}
