// M1-4: 一度読んだノードはLRUで保持し、再取得しない。GPUバッファも合わせて解放する。
//
// JSの`Map`はキーの挿入順を保つ性質を使う。アクセス時に削除→再挿入することで
// 「挿入順=最近使った順」を保ち、先頭（最も使われていないもの）から捨てればLRUになる。

export interface CachedNode {
  key: string;
  origin: readonly [number, number, number];
  pointCount: number;
  vertexBuffer: GPUBuffer;
  uniformBuffer: GPUBuffer;
  bindGroup: GPUBindGroup;
}

export class NodeCache {
  private entries = new Map<string, CachedNode>();
  private totalPoints = 0;
  /** キャッシュに残しておく点数の上限。点予算そのものではなく、少し余裕を持たせた値にする
   *  （視点が少し動いただけで直前まで見えていたノードを捨てて再取得する、を避けるため）。 */
  maxPoints: number;

  constructor(maxPoints: number) {
    this.maxPoints = maxPoints;
  }

  get(key: string): CachedNode | undefined {
    const entry = this.entries.get(key);
    if (entry) {
      this.entries.delete(key);
      this.entries.set(key, entry);
    }
    return entry;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  set(entry: CachedNode): void {
    const existing = this.entries.get(entry.key);
    if (existing) {
      this.totalPoints -= existing.pointCount;
      existing.vertexBuffer.destroy();
      existing.uniformBuffer.destroy();
    }
    this.entries.set(entry.key, entry);
    this.totalPoints += entry.pointCount;
    this.evictIfNeeded();
  }

  private evictIfNeeded(): void {
    for (const [key, entry] of this.entries) {
      if (this.totalPoints <= this.maxPoints) break;
      this.entries.delete(key);
      this.totalPoints -= entry.pointCount;
      entry.vertexBuffer.destroy();
      entry.uniformBuffer.destroy();
    }
  }

  values(): IterableIterator<CachedNode> {
    return this.entries.values();
  }

  get size(): number {
    return this.entries.size;
  }

  totalCachedPoints(): number {
    return this.totalPoints;
  }

  dispose(): void {
    for (const entry of this.entries.values()) {
      entry.vertexBuffer.destroy();
      entry.uniformBuffer.destroy();
    }
    this.entries.clear();
    this.totalPoints = 0;
  }
}
