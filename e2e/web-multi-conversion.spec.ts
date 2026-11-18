import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { buildSyntheticLas } from "../scripts/make-test-las";

const TIME_THE_RESULT_MUST_STAY_VISIBLE_MS = 2000;

test("複数のLASファイルを一緒に選ぶとWeb版で1つにマージされ、点数が合計と一致する", async ({
  page,
}) => {
  const consoleMessages: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (msg) => consoleMessages.push(msg.text()));
  page.on("pageerror", (err) => pageErrors.push(String(err)));

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

    expect(chooser.isMultiple()).toBe(true);
    await chooser.setFiles(lasPaths);

    const breakdown = page.getByTestId("conversion-breakdown");
    await expect(breakdown).toBeVisible({ timeout: 60_000 });
    await page.waitForTimeout(TIME_THE_RESULT_MUST_STAY_VISIBLE_MS);
    await expect(breakdown).toBeVisible();

    await expect(breakdown).toContainText("入力ファイル数: 3");

    await expect(page.getByTestId("viewer-error")).toHaveCount(0);

    const panicked = consoleMessages.filter((m) => m.includes("panicked at"));
    expect(panicked, `Consoleにpanicが出た:\n${panicked.join("\n")}`).toHaveLength(0);
    expect(pageErrors, `ページで未処理のエラーが発生した:\n${pageErrors.join("\n")}`).toHaveLength(0);

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
    await page.waitForTimeout(TIME_THE_RESULT_MUST_STAY_VISIBLE_MS);
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
