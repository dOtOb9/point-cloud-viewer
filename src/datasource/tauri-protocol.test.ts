// tauri-protocol.ts のテスト。
//
// v0.1.3でノード読み出しが全滅した不具合の再発防止テスト（TaskSheets/
// M1-point-rendering.md参照）: 壊れていた原因は、`convertFileSrc`に渡す文字列の
// 「組み立て」自体ではなく、それをRust側が実際に届く形（パーセントエンコード済み）
// で一度も解析していなかったことにあった。このファイルでは「組み立て」側の形を
// 確認し、Rust側（`src-tauri/src/lib.rs`の`parse_pcv_path`）のテストで
// 「実際に届く形をそのまま解析できること」を確認する（役割を分けている）。

import { describe, expect, it } from "vitest";
import { buildNodeRequestPath } from "./tauri-protocol";

describe("buildNodeRequestPath", () => {
  it("世代番号とノードキーを'/'区切りで組み立てる", () => {
    expect(buildNodeRequestPath(0, "1-1-1-1")).toBe("0/1-1-1-1");
  });

  it("世代番号が進んでも区切りの位置がぶれない", () => {
    expect(buildNodeRequestPath(42, "3-0-0-0")).toBe("42/3-0-0-0");
  });

  it("ベンチ用の'/<size>'形式(数字のみ)とは常に区別できる('/'を含む)", () => {
    const path = buildNodeRequestPath(0, "0-0-0-0");
    expect(path).toContain("/");
    // ベンチ用の`/<size>`は純粋な数値1個なので、parseFloatで全体が数値には
    // ならないことを確認する(Rust側の`parse_pcv_path`がBenchと区別する条件と対応)。
    expect(Number.isNaN(Number(path))).toBe(true);
  });
});
