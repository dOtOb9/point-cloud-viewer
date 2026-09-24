// gpu-error-log.ts のテスト。
//
// GpuErrorLogはWebGPUに一切依存しない純粋なクラスなので、GPUDeviceのモックは
// 要らない。蓄積・重複抑制のロジックだけを直接検証する。

import { describe, expect, it } from "vitest";
import { GpuErrorLog } from "./gpu-error-log";

describe("GpuErrorLog", () => {
  it("1件も報告していない状態ではlist()が空", () => {
    const log = new GpuErrorLog();
    expect(log.list()).toEqual([]);
  });

  it("1件報告するとcount=1のエントリが1つできる", () => {
    const log = new GpuErrorLog();
    log.report("boom", 100);
    const entries = log.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ message: "boom", count: 1, firstAt: 100, lastAt: 100 });
  });

  it("同じメッセージが連続したら1件にまとめる（連投の抑制）", () => {
    const log = new GpuErrorLog();
    log.report("same error", 100);
    log.report("same error", 200);
    log.report("same error", 300);
    const entries = log.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ message: "same error", count: 3, firstAt: 100, lastAt: 300 });
  });

  it("異なるメッセージは両方保持される（新しいほうが末尾に追加される）", () => {
    const log = new GpuErrorLog();
    log.report("error A", 100);
    log.report("error B", 200);
    const entries = log.list();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ message: "error A", count: 1 });
    expect(entries[1]).toMatchObject({ message: "error B", count: 1 });
  });

  it("同じメッセージでも間に別のメッセージを挟むと別エントリになる（直前との一致だけを見る）", () => {
    const log = new GpuErrorLog();
    log.report("error A", 100);
    log.report("error B", 200);
    log.report("error A", 300);
    const entries = log.list();
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.message)).toEqual(["error A", "error B", "error A"]);
  });

  it("エントリごとに一意のidが振られる", () => {
    const log = new GpuErrorLog();
    log.report("error A");
    log.report("error B");
    const [a, b] = log.list();
    expect(a.id).not.toBe(b.id);
  });

  it("dismiss()で指定したidのエントリだけが消える（他のエラーは残る＝最初のエラーが見えなくならない）", () => {
    const log = new GpuErrorLog();
    log.report("error A", 100);
    log.report("error B", 200);
    const [a, b] = log.list();

    log.dismiss(a.id);

    const remaining = log.list();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(b.id);
  });

  it("存在しないidをdismiss()しても何も起きない", () => {
    const log = new GpuErrorLog();
    log.report("error A");
    log.dismiss(9999);
    expect(log.list()).toHaveLength(1);
  });

  it("nowを省略するとDate.now()相当の値が使われる（呼び出し側でタイムスタンプを用意しなくても動く）", () => {
    const log = new GpuErrorLog();
    const before = Date.now();
    log.report("error A");
    const after = Date.now();
    const [entry] = log.list();
    expect(entry.firstAt).toBeGreaterThanOrEqual(before);
    expect(entry.firstAt).toBeLessThanOrEqual(after);
  });

  // M3(ADR-0013): pcv://のノード読み出し失敗も同じログに乗せる。sourceを
  // 指定しなければ既存の呼び出し元（GPUエラー）と同じ"gpu"になる。
  it("sourceを省略すると既定で\"gpu\"になる", () => {
    const log = new GpuErrorLog();
    log.report("boom", 100);
    expect(log.list()[0].source).toBe("gpu");
  });

  it("sourceに\"node-read\"を指定して報告できる", () => {
    const log = new GpuErrorLog();
    log.report("ノード読み出し失敗", undefined, "node-read");
    const [entry] = log.list();
    expect(entry.source).toBe("node-read");
    expect(entry.message).toBe("ノード読み出し失敗");
  });

  it("メッセージが同じでもsourceが違えば別エントリになる（発生元が紛れ込まない）", () => {
    const log = new GpuErrorLog();
    log.report("same text", 100, "gpu");
    log.report("same text", 200, "node-read");
    const entries = log.list();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ source: "gpu", count: 1 });
    expect(entries[1]).toMatchObject({ source: "node-read", count: 1 });
  });

  it("メッセージとsourceが両方同じなら連投として1件にまとめる", () => {
    const log = new GpuErrorLog();
    log.report("same text", 100, "node-read");
    log.report("same text", 200, "node-read");
    const entries = log.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ source: "node-read", count: 2 });
  });
});
