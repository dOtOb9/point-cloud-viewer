// Tests for WebSource.prepareToOpen. The OPFS helpers, the COPC header check and the point-count
// estimators are replaced, so no browser storage or Worker is needed (same fake Worker as web.test.ts).
import { beforeEach, describe, expect, it, vi } from "vitest";

const opfsMock = vi.hoisted(() => ({
  findCachedOutput: vi.fn(),
  findCachedMultiOutput: vi.fn(),
  isOpfsAvailable: vi.fn(),
  ensurePersistentStorage: vi.fn(),
  estimateQuota: vi.fn(),
  getOpfsUsageBreakdown: vi.fn(),
  isPersisted: vi.fn(),
}));
const headerMock = vi.hoisted(() => ({ isCopcFile: vi.fn() }));

vi.mock("./opfs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./opfs")>()),
  ...opfsMock,
}));
vi.mock("./copc-header", () => headerMock);
vi.mock("./point-count-estimate", () => ({
  estimatePointCountForLasFile: vi.fn(async () => 1000),
  estimatePointCountForPcdFile: vi.fn(async () => 1000),
  estimatePointCountForPlyFile: vi.fn(async () => 1000),
  estimatePointCountForE57File: vi.fn(async () => 1000),
}));

import { WebSource, type WorkerLike } from "./web";
import type { WorkerRequest, WorkerResponse } from "./web-protocol";

class FakeWorker implements WorkerLike {
  readonly sent: WorkerRequest[] = [];
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null = null;
  postMessage(message: unknown): void {
    this.sent.push(message as WorkerRequest);
  }
}

const options = { tempDir: null, isMobile: false };

function makeSource(): { source: WebSource; worker: FakeWorker } {
  const worker = new FakeWorker();
  return { source: new WebSource(() => worker), worker };
}

beforeEach(() => {
  vi.resetAllMocks();
  headerMock.isCopcFile.mockResolvedValue(false);
  opfsMock.findCachedOutput.mockResolvedValue(null);
  opfsMock.findCachedMultiOutput.mockResolvedValue(null);
  opfsMock.isOpfsAvailable.mockResolvedValue(true);
  opfsMock.ensurePersistentStorage.mockResolvedValue({ kind: "already" });
  opfsMock.estimateQuota.mockResolvedValue({ quota: 1024 ** 4, usage: 0 });
  opfsMock.getOpfsUsageBreakdown.mockResolvedValue({ cachedConversionsTotalBytes: 0, staleScratchTotalBytes: 0 });
  opfsMock.isPersisted.mockResolvedValue(true);
});

describe("WebSource.prepareToOpen", () => {
  it("one string is ready as it is (an OPFS key from the conversion continuation)", async () => {
    const { source, worker } = makeSource();
    expect(await source.prepareToOpen(["file:3"], options)).toEqual({ kind: "ready", path: "file:3" });
    expect(worker.sent).toHaveLength(0);
  });

  it("a COPC file is registered and ready without converting", async () => {
    headerMock.isCopcFile.mockResolvedValue(true);
    const { source, worker } = makeSource();
    const outcome = await source.prepareToOpen([new File([new Uint8Array(4)], "a.copc.laz")], options);
    expect(outcome).toEqual({ kind: "ready", path: "file:0" });
    expect(worker.sent).toHaveLength(0);
  });

  it("a cached conversion is ready", async () => {
    opfsMock.findCachedOutput.mockResolvedValue(new File([new Uint8Array(4)], "out.copc.laz"));
    const { source, worker } = makeSource();
    const outcome = await source.prepareToOpen([new File([new Uint8Array(4)], "a.las")], options);
    expect(outcome).toEqual({ kind: "ready", path: "file:0" });
    expect(worker.sent).toHaveLength(0);
  });

  it("a raw LAS starts the LAS/LAZ conversion route", async () => {
    const { source, worker } = makeSource();
    const outcome = await source.prepareToOpen([new File([new Uint8Array(4)], "a.las")], options);
    expect(outcome).toEqual({ kind: "converting" });
    expect(worker.sent.map((r) => r.type)).toEqual(["convertStart"]);
  });

  it("a PLY starts the point-file conversion route", async () => {
    const { source, worker } = makeSource();
    const outcome = await source.prepareToOpen([new File([new Uint8Array(4)], "a.ply")], options);
    expect(outcome).toEqual({ kind: "converting" });
    expect(worker.sent.map((r) => r.type)).toEqual(["pointFileConvertStart"]);
  });

  it("OPFS unavailable fails with the single-file text", async () => {
    opfsMock.isOpfsAvailable.mockResolvedValue(false);
    const { source } = makeSource();
    const outcome = await source.prepareToOpen([new File([new Uint8Array(4)], "a.las")], options);
    const text =
      "お使いのブラウザはOPFS(File System Access API)に対応していないため、Web版では変換できません。デスクトップ版でCOPC(.copc.laz)に変換してから開いてください。";
    expect(outcome).toEqual({ kind: "failed", summary: text, details: text });
  });

  it("insufficient space fails with the short summary and the long details", async () => {
    opfsMock.estimateQuota.mockResolvedValue({ quota: 1, usage: 0 });
    const { source, worker } = makeSource();
    const outcome = await source.prepareToOpen([new File([new Uint8Array(4)], "a.las")], options);
    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.summary).toBe("空き容量が足りません");
    expect(outcome.details.length).toBeGreaterThan(outcome.summary.length);
    expect(worker.sent).toHaveLength(0);
  });

  it("several files take the merge route", async () => {
    const { source, worker } = makeSource();
    const files = [new File([new Uint8Array(4)], "a.las"), new File([new Uint8Array(4)], "b.las")];
    expect(await source.prepareToOpen(files, options)).toEqual({ kind: "converting" });
    expect(worker.sent.map((r) => r.type)).toEqual(["convertMultiStart"]);
    expect(opfsMock.findCachedMultiOutput).toHaveBeenCalledTimes(1);
  });

  it("several files with OPFS unavailable fail with the multi-file text", async () => {
    opfsMock.isOpfsAvailable.mockResolvedValue(false);
    const { source } = makeSource();
    const files = [new File([new Uint8Array(4)], "a.las"), new File([new Uint8Array(4)], "b.las")];
    const outcome = await source.prepareToOpen(files, options);
    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.details).toContain("デスクトップ版でまとめてCOPC");
  });
});
