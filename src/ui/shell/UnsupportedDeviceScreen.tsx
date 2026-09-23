/**
 * M3-5: WebGPUが使えない端末で、白画面のまま放置せず「未対応」と明示する画面。
 *
 * ADR-0002でWebGL2フォールバックを書かないと決めたため、WebGPUが取れない環境では
 * 本当に何も描画できない。何も出さなければ「壊れている」と区別が付かないので、
 * 必要条件と診断情報(M0-2のプローブが返す`reason`、加えて問い合わせに使えるよう
 * userAgent等)をここに出す。ADR-0004が挙げた条件(Chrome 121+ / Android 12以上 /
 * Qualcomm・ARM GPU)は、この画面の中でのみ言及する静的な文言でよい
 * (実機で満たすかどうかの確定はM3-7、実機作業)。
 */
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
