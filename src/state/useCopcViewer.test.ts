// useCopcViewer.ts のテスト。フック本体はPointCloudRenderer/DataSourceを
// 起動する大きな副作用を持つためテストしにくい(useTheme.test.tsの
// resolveThemeと同じ理由)。このファイルでは、不具合修正
// (2026-10-08、「変換の内訳が出てこない」)で切り出した純粋関数
// shouldClearConversionResultOnOpenだけを確認する。

import { describe, expect, it } from "vitest";
import { shouldClearConversionResultOnOpen } from "./useCopcViewer";

describe("shouldClearConversionResultOnOpen (不具合修正 2026-10-08)", () => {
  it("変換完了から続けて開く場合(isConversionContinuation=true)は、内訳・ダウンロードリンクを残す", () => {
    expect(shouldClearConversionResultOnOpen(true)).toBe(false);
  });

  it("利用者が自分で別のファイルを開く場合(既定false)は、内訳・ダウンロードリンクを消す", () => {
    expect(shouldClearConversionResultOnOpen(false)).toBe(true);
  });
});
