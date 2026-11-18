export type GpuErrorSource = "gpu" | "node-read" | "conversion" | "crs" | "tool" | "file-dialog";

export interface GpuErrorEntry {
  readonly id: number;
  readonly message: string;
  readonly source: GpuErrorSource;
  readonly count: number;
  readonly firstAt: number;
  readonly lastAt: number;
}

export class GpuErrorLog {
  private entries: GpuErrorEntry[] = [];
  private nextId = 1;

  report(message: string, now: number = Date.now(), source: GpuErrorSource = "gpu"): void {
    const last = this.entries[this.entries.length - 1];
    if (last !== undefined && last.message === message && last.source === source) {
      this.entries = this.entries.map((entry) =>
        entry.id === last.id ? { ...entry, count: entry.count + 1, lastAt: now } : entry,
      );
      return;
    }
    this.entries = [
      ...this.entries,
      { id: this.nextId++, message, source, count: 1, firstAt: now, lastAt: now },
    ];
  }

  dismiss(id: number): void {
    this.entries = this.entries.filter((entry) => entry.id !== id);
  }

  list(): GpuErrorEntry[] {
    return this.entries;
  }
}
