export function UnsupportedDeviceScreen({ reason }: { reason: string }) {
  return (
    <div className="fixed inset-0 flex items-center justify-center bg-slate-950 p-6 text-slate-100">
      <div className="flex w-full max-w-lg flex-col gap-4 rounded-2xl border border-white/10 bg-slate-900 p-6">
        <h1 className="text-lg font-semibold">この端末では点群を表示できません</h1>
        <p className="text-sm opacity-80">
          このアプリの描画にはWebGPUが必須です(WebGL2への切り替えは行っていません)。
          お使いの環境ではWebGPUが利用できませんでした。
        </p>

        <section className="flex flex-col gap-1 rounded-lg bg-black/30 p-3 text-xs">
          <h2 className="font-semibold opacity-70">必要条件</h2>
          <ul className="list-inside list-disc opacity-80">
            <li>Android 12 以上（Windows/macOS/Linuxのデスクトップ版は別条件）</li>
            <li>Qualcomm または ARM 系の対応GPU</li>
            <li>Android System WebView が Chrome 121 相当以上</li>
          </ul>
        </section>

        <section className="flex flex-col gap-1 rounded-lg bg-black/30 p-3 font-mono text-xs">
          <h2 className="font-semibold opacity-70" style={{ fontFamily: "inherit" }}>
            診断情報（問い合わせの際にお伝えください）
          </h2>
          <p className="break-words">reason: {reason}</p>
          <p className="break-words">
            navigator.gpu: {typeof navigator !== "undefined" && "gpu" in navigator ? "あり" : "なし"}
          </p>
          <p className="break-words">
            userAgent: {typeof navigator !== "undefined" ? navigator.userAgent : "(不明)"}
          </p>
        </section>
      </div>
    </div>
  );
}
