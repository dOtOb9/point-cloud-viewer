// opfs.ts の純粋関数(キャッシュのキー・容量の判定)のテスト。
// 実際のOPFS I/Oはブラウザでしか意味を持たないため、ここではテストしない
// (所有者がブラウザで確かめる手順は TaskSheets/M4-import-and-conversion.md の
// M4-6bに書く)。

import { describe, expect, it, vi } from "vitest";
import {
  cacheKeyFor,
  CONVERSION_LOCK_NAME,
  hasEnoughQuota,
  isScratchDirName,
  openHandlePool,
  outputFileNameFor,
  OUTPUT_BYTES_PER_POINT,
  requiredBytesForPointCount,
  requiredScratchBytes,
  SCRATCH_BYTES_PER_POINT,
  SCRATCH_SIZE_FACTOR,
  withConversionLock,
  type FileFingerprint,
  type LockManagerLike,
} from "./opfs";

describe("cacheKeyFor", () => {
  it("同じ指紋からは同じキーが決定的に出る", () => {
    const fp: FileFingerprint = { name: "a.laz", size: 1234, lastModified: 5678 };
    expect(cacheKeyFor(fp)).toBe(cacheKeyFor({ ...fp }));
  });

  it("名前・サイズ・更新日時のいずれかが違えば別のキーになる", () => {
    const base: FileFingerprint = { name: "a.laz", size: 1234, lastModified: 5678 };
    const byName = cacheKeyFor(base);
    expect(cacheKeyFor({ ...base, name: "b.laz" })).not.toBe(byName);
    expect(cacheKeyFor({ ...base, size: 1235 })).not.toBe(byName);
    expect(cacheKeyFor({ ...base, lastModified: 5679 })).not.toBe(byName);
  });

  it("OPFSのファイル名として安全な文字だけを返す(16進数8桁)", () => {
    const key = cacheKeyFor({ name: "変な/名前?.laz", size: 0, lastModified: 0 });
    expect(key).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("outputFileNameFor", () => {
  it("キーに.copc.lazを付けたものを返す", () => {
    const fp: FileFingerprint = { name: "a.laz", size: 1, lastModified: 1 };
    expect(outputFileNameFor(fp)).toBe(`${cacheKeyFor(fp)}.copc.laz`);
  });
});

describe("requiredScratchBytes(フォールバック、ファイルサイズから)", () => {
  it("ADR-0006の実測どおり入力サイズの11倍を必要量とする", () => {
    expect(SCRATCH_SIZE_FACTOR).toBe(11);
    expect(requiredScratchBytes(1_000)).toBe(11_000);
  });
});

// M4-9追記: 容量の見積もりを点数から出す(実機不具合の修正。
// opfs.tsのrequiredBytesForPointCountのドキュメント参照)。
describe("requiredBytesForPointCount", () => {
  it("M4-1bの実測(60 B/点の一時領域+10 B/点の出力)を根拠にした値を返す", () => {
    expect(SCRATCH_BYTES_PER_POINT).toBe(60);
    expect(OUTPUT_BYTES_PER_POINT).toBe(10);
    expect(requiredBytesForPointCount(1_000)).toBe(70_000);
  });

  it("点数に比例する(ファイルサイズに依存しない)", () => {
    expect(requiredBytesForPointCount(2_000)).toBe(requiredBytesForPointCount(1_000) * 2);
  });

  it("非圧縮PCD(sofi.pcd相当、3.64億点)でも、旧実装のファイルサイズ×11より\
現実的な値になる", () => {
    const sofiPointCount = 364_384_576;
    const sofiPcdFileSizeBytes = 9.47 * 1024 ** 3;
    const byPointCount = requiredBytesForPointCount(sofiPointCount);
    const byFileSizeFallback = requiredScratchBytes(sofiPcdFileSizeBytes);
    // 旧実装(ファイルサイズ×11)は9.47GB×11≈104GBという、実際には不要な
    // 過大な見積もりになっていた(実機不具合の原因)。点数からの見積もりは
    // それよりずっと小さい値になるはず。
    expect(byPointCount).toBeLessThan(byFileSizeFallback);
  });
});

describe("hasEnoughQuota", () => {
  it("空き容量が必要量以上なら足りると判定する", () => {
    const required = 11_000_000;
    expect(hasEnoughQuota({ quota: required, usage: 0 }, required)).toBe(true);
    expect(hasEnoughQuota({ quota: required - 1, usage: 0 }, required)).toBe(false);
  });

  it("使用済み(usage)を差し引いた空きで判定する", () => {
    const required = 11_000;
    expect(hasEnoughQuota({ quota: required + 500, usage: 500 }, required)).toBe(true);
    expect(hasEnoughQuota({ quota: required + 500, usage: 501 }, required)).toBe(false);
  });
});

describe("isScratchDirName", () => {
  it("新しい命名(pcv-scratch-<id>)を掃除の対象として認識する", () => {
    expect(isScratchDirName("pcv-scratch-abc123")).toBe(true);
    expect(isScratchDirName("pcv-scratch-")).toBe(true);
  });

  it("M4-6bの最初の実装が使っていた固定名も掃除の対象に含める", () => {
    expect(isScratchDirName("pcv-scratch")).toBe(true);
  });

  it("無関係な名前は対象にしない", () => {
    expect(isScratchDirName("pcv-converted")).toBe(false);
    expect(isScratchDirName("something-else")).toBe(false);
  });
});

describe("openHandlePool", () => {
  it("すべて成功すれば、作った順にハンドルの配列を返す", async () => {
    const created: number[] = [];
    const handles = await openHandlePool(
      3,
      async (i) => {
        created.push(i);
        return { id: i };
      },
      () => {
        throw new Error("成功経路ではcloseOneは呼ばれないはず");
      },
    );
    expect(handles).toEqual([{ id: 0 }, { id: 1 }, { id: 2 }]);
    expect(created).toEqual([0, 1, 2]);
  });

  it("途中で失敗したら、それまでに作ったハンドルをすべて閉じてから投げ直す", async () => {
    // 実機不具合の再現: N個目(ここでは3個目、index=2)で
    // createSyncAccessHandle相当が投げる偽物を用意する。
    const closed: number[] = [];
    const failure = new Error(
      "Failed to execute 'createSyncAccessHandle' on 'FileSystemFileHandle': ...",
    );

    await expect(
      openHandlePool(
        5,
        async (i) => {
          if (i === 2) throw failure;
          return { id: i };
        },
        (handle: { id: number }) => closed.push(handle.id),
      ),
    ).rejects.toBe(failure);

    // 0・1個目は成功して開いていたはずなので、両方とも閉じられている
    // (3・4個目はそもそも作られていないので閉じる対象にもならない)。
    expect(closed).toEqual([0, 1]);
  });

  it("M4-11: onProgressを渡すと、ハンドルを開くたびに(開いた数/総数)で呼ばれる", async () => {
    const progress: Array<[number, number]> = [];
    await openHandlePool(
      3,
      async (i) => ({ id: i }),
      () => {
        throw new Error("成功経路ではcloseOneは呼ばれないはず");
      },
      (opened, total) => progress.push([opened, total]),
    );
    expect(progress).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });

  it("後始末(closeOne)自体が失敗しても、残りのハンドルを閉じ続ける", async () => {
    const closed: number[] = [];
    const failure = new Error("作成失敗");

    await expect(
      openHandlePool(
        4,
        async (i) => {
          if (i === 3) throw failure;
          return { id: i };
        },
        (handle: { id: number }) => {
          closed.push(handle.id);
          if (handle.id === 1) throw new Error("close自体の失敗");
        },
      ),
    ).rejects.toBe(failure);

    // id=1のcloseが失敗しても、id=0・2は閉じようとし続けるはず。
    expect(closed).toEqual([0, 1, 2]);
  });
});

describe("withConversionLock", () => {
  function fakeLockManager(available: boolean): LockManagerLike {
    return {
      request: vi.fn(async (name, options, callback) => {
        expect(name).toBe(CONVERSION_LOCK_NAME);
        expect(options).toEqual({ ifAvailable: true });
        return callback(available ? {} : null);
      }),
    };
  }

  it("ロックが取れれば、callbackを実行しその結果を返す", async () => {
    const lockManager = fakeLockManager(true);
    const outcome = await withConversionLock(lockManager, async () => "変換結果");
    expect(outcome).toEqual({ kind: "acquired", result: "変換結果" });
  });

  it("ロックが取れなければ、callbackを一切呼ばずbusyを返す", async () => {
    const lockManager = fakeLockManager(false);
    const callback = vi.fn(async () => "呼ばれないはず");
    const outcome = await withConversionLock(lockManager, callback);
    expect(outcome).toEqual({ kind: "busy" });
    expect(callback).not.toHaveBeenCalled();
  });

  it("callbackが失敗しても、そのままrejectする(ロックはrequestの仕様どおりcallbackの終了まで持たれる)", async () => {
    const lockManager = fakeLockManager(true);
    const failure = new Error("変換に失敗した");
    await expect(
      withConversionLock(lockManager, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
  });
});