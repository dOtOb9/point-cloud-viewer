import { defineConfig, devices } from "@playwright/test";

// E2E(ADR-0016、`TaskSheets/ADR-0016-e2e-web-conversion.md`参照):
// 実際のブラウザでWeb版の変換を1回通し、「テスト・CIが緑でも実際のブラウザでは
// 壊れている」という過去の再発(時刻panic・FileReaderSyncの無バッファ・OPFSの
// ハンドル衝突・内訳とダウンロードが即座に消える、など)を検出できるようにする。
//
// なぜ `GITHUB_PAGES_BUILD=true` で`vite build`してから`vite preview`するか:
// 本番(GitHub Pages)と同じ`base`(サブパス`/point-cloud-viewer/`、
// `vite.config.ts`参照)でビルドしないと、サブパス固有の不具合
// (アセットパスの解決ミスなど)を検出できない。`vite dev`ではなく
// `vite build`→`vite preview`にするのも同じ理由(本番はビルド済みの静的ファイル
// を配信する。devサーバーはモジュールを個別に配信するため経路が違う)。
//
// なぜ`channel: "chromium"`を指定するか(重要、`TaskSheets/ADR-0016-e2e-web-conversion.md`に詳細):
// Playwrightは既定で`headless: true`のとき、軽量な専用バイナリ
// (chrome-headless-shell)を使う。このバイナリは`navigator.gpu.requestAdapter()`が
// 常に`null`を返し、WebGPUをまったく使えない(実機で確認済み)。
// `channel: "chromium"`を指定すると、通常の(フル)Chromiumバイナリを
// headlessモードで使うようになり、こちらはSwiftShader(ソフトウェアの
// Vulkan実装、Chromiumに同梱)で`requestAdapter`が実際にアダプタを返し、
// `<canvas>`への描画まで通ることを確認済み(GPUの実機は不要)。
//
// なぜ`--enable-unsafe-webgpu`も要るか(Windows/Linuxの違い、2026-10-08追記):
// 開発機(Windows)では`channel: "chromium"`だけで追加フラグ無しに動いたが、
// 実際のCI(GitHub Actions、ubuntu-latest)ではそれだけでは
// `requestAdapter()`が`null`を返した(CI run 37792380083で実際に落ちて確認)。
// `scripts/diag-webgpu-headless.mjs`でLinux上のCIから直接複数の起動フラグを
// 試したところ(CI run 37793228559のログ)、`--enable-unsafe-webgpu`**単独**で
// `requestAdapter`→`requestDevice`→`<canvas>`への描画まで通った
// (`--enable-features=Vulkan`・`--use-webgpu-adapter=swiftshader`・
// `--use-angle=swiftshader`等を足した組み合わせも試したが、単独のフラグより
// 構成が増えるだけで効果の差は無かった)。同じ診断スクリプトをWindowsでも
// 走らせ、`--enable-unsafe-webgpu`を足しても結果は変わらない(動いたまま)
// ことを確認済みのため、プラットフォームで分岐せずどちらにも同じ値を渡す
// (`--ignore-gpu-blocklist`と`--use-angle=swiftshader`は、Windowsでは逆に
// `requestAdapter()`が`null`になる組み合わせがあったため採用しなかった。
// `--enable-unsafe-webgpu`単独はWindows・Linux両方で実際に動作を確認できた
// 最小構成)。
//
// もう1つの罠: `navigator.gpu`はセキュアコンテキストでしか存在しない。
// `http://127.0.0.1`(127.0.0.1はブラウザがセキュアコンテキスト扱いする特例)で
// 配信される`vite preview`はこの点で問題ないが、`page.goto("data:...")`のような
// opaque originのページでは`navigator.gpu`自体が無くなる(実機で確認済み)。
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",

  use: {
    baseURL: "http://127.0.0.1:4173/point-cloud-viewer/",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },

  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        channel: "chromium",
        launchOptions: { args: ["--enable-unsafe-webgpu"] },
      },
    },
  ],

  webServer: {
    // ビルド→配信を1コマンドにまとめる(playwrightの`webServer`は1コマンドしか
    // 持たないため)。`&&`はcmd.exe(Windows)・sh(Linux/CIのubuntu-latest)の
    // どちらでも解釈できる。
    // `--host 127.0.0.1`を明示する: ホスト省略時、Viteのpreviewサーバーは
    // IPv6(::1)のみにbindすることがあり(このマシンで実際に確認した。
    // `127.0.0.1`への接続が拒否され、`localhost`表示だけでは気づけなかった)、
    // 下の`url`/`baseURL`(`127.0.0.1`)に接続できずwebServerの起動待ちが
    // タイムアウトする。
    command: "npm run build && npm run preview -- --port 4173 --strictPort --host 127.0.0.1",
    url: "http://127.0.0.1:4173/point-cloud-viewer/",
    env: { GITHUB_PAGES_BUILD: "true" },
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
