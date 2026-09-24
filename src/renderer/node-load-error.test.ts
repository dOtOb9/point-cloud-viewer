import { describe, expect, it } from "vitest";
import { formatNodeLoadErrorMessage } from "./node-load-error";

describe("formatNodeLoadErrorMessage", () => {
  it("Errorのmessageを要約せずそのまま含める", () => {
    const error = new Error("pcv://0-0-0-0 failed: 500");
    const message = formatNodeLoadErrorMessage("0-0-0-0", error);
    expect(message).toContain("pcv://0-0-0-0 failed: 500");
  });

  it("Rustのpanicメッセージのような長い本文でも一切変更しない", () => {
    // 実際にsrc-tauri/src/copc_state.rsのReadNodeError::Panickedが返す形に近い文字列。
    const raw = "ノード0-1-2-3の読み出し中にpanicが発生した: index out of bounds: the len is 4 but the index is 10";
    const error = new Error(raw);
    const message = formatNodeLoadErrorMessage("0-1-2-3", error);
    expect(message).toContain(raw);
  });

  it("ノードキーが分かるように前に含める", () => {
    const message = formatNodeLoadErrorMessage("2-3-4-5", new Error("boom"));
    expect(message).toContain("2-3-4-5");
  });

  it("Errorでない値(文字列や数値)が投げられた場合もString()化してそのまま含める", () => {
    const message = formatNodeLoadErrorMessage("0-0-0-0", "plain string failure");
    expect(message).toContain("plain string failure");
  });
});
