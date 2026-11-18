export interface CachedNode {
  key: string;
  origin: readonly [number, number, number];
  pointCount: number;
  vertexBuffer: GPUBuffer;
  uniformBuffer: GPUBuffer;
  bindGroup: GPUBindGroup;
  firstDrawnAtMs: number | null;
}

export class NodeCache {
  private entries = new Map<string, CachedNode>();
  private totalPoints = 0;
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

  removeByPrefix(prefix: string): void {
    for (const [key, entry] of this.entries) {
      if (!key.startsWith(prefix)) continue;
      this.entries.delete(key);
      this.totalPoints -= entry.pointCount;
      entry.vertexBuffer.destroy();
      entry.uniformBuffer.destroy();
    }
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
