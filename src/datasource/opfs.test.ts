// opfs.ts の純粋関数(キャッシュのキー・容量の判定)のテスト。
// 実際のOPFS I/Oはブラウザでしか意味を持たないため、ここではテストしない
// (所有者がブラウザで確かめる手順は TaskSheets/M4-import-and-conversion.md の
// M4-6bに書く)。

import { describe, expect, it, vi } from "vitest";
import {
  cacheKeyFor,
  CONVERSION_LOCK_NAME,
  describeInsufficientSpaceWeb,
  ensurePersistentStorage,
  hasEnoughQuota,
  isScratchDirName,
  openHandlePool,
  outputFileNameFor,
  OUTPUT_BYTES_PER_POINT,
  requiredBytesForPointCount,
  requiredScratchBytes,
  SCRATCH_BYTES_PER_POINT,
  SCRATCH_SIZE_FACTOR,
  toGiBLabel,
  withConversionLock,
  type FileFingerprint,
  type LockManagerLike,
  type PersistableStorageLike,
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

// M4-6追記(「空き容量が足りません」の改善): 永続化の要求フロー。
// `navigator.storage`を直接使わず、テストから差し替え可能な
// `PersistableStorageLike`を注入する(`withConversionLock`と同じ方針)。
describe("ensurePersistentStorage", () => {
  function fakeStorage(persistedInitially: boolean, persistResult: boolean): PersistableStorageLike {
    return {
      persisted: vi.fn(async () => persistedInitially),
      persist: vi.fn(async () => persistResult),
    };
  }

  it("既に永続化済みなら、persist()を呼ばずにそう報告する", async () => {
    const storage = fakeStorage(true, false);
    const outcome = await ensurePersistentStorage(storage);
    expect(outcome).toEqual({ alreadyPersisted: true, grantedNow: false, persisted: true });
    expect(storage.persist).not.toHaveBeenCalled();
  });

  it("未許可でpersist()が許可を返したら、persisted=trueで報告する", async () => {
    const storage = fakeStorage(false, true);
    const outcome = await ensurePersistentStorage(storage);
    expect(outcome).toEqual({ alreadyPersisted: false, grantedNow: true, persisted: true });
    expect(storage.persist).toHaveBeenCalledTimes(1);
  });

  it("未許可でpersist()が拒否を返したら、persisted=falseで報告する(例: Firefoxでユーザーが拒否)", async () => {
    const storage = fakeStorage(false, false);
    const outcome = await ensurePersistentStorage(storage);
    expect(outcome).toEqual({ alreadyPersisted: false, grantedNow: false, persisted: false });
  });
});

describe("toGiBLabel", () => {
  it("バイトを小数1桁のGiBに変換する", () => {
    expect(toGiBLabel(10 * 1024 ** 3)).toBe("約10.0GiB");
    expect(toGiBLabel(0)).toBe("約0.0GiB");
  });
});

// M4-6追記: 容量不足の表示の文言組み立て(純粋関数)。所有者の実機不具合
// (「空き容量が足りません(10.0GiB)」が必要量か空きか分からなかった)の
// 修正として、必要・空き・上限・使用中を分けて出し、空ける方法を示す。
describe("describeInsufficientSpaceWeb", () => {
  const base = {
    requiredBytes: 20 * 1024 ** 3,
    quotaBytes: 10 * 1024 ** 3,
    usageBytes: 1 * 1024 ** 3,
    persisted: false,
    reclaimableBytes: 0,
  };

  it("必要・空き・上限・使用中を分けて出す", () => {
    const message = describeInsufficientSpaceWeb(base);
    expect(message).toContain("必要: 約20.0GiB");
    expect(message).toContain("空き: 約9.0GiB"); // quota(10) - usage(1)
    expect(message).toContain("上限 約10.0GiB");
    expect(message).toContain("使用中 約1.0GiB");
  });

  it("消せる量(reclaimableBytes)が無ければ、キャッシュを消す提案を出さない", () => {
    const message = describeInsufficientSpaceWeb(base);
    expect(message).not.toContain("キャッシュ");
  });

  it("消せる量があれば、その量を含めてキャッシュ・一時ファイルを消す提案を出す", () => {
    const message = describeInsufficientSpaceWeb({ ...base, reclaimableBytes: 2 * 1024 ** 3 });
    expect(message).toContain("キャッシュ");
    expect(message).toContain("約2.0GiB");
  });

  it("永続化されていなければ、許可する提案を出す", () => {
    const message = describeInsufficientSpaceWeb({ ...base, persisted: false });
    expect(message).toContain("永続的な保存を許可する");
  });

  it("既に永続化されていれば、許可する提案は出さない", () => {
    const message = describeInsufficientSpaceWeb({ ...base, persisted: true });
    expect(message).not.toContain("永続的な保存を許可する");
  });

  it("常にデスクトップ版での変換を案内する", () => {
    const message = describeInsufficientSpaceWeb(base);
    expect(message).toContain("デスクトップ版でCOPC(.copc.laz)に変換してから開く");
  });

  it("空きがusage>quotaで負になる異常値でも0未満にはならない(Math.maxで安全側に倒す)", () => {
    const message = describeInsufficientSpaceWeb({ ...base, quotaBytes: 1, usageBytes: 2 });
    expect(message).toContain("空き: 約0.0GiB");
  });
});