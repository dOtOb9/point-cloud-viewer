import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const STILL_VISIBLE_WAIT_MS = 2000;
const XYZ_FLOAT_BYTES = 3 * 4;
const RGB_UCHAR_BYTES = 3;

const POINT_COUNT = 2000;

function buildSyntheticPly(pointCount: number): Buffer {
  const header =
    "ply\nformat binary_little_endian 1.0\n" +
    `element vertex ${pointCount}\n` +
    "property float x\nproperty float y\nproperty float z\n" +
    "property uchar red\nproperty uchar green\nproperty uchar blue\n" +
    "element face 1\nproperty list uchar int vertex_indices\n" +
    "end_header\n";
  const row = XYZ_FLOAT_BYTES + RGB_UCHAR_BYTES;
  const body = Buffer.alloc(pointCount * row);
  for (let i = 0; i < pointCount; i++) {
    const at = i * row;
    body.writeFloatLE(((i * 37) % 500) * 0.1, at);
    body.writeFloatLE(((i * 53) % 500) * 0.1, at + 4);
    body.writeFloatLE(((i * 13) % 200) * 0.1, at + 8);
    body.writeUInt8(i % 256, at + 12);
    body.writeUInt8((i * 3) % 256, at + 13);
    body.writeUInt8((i * 7) % 256, at + 14);
  }
  const face = Buffer.alloc(1 + 3 * 4);
  face.writeUInt8(3, 0);
  face.writeInt32LE(0, 1);
  face.writeInt32LE(1, 5);
  face.writeInt32LE(2, 9);
  return Buffer.concat([Buffer.from(header, "ascii"), body, face]);
}

async function convertThroughTheOpenButton(page: Page, filePath: string): Promise<void> {
  const consoleMessages: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (msg) => consoleMessages.push(msg.text()));
  page.on("pageerror", (err) => pageErrors.push(String(err)));

  await page.goto("./");
  const openButton = page.getByTestId("open-button");
  await expect(openButton).toBeVisible({ timeout: 30_000 });
  const chooserPromise = page.waitForEvent("filechooser");
  await openButton.click();
  const chooser = await chooserPromise;
  await chooser.setFiles(filePath);

  const breakdown = page.getByTestId("conversion-breakdown");
  await expect(breakdown).toBeVisible({ timeout: 45_000 });
  await page.waitForTimeout(STILL_VISIBLE_WAIT_MS);
  await expect(breakdown).toBeVisible();
  await expect(page.getByTestId("download-link")).toBeVisible();
  await expect(page.getByTestId("viewer-error")).toHaveCount(0);

  const panicked = consoleMessages.filter((m) => m.includes("panicked at"));
  expect(panicked, `panic in the console:\n${panicked.join("\n")}`).toHaveLength(0);
  expect(pageErrors, `unhandled page errors:\n${pageErrors.join("\n")}`).toHaveLength(0);

  const openedLine = consoleMessages.find((m) => m.includes("[M1] opened"));
  expect(openedLine, "no '[M1] opened' log after the conversion").toBeDefined();
  const match = openedLine?.match(/points=(\d+) nodes=(\d+)/);
  expect(match, `unexpected '[M1] opened' format: ${openedLine}`).not.toBeNull();
  if (match) {
    expect(Number(match[1])).toBe(POINT_COUNT);
    expect(Number(match[2])).toBeGreaterThan(0);
  }
}

test("PLY file is converted on the Web and opens", async ({ page }) => {
  const tmpDir = mkdtempSync(join(tmpdir(), "pcv-e2e-ply-"));
  try {
    const plyPath = join(tmpDir, "synthetic.ply");
    writeFileSync(plyPath, buildSyntheticPly(POINT_COUNT));
    await convertThroughTheOpenButton(page, plyPath);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("E57 file is converted on the Web and opens", async ({ page }) => {
  const tmpDir = mkdtempSync(join(tmpdir(), "pcv-e2e-e57-"));
  try {
    const e57Path = join(tmpDir, "synthetic.e57");
    try {
      execFileSync(
        "cargo",
        ["test", "--manifest-path", "crates/pcv-wasm/Cargo.toml", "--lib", "write_e57_fixture_for_e2e", "--", "--ignored"],
        { env: { ...process.env, PCV_E57_FIXTURE: e57Path }, stdio: "pipe" },
      );
    } catch (e) {
      test.skip(true, `cannot create the E57 fixture (is cargo installed?): ${String(e)}`);
    }
    await convertThroughTheOpenButton(page, e57Path);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("PCD file is converted on the Web and opens", async ({ page }) => {
  const tmpDir = mkdtempSync(join(tmpdir(), "pcv-e2e-pcd-"));
  try {
    const pcdPath = join(tmpDir, "synthetic.pcd");
    const rows = Array.from({ length: POINT_COUNT }, (_, i) => `${((i * 37) % 500) * 0.1} ${((i * 53) % 500) * 0.1} ${((i * 13) % 200) * 0.1}`);
    writeFileSync(
      pcdPath,
      [
        "VERSION .7",
        "FIELDS x y z",
        "SIZE 4 4 4",
        "TYPE F F F",
        "COUNT 1 1 1",
        `WIDTH ${POINT_COUNT}`,
        "HEIGHT 1",
        "VIEWPOINT 0 0 0 1 0 0 0",
        `POINTS ${POINT_COUNT}`,
        "DATA ascii",
        ...rows,
        "",
      ].join("\n"),
    );
    await convertThroughTheOpenButton(page, pcdPath);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
