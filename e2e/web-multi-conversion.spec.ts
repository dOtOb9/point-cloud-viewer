import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { buildSyntheticLas } from "../scripts/make-test-las";

/**
 * M4-14: 複数のLAS/LAZを選択したときのWeb版の変換(マージ)を、実際の
 * ブラウザ(ヘッドレスChromium)で1回通すE2Eテスト。
 *
 * `e2e/web-conversion.spec.ts`(単一ファイル版、`TaskSheets/
 * ADR-0016-e2e-web-conversion.md`参照)と同じ理由・同じ方式。「テストも
 * CIも緑なのに実際のブラウザでは壊れている」を防ぐため、このテストでしか
 * 検出できない複数ファイル特有の不具合(`WasmConverter::openNextFile`の
 * 呼び出し順、進捗バーの合計点数の計算、キャッシュキーの組み立てなど)を
 * 狙う。
 *
 * 何を確かめ、何を確かめていないか:
 * - 確かめる: 3つの合成LAS(scale/offsetが異なる)を一緒に選ぶと変換が
 *   完了すること、「変換の内訳」に入力ファイル数(3)が出ること、
 *   エラー・panicが出ないこと、開いた点群の点数が3入力の合計と一致すること
 * - 確かめていない: デスクトップ(Tauri)版、Android版、実データ(Shibuya
 *   タイル、別途`TaskSheets/M4-import-and-conversion.md`のM4-14で手動確認)、
 *   タイルが地理的に隣接して「seamlessに繋がって見える」かどうか(合成データは
 *   ランダムな点群なので見た目の継ぎ目は確認できない。実データでの確認は
 *   手動の受け入れ条件)
 */

test("複数のLASファイルを一緒に選ぶとWeb版で1つにマージされ、点数が合計と一致する", async ({
  page,
}) => {
  const consoleMessages: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (msg) => consoleMessages.push(msg.text()));
  page.on("pageerror", (err) => pageErrors.push(String(err)));

  // 3つの合成LAS。点数・乱数の種・scale/offsetをすべて違えて、
  // 「異なるscale/offsetを持つ入力を混ぜても正しくマージされる」ことを
  // 実ブラウザで踏めるようにする(`crates/pcv-convert/src/merge.rs`の
  // `merging_with_different_scale_and_offset_keeps_real_world_coordinates`の
  // Web版相当)。
  const pointCounts = [500, 700, 300] as const;
  const tiles = [
    { pointCount: pointCounts[0], seed: 101, offsetX: 0, offsetY: 0, offsetZ: 0 },
    { pointCount: pointCounts[1], seed: 102, offsetX: 1000, offsetY: 0, offsetZ: 0 },
    { pointCount: pointCounts[2], seed: 103, offsetX: 0, offsetY: 1000, offsetZ: 10 },
  ];
  const expectedTotalPoints = pointCounts.reduce((sum, n) => sum + n, 0);

  const tmpDir = mkdtempSync(join(tmpdir(), "pcv-e2e-multi-"));
  const lasPaths = tiles.map((tile, i) => {
    const path = join(tmpDir, `tile-${i}.las`);
    writeFileSync(path, buildSyntheticLas(tile));
    return path;
  });

  try {
    await page.goto("./");

    const openButton = page.getByTestId("open-button");
    await expect(openButton).toBeVisible({ timeout: 30_000 });
    const chooserPromise = page.waitForEvent("filechooser");
    await openButton.click();
    const chooser = await chooserPromise;

    // 受け入れ条件: 複数ファイルを一緒に選べる(chooserが複数選択を許す)。
    expect(chooser.isMultiple()).toBe(true);
    await chooser.setFiles(lasPaths);

    const breakdown = page.getByTestId("conversion-breakdown");
    await expect(breakdown).toBeVisible({ timeout: 60_000 });
    await page.waitForTimeout(2000);
    await expect(breakdown).toBeVisible();

    // 受け入れ条件: 内訳が入力ファイル数を示す。
    await expect(breakdown).toContainText("入力ファイル数: 3");

    await expect(page.getByTestId("viewer-error")).toHaveCount(0);

    const panicked = consoleMessages.filter((m) => m.includes("panicked at"));
    expect(panicked, `Consoleにpanicが出た:\n${panicked.join("\n")}`).toHaveLength(0);
    expect(pageErrors, `ページで未処理のエラーが発生した:\n${pageErrors.join("\n")}`).toHaveLength(0);

    // 受け入れ条件: 点数が3入力の合計と一致する。
    const openedLine = consoleMessages.find((m) => m.includes("[M1] opened"));
    expect(openedLine, "変換後にファイルを開いたログ([M1] opened)が出ていない").toBeDefined();
    const match = openedLine?.match(/points=(\d+) nodes=(\d+)/);
    expect(match, `[M1] openedの形式が想定と違う: ${openedLine}`).not.toBeNull();
    if (match) {
      expect(Number(match[1])).toBe(expectedTotalPoints);
      expect(Number(match[2])).toBeGreaterThan(0);
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

/**
 * M4-17: LAS and PLY selected together are merged into one COPC (the point merge) in a real browser.
 * Checks that the conversion finishes, the point count is the sum, the breakdown shows 2 input files,
 * there is no error and no panic. Not checked: how the merged cloud looks (gray points of the PLY
 * next to the colored LAS points), which is a manual check on real files.
 */
test("LASとPLYを一緒に選ぶとWeb版で1つにマージされ、点数が合計と一致する", async ({ page }) => {
  const consoleMessages: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (msg) => consoleMessages.push(msg.text()));
  page.on("pageerror", (err) => pageErrors.push(String(err)));

  const lasPointCount = 500;
  const plyPointCount = 300;

  const tmpDir = mkdtempSync(join(tmpdir(), "pcv-e2e-mixed-"));
  const lasPath = join(tmpDir, "tile.las");
  writeFileSync(lasPath, buildSyntheticLas({ pointCount: lasPointCount, seed: 201 }));
  // A small ascii PLY without color: its points become mid gray in the merged output.
  const plyRows = Array.from({ length: plyPointCount }, (_, i) => `${(i % 50) * 0.5} ${(i % 30) * 0.5} ${i % 10}`);
  const plyPath = join(tmpDir, "scan.ply");
  writeFileSync(
    plyPath,
    [
      "ply",
      "format ascii 1.0",
      `element vertex ${plyPointCount}`,
      "property float x",
      "property float y",
      "property float z",
      "end_header",
      ...plyRows,
      "",
    ].join("\n"),
  );

  try {
    await page.goto("./");

    const openButton = page.getByTestId("open-button");
    await expect(openButton).toBeVisible({ timeout: 30_000 });
    const chooserPromise = page.waitForEvent("filechooser");
    await openButton.click();
    const chooser = await chooserPromise;
    await chooser.setFiles([lasPath, plyPath]);

    const breakdown = page.getByTestId("conversion-breakdown");
    await expect(breakdown).toBeVisible({ timeout: 60_000 });
    await page.waitForTimeout(2000);
    await expect(breakdown).toBeVisible();
    await expect(breakdown).toContainText("入力ファイル数: 2");
    await expect(page.getByTestId("viewer-error")).toHaveCount(0);

    const panicked = consoleMessages.filter((m) => m.includes("panicked at"));
    expect(panicked, `Consoleにpanicが出た:\n${panicked.join("\n")}`).toHaveLength(0);
    expect(pageErrors, `ページで未処理のエラーが発生した:\n${pageErrors.join("\n")}`).toHaveLength(0);

    const openedLine = consoleMessages.find((m) => m.includes("[M1] opened"));
    expect(openedLine, "変換後にファイルを開いたログ([M1] opened)が出ていない").toBeDefined();
    const match = openedLine?.match(/points=(\d+) nodes=(\d+)/);
    expect(match, `[M1] openedの形式が想定と違う: ${openedLine}`).not.toBeNull();
    if (match) {
      expect(Number(match[1])).toBe(lasPointCount + plyPointCount);
      expect(Number(match[2])).toBeGreaterThan(0);
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
