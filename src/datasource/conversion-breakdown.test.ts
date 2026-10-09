// conversion-breakdown.ts のテスト。段階ごとの内訳を所有者がそのまま報告できる
// テキストに整形する関数(文字列の組み立てだけを行う純粋関数)を確認する。

import { describe, expect, it } from "vitest";
import { formatConversionBreakdown, type ConversionBreakdownMeta } from "./conversion-breakdown";
import type { ConversionStageBreakdown } from "./conversion-dto";

const DESKTOP_BREAKDOWN: ConversionStageBreakdown = {
  sourceReadAndDecodeSecs: 10,
  spillWriteSecs: 5,
  lodIndexBuildSecs: 60,
  nodeCompressionSecs: 20,
  headerAndHierarchyWriteSecs: 0.1,
  totalSecs: 95.1,
  opfsIoSecs: null,
  opfsReadAtCalls: null,
  opfsCacheHits: null,
  opfsCacheMisses: null,
  opfsBytesReadFromOpfs: null,
  opfsReadSecs: null,
  pointCount: 66_848_096,
  fileSizeBytes: 470_599_680, // 448.8 MiB
};

const DESKTOP_META: ConversionBreakdownMeta = {
  platform: "desktop",
  format: "laz",
  fileName: "beer.laz",
};

describe("formatConversionBreakdown", () => {
  it("デスクトップ: 見出し・メタ情報・5段階・合計を含む(OPFSの行は出さない)", () => {
    const text = formatConversionBreakdown(DESKTOP_BREAKDOWN, DESKTOP_META);

    expect(text).toContain("変換の内訳 (デスクトップ)");
    expect(text).toContain("ファイル: beer.laz");
    expect(text).toContain("形式: laz");
    expect(text).toContain("点数: 66,848,096");
    expect(text).toContain("入力ファイルサイズ: 448.8 MiB");
    expect(text).toContain("入力の読み込みと展開: 10.000秒");
    expect(text).toContain("一時ファイルへの書き込み: 5.000秒");
    expect(text).toContain("octreeの分割(LOD): 60.000秒");
    expect(text).toContain("ノードの圧縮: 20.000秒");
    expect(text).toContain("書き出し: 0.100秒");
    expect(text).toContain("合計: 95.100秒");
    expect(text).not.toContain("OPFS");
    expect(text).not.toContain("ブラウザ");
  });

  it("各段階の割合(%)が合計に対して正しく計算される", () => {
    const text = formatConversionBreakdown(DESKTOP_BREAKDOWN, DESKTOP_META);
    // 60 / 95.1 * 100 = 63.09...% -> 63.1%
    expect(text).toContain("octreeの分割(LOD): 60.000秒 (63.1%)");
    // 20 / 95.1 * 100 = 21.03...% -> 21.0%
    expect(text).toContain("ノードの圧縮: 20.000秒 (21.0%)");
  });

  it("Web版: OPFSの参考値・ブラウザ・論理コア数・メモリの行を追加する", () => {
    const breakdown: ConversionStageBreakdown = {
      ...DESKTOP_BREAKDOWN,
      opfsIoSecs: 12.5,
    };
    const meta: ConversionBreakdownMeta = {
      platform: "web",
      format: "las",
      fileName: "beer.las",
      browser: "Mozilla/5.0 (test)",
      hardwareConcurrency: 8,
      deviceMemoryGiB: 8,
    };

    const text = formatConversionBreakdown(breakdown, meta);

    expect(text).toContain("変換の内訳 (Web)");
    expect(text).toContain("ブラウザ: Mozilla/5.0 (test)");
    expect(text).toContain("論理コア数: 8");
    expect(text).toContain("メモリ: 約8GiB");
    expect(text).toContain("(参考)OPFSの読み書き合計: 12.500秒");
    // この内訳自体はread_at統計を持たない(null)ので、その行は出ない。
    expect(text).not.toContain("read_at");
  });

  it("M4-13: OPFS範囲読み(read_at)の統計がすべて揃っていれば行を追加する", () => {
    const breakdown: ConversionStageBreakdown = {
      ...DESKTOP_BREAKDOWN,
      opfsIoSecs: 12.5,
      opfsReadAtCalls: 6_199_414,
      opfsCacheHits: 123_456,
      opfsCacheMisses: 6_075_958,
      opfsBytesReadFromOpfs: 6_075_958 * 65536,
      opfsReadSecs: 9.8,
    };
    const meta: ConversionBreakdownMeta = {
      platform: "web",
      format: "las",
      fileName: "beer.las",
    };

    const text = formatConversionBreakdown(breakdown, meta);

    expect(text).toContain("read_at");
    expect(text).toContain("呼び出し6,199,414回");
    expect(text).toContain("キャッシュヒット123,456回");
    expect(text).toContain("ミス6,075,958回");
    // 123456 / (123456 + 6075958) * 100 = 1.99...% -> 2.0%
    expect(text).toContain("ヒット率2.0%");
    expect(text).toContain("OPFS範囲読みの実I/O時間: 9.800秒");
  });

  it("hardwareConcurrency/deviceMemoryGiBが無ければその行を出さない", () => {
    const meta: ConversionBreakdownMeta = {
      platform: "web",
      format: "las",
      fileName: "beer.las",
      browser: "Mozilla/5.0 (test)",
    };
    const text = formatConversionBreakdown(DESKTOP_BREAKDOWN, meta);
    expect(text).not.toContain("論理コア数");
    expect(text).not.toContain("メモリ");
  });

  it("合計が0のときは割合を出さない(0除算を避ける)", () => {
    const zero: ConversionStageBreakdown = {
      sourceReadAndDecodeSecs: 0,
      spillWriteSecs: 0,
      lodIndexBuildSecs: 0,
      nodeCompressionSecs: 0,
      headerAndHierarchyWriteSecs: 0,
      totalSecs: 0,
      opfsIoSecs: null,
      opfsReadAtCalls: null,
      opfsCacheHits: null,
      opfsCacheMisses: null,
      opfsBytesReadFromOpfs: null,
      opfsReadSecs: null,
      pointCount: 0,
      fileSizeBytes: 0,
    };
    const text = formatConversionBreakdown(zero, DESKTOP_META);
    expect(text).toContain("入力の読み込みと展開: 0.000秒");
    expect(text).not.toContain("%");
  });

  it("ファイルサイズが1GiB以上ならGiB表示になる", () => {
    const breakdown: ConversionStageBreakdown = {
      ...DESKTOP_BREAKDOWN,
      fileSizeBytes: 2 * 1024 * 1024 * 1024,
    };
    const text = formatConversionBreakdown(breakdown, DESKTOP_META);
    expect(text).toContain("入力ファイルサイズ: 2.00 GiB");
  });
});
