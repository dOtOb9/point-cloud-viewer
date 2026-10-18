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
  getConvertedFile: vi.fn(),
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
import type { ConvertDoneResponse, WorkerRequest, WorkerResponse } from "./web-protocol";
import type { ConversionStageBreakdownDto } from "./conversion-dto";

class FakeWorker implements WorkerLike {
  readonly sent: WorkerRequest[] = [];
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null = null;
  postMessage(message: unknown): void {
    this.sent.push(message as WorkerRequest);
  }
  respond(response: WorkerResponse): void {
    this.onmessage?.({ data: response } as MessageEvent<WorkerResponse>);
  }
}

const stageTimingsDto: ConversionStageBreakdownDto = {
  source_read_and_decode_secs: 1,
  spill_write_secs: 1,
  lod_index_build_secs: 1,
  node_compression_secs: 1,
  header_and_hierarchy_write_secs: 1,
  total_secs: 5,
  opfs_io_secs: null,
  opfs_read_at_calls: null,
  opfs_cache_hits: null,
  opfs_cache_misses: null,
  opfs_bytes_read_from_opfs: null,
  opfs_read_secs: null,
  opfs_seq_read_calls: null,
  opfs_seq_read_secs: null,
  point_count: 10,
  file_size_bytes: 4,
  input_file_count: 1,
};

function doneResponse(id: number, extra: Partial<ConvertDoneResponse> = {}): WorkerResponse {
  return {
    type: "convert-done",
    id,
    outputName: "hash.copc.laz",
    suggestedFileName: "a.copc.laz",
    pointCount: 10,
    stageTimings: stageTimingsDto,
    ...extra,
  };
}

/** Waits until the conversion request has reached the Worker (the checks before it are async). */
async function waitForRequest(worker: FakeWorker): Promise<number> {
  await vi.waitFor(() => expect(worker.sent).toHaveLength(1));
  return worker.sent[0].id;
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
  // jsdom has no object URLs; the download link only needs some string.
  URL.createObjectURL = vi.fn(() => "blob:test");
});

describe("WebSource.prepareToOpen", () => {
  it("a string item is rejected (the Web build opens Files only)", async () => {
    const { source } = makeSource();
    await expect(source.prepareToOpen(["file:3"], options)).rejects.toThrow();
  });

  it("a COPC file is registered and ready without converting", async () => {
    headerMock.isCopcFile.mockResolvedValue(true);
    const { source, worker } = makeSource();
    const outcome = await source.prepareToOpen([new File([new Uint8Array(4)], "a.copc.laz")], options);
    expect(outcome).toEqual({ kind: "ready", path: "file:0", conversion: null });
    expect(worker.sent).toHaveLength(0);
  });

  it("a cached conversion is ready, with no conversion result", async () => {
    opfsMock.findCachedOutput.mockResolvedValue(new File([new Uint8Array(4)], "out.copc.laz"));
    const { source, worker } = makeSource();
    const outcome = await source.prepareToOpen([new File([new Uint8Array(4)], "a.las")], options);
    expect(outcome).toEqual({ kind: "ready", path: "file:0", conversion: null });
    expect(worker.sent).toHaveLength(0);
  });

  it("a raw LAS waits for the Worker and resolves with the conversion result", async () => {
    opfsMock.getConvertedFile.mockResolvedValue(new File([new Uint8Array(4)], "hash.copc.laz"));
    const { source, worker } = makeSource();
    const onConverting = vi.fn();
    const promise = source.prepareToOpen([new File([new Uint8Array(4)], "a.las")], { ...options, onConverting });
    const id = await waitForRequest(worker);
    expect(worker.sent.map((r) => r.type)).toEqual(["convertStart"]);
    expect(onConverting).toHaveBeenCalledTimes(1);

    worker.respond(doneResponse(id));
    const outcome = await promise;
    expect(outcome.kind).toBe("ready");
    if (outcome.kind !== "ready" || !outcome.conversion) throw new Error("expected a conversion result");
    expect(outcome.path).toBe("file:0");
    expect(outcome.conversion).toMatchObject({
      outputName: "a.copc.laz",
      platform: "web",
      sourceFormat: "las",
      warnings: [],
      download: { url: "blob:test", fileName: "a.copc.laz" },
    });
    expect(outcome.conversion.stageTimings.totalSecs).toBe(5);
  });

  it("the warnings of the done message come back in the conversion result", async () => {
    opfsMock.getConvertedFile.mockResolvedValue(new File([new Uint8Array(4)], "hash.copc.laz"));
    const { source, worker } = makeSource();
    const promise = source.prepareToOpen([new File([new Uint8Array(4)], "a.las")], options);
    const id = await waitForRequest(worker);
    worker.respond(doneResponse(id, { warnings: ["CRS が無いファイルを通しました"] }));
    const outcome = await promise;
    if (outcome.kind !== "ready" || !outcome.conversion) throw new Error("expected a conversion result");
    expect(outcome.conversion.warnings).toEqual(["CRS が無いファイルを通しました"]);
  });

  it("progress messages go to onProgress", async () => {
    opfsMock.getConvertedFile.mockResolvedValue(new File([new Uint8Array(4)], "hash.copc.laz"));
    const { source, worker } = makeSource();
    const onProgress = vi.fn();
    const promise = source.prepareToOpen([new File([new Uint8Array(4)], "a.las")], { ...options, onProgress });
    const id = await waitForRequest(worker);
    worker.respond({
      type: "convert-progress",
      id,
      progress: { phase: "reading", points_read: 5, total_points: 10, elapsed_secs: 1 },
    });
    expect(onProgress).toHaveBeenCalledWith({ phase: "reading", pointsRead: 5, totalPoints: 10, elapsedSecs: 1 });
    worker.respond(doneResponse(id));
    await promise;
  });

  it("a failed conversion resolves as failed with the prefixed log text", async () => {
    const { source, worker } = makeSource();
    const promise = source.prepareToOpen([new File([new Uint8Array(4)], "a.las")], options);
    const id = await waitForRequest(worker);
    worker.respond({ type: "convert-failed", id, message: "boom", cancelled: false });
    expect(await promise).toEqual({ kind: "failed", summary: "boom", details: "変換に失敗しました: boom" });
  });

  it("a cancelled conversion resolves as cancelled, and cancelConversion sends the cancel message", async () => {
    const { source, worker } = makeSource();
    const promise = source.prepareToOpen([new File([new Uint8Array(4)], "a.las")], options);
    const id = await waitForRequest(worker);
    source.cancelConversion();
    expect(worker.sent.map((r) => r.type)).toEqual(["convertStart", "convertCancel"]);
    worker.respond({ type: "convert-failed", id, message: "キャンセルされました", cancelled: true });
    expect(await promise).toEqual({ kind: "cancelled" });
  });

  it("cancelConversion does nothing when no conversion is running", () => {
    const { source, worker } = makeSource();
    source.cancelConversion();
    expect(worker.sent).toHaveLength(0);
  });

  it("an output that cannot be read back from OPFS resolves as failed", async () => {
    opfsMock.getConvertedFile.mockResolvedValue(null);
    const { source, worker } = makeSource();
    const promise = source.prepareToOpen([new File([new Uint8Array(4)], "a.las")], options);
    const id = await waitForRequest(worker);
    worker.respond(doneResponse(id));
    const text = "変換結果をOPFSから読み出せませんでした";
    expect(await promise).toEqual({ kind: "failed", summary: text, details: text });
  });

  it("a PLY starts the point-file conversion route", async () => {
    opfsMock.getConvertedFile.mockResolvedValue(new File([new Uint8Array(4)], "hash.copc.laz"));
    const { source, worker } = makeSource();
    const promise = source.prepareToOpen([new File([new Uint8Array(4)], "a.ply")], options);
    const id = await waitForRequest(worker);
    expect(worker.sent.map((r) => r.type)).toEqual(["pointFileConvertStart"]);
    worker.respond(doneResponse(id));
    const outcome = await promise;
    if (outcome.kind !== "ready" || !outcome.conversion) throw new Error("expected a conversion result");
    expect(outcome.conversion.sourceFormat).toBe("ply");
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
    opfsMock.getConvertedFile.mockResolvedValue(new File([new Uint8Array(4)], "hash.copc.laz"));
    const promise = source.prepareToOpen(files, options);
    const id = await waitForRequest(worker);
    expect(worker.sent.map((r) => r.type)).toEqual(["convertMultiStart"]);
    expect(opfsMock.findCachedMultiOutput).toHaveBeenCalledTimes(1);
    worker.respond(doneResponse(id, { stageTimings: { ...stageTimingsDto, input_file_count: 2 } }));
    const outcome = await promise;
    if (outcome.kind !== "ready" || !outcome.conversion) throw new Error("expected a conversion result");
    expect(outcome.conversion.sourceFormat).toBe("las/laz(複数ファイル)");
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
