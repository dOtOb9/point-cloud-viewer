import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { buildSyntheticLas } from "../scripts/make-test-las";

const TIME_THE_RESULT_MUST_STAY_VISIBLE_MS = 2000;

test("LASファイルを選ぶとWeb版で変換され、内訳とダウンロードが表示される", async ({ page }) => {
  const consoleMessages: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (msg) => consoleMessages.push(msg.text()));
  page.on("pageerror", (err) => pageErrors.push(String(err)));

  const tmpDir = mkdtempSync(join(tmpdir(), "pcv-e2e-"));
  const lasPath = join(tmpDir, "synthetic.las");
  writeFileSync(lasPath, buildSyntheticLas({ pointCount: 2000, seed: 7 }));

  try {
    await page.goto("./");

    const openButton = page.getByTestId("open-button");
    await expect(openButton).toBeVisible({ timeout: 30_000 });
    const chooserPromise = page.waitForEvent("filechooser");
    await openButton.click();
    const chooser = await chooserPromise;
    await chooser.setFiles(lasPath);

    const breakdown = page.getByTestId("conversion-breakdown");
    await expect(breakdown).toBeVisible({ timeout: 45_000 });

    await page.waitForTimeout(TIME_THE_RESULT_MUST_STAY_VISIBLE_MS);
    await expect(breakdown).toBeVisible();

    const downloadLink = page.getByTestId("download-link");
    await expect(downloadLink).toBeVisible();

    await expect(page.getByTestId("viewer-error")).toHaveCount(0);

    const panicked = consoleMessages.filter((m) => m.includes("panicked at"));
    expect(panicked, `Consoleにpanicが出た:\n${panicked.join("\n")}`).toHaveLength(0);
    expect(pageErrors, `ページで未処理のエラーが発生した:\n${pageErrors.join("\n")}`).toHaveLength(0);

    const openedLine = consoleMessages.find((m) => m.includes("[M1] opened"));
    expect(openedLine, "変換後にファイルを開いたログ([M1] opened)が出ていない").toBeDefined();
    const match = openedLine?.match(/points=(\d+) nodes=(\d+)/);
    expect(match, `[M1] openedの形式が想定と違う: ${openedLine}`).not.toBeNull();
    if (match) {
      expect(Number(match[1])).toBeGreaterThan(0);
      expect(Number(match[2])).toBeGreaterThan(0);
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
