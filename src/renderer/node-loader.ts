// M1-4: 優先度順にノードをキューイングし、同時リクエスト数を絞って非同期ロードする。
// カメラが動いたら `setWanted` で欲しいノードの集合を丸ごと入れ替える。

import type { DataSource } from "../datasource/DataSource";
import { parseNodeBuffer, type ParsedNode } from "../datasource/node-format";

export interface NodeLoadRequest {
  key: string;
  /** 大きいほど優先。M1-4のscreen-space-errorをそのまま渡す想定。 */
  priority: number;
}

const DEFAULT_MAX_CONCURRENT = 4;

export class NodeLoader {
  private readonly dataSource: DataSource;
  private readonly onLoaded: (key: string, node: ParsedNode) => void;
  private readonly onFailed: (key: string, error: unknown) => void;
  private readonly maxConcurrent: number;

  /** まだ取得を開始していない、欲しいノード。 */
  private pending = new Map<string, number>();
  /** 取得中のノードキー。 */
  private inFlight = new Set<string>();

  constructor(
    dataSource: DataSource,
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

  /**
   * 今欲しいノードの集合を丸ごと入れ替える。既にキャッシュ済み・取得中のものは
   * 呼び出し側で除いてから渡すこと（`isAlreadyAvailable`で除外する）。
   */
  setWanted(requests: NodeLoadRequest[], isAlreadyAvailable: (key: string) => boolean): void {
    this.pending.clear();
    for (const request of requests) {
      if (this.inFlight.has(request.key) || isAlreadyAvailable(request.key)) continue;
      this.pending.set(request.key, request.priority);
    }
    this.pump();
  }

  dispose(): void {
    this.pending.clear();
    // 取得中のPromise自体は止められない（fetchのAbortControllerまでは今回は導入しない）。
    // 完了時のコールバックは呼ばれるが、呼び出し側（renderer）が破棄済みなら無視すればよい。
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
    this.dataSource
      .readNode(key)
      .then((buffer) => {
        const parsed = parseNodeBuffer(buffer);
        this.onLoaded(key, parsed);
      })
      .catch((error: unknown) => {
        this.onFailed(key, error);
      })
      .finally(() => {
        this.inFlight.delete(key);
        this.pump();
      });
  }
}
