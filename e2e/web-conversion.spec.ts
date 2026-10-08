import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { buildSyntheticLas } from "../scripts/make-test-las";

/**
 * Web版の変換を実際のブラウザ(ヘッドレスChromium)で1回通すE2Eテスト。
 *
 * なぜ要るか(`TaskSheets/ADR-0016-e2e-web-conversion.md`に詳細):
 * このプロジェクトでは「テストもCIも緑なのに、実際のブラウザでは壊れている」
 * ことが何度も起きた(wasmでの時刻panic、`FileReaderSync`のバッファ無し、
 * OPFSハンドルの衝突、変換完了直後に内訳とダウンロードが消える、など)。
 * いずれも「Web版の変換を実際のブラウザで1回通せば」見つかっていた不具合。
 *
 * 何を確かめ、何を確かめていないか:
 * - 確かめる: ファイル選択→変換→完了後に「変換の内訳」とダウンロードリンクが
 *   表示され続けること、エラー表示が出ないこと、Consoleにpanic
 *   (`panicked at`)や未処理のエラーが出ないこと、開いたファイルの点数が
 *   0より大きいこと
 * - 確かめていない: デスクトップ(Tauri)版、Android版、実GPU(ヘッドレス
 *   ChromiumのSwiftShaderソフトウェアレンダラのみ)、Safari/Firefox
 */

test("LASファイルを選ぶとWeb版で変換され、内訳とダウンロードが表示される", async ({ page }) => {
  // 受け入れ条件: Consoleにpanicや未処理のエラーが出ないこと。
  const consoleMessages: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (msg) => consoleMessages.push(msg.text()));
  page.on("pageerror", (err) => pageErrors.push(String(err)));

  // テスト用のLASはテストのたびにこのスクリプトで作る(コミットしない。
  // `CLAUDE.md`「守ること」参照)。色・強度付き、数百〜数千点
  // (`TaskSheets/TEST-DATA.md`の「テスト内で生成」と同じ規模)。
  const tmpDir = mkdtempSync(join(tmpdir(), "pcv-e2e-"));
  const lasPath = join(tmpDir, "synthetic.las");
  writeFileSync(lasPath, buildSyntheticLas({ pointCount: 2000, seed: 7 }));

  try {
    // baseURLは本番(GitHub Pages)と同じサブパス(`/point-cloud-viewer/`)。
    // "./"で相対解決し、サブパスを維持する("/"だとドメインルートへ戻ってしまう)。
    await page.goto("./");

    // WebGPUが使えない環境では、アプリ全体が「この端末では表示できません」の
    // 画面に置き換わり、ファイル選択自体が出ない
    // (`src/ui/shell/AppShell.tsx`のゲート)。ここで失敗すれば、CI環境が
    // WebGPUを使えていないことがすぐ分かる(`playwright.config.ts`の
    // `channel: "chromium"`のコメント参照)。
    const fileInput = page.getByTestId("file-input");
    await expect(fileInput).toBeAttached({ timeout: 30_000 });

    await fileInput.setInputFiles(lasPath);

    // 完了を待つ: 固定の待ち時間ではなく、「変換の内訳」パネルが実際に
    // 表示されるまで待つ(画面の状態で待つ。タスクの要求)。wasmの初期化
    // (ダウンロード・インスタンス化)を含めた余裕としてタイムアウトを長めに取る。
    const breakdown = page.getByTestId("conversion-breakdown");
    await expect(breakdown).toBeVisible({ timeout: 45_000 });

    // 別のエージェントが直している不具合(内訳とダウンロードのリンクが
    // 変換完了後すぐに消える、`src/state/useCopcViewer.ts`)。ここで少し待って
    // からもまだ表示されていることを確かめる(「表示された瞬間」だけでなく
    // 「表示され続けている」ことを見る。このテストがその不具合を実際に
    // 捕まえられるようにするための待機)。
    await page.waitForTimeout(2000);
    await expect(breakdown).toBeVisible();

    const downloadLink = page.getByTestId("download-link");
    await expect(downloadLink).toBeVisible();

    // エラー表示が出ていないこと。
    await expect(page.getByTestId("viewer-error")).toHaveCount(0);

    // Consoleにpanicが出ていないこと(`CLAUDE.md`「テストとCIが緑でも動くとは
    // 限らない」の実例そのもの。wasmでの時刻panicが過去に実際にこの形で
    // 起きた)。
    const panicked = consoleMessages.filter((m) => m.includes("panicked at"));
    expect(panicked, `Consoleにpanicが出た:\n${panicked.join("\n")}`).toHaveLength(0);
    expect(pageErrors, `ページで未処理のエラーが発生した:\n${pageErrors.join("\n")}`).toHaveLength(0);

    // 可能なら、変換した点群のノードが実際に読み込まれたことも確かめる
    // (`src/state/useCopcViewer.ts`の`openFile`が開いた直後に出す
    // `[M1] opened ...: points=N nodes=M`のconsole.logを使う)。
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
