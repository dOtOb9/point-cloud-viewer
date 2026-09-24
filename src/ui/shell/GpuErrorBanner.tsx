import type { GpuErrorEntry } from "../../state/useCopcViewer";

interface Props {
  errors: GpuErrorEntry[];
  onDismiss: (id: number) => void;
}

/** `error.source`ごとの見出し文言。バナーのコンポーネント名・クラス名は
 *  `GpuErrorBanner`/`GpuErrorLog`のまま維持している（理由は
 *  `src/renderer/gpu-error-log.ts`冒頭のコメント参照）が、所有者が画面を見て
 *  「WebGPUの話なのかノード読み出しの話なのか」を区別できるよう、見出しだけは
 *  発生元ごとに出し分ける。 */
const SOURCE_LABEL: Record<GpuErrorEntry["source"], string> = {
  gpu: "WebGPU エラー",
  "node-read": "ノード読み出しエラー",
};

/**
 * エラーを画面に出すバナー。当初はWebGPUのエラー専用だった（ADR-0011）が、
 * M3(ADR-0013)から`pcv://`のノード読み出し失敗（Rust側のpanicから復旧した
 * ものを含む）も同じバナーに表示するようになった。
 *
 * なぜ要るか: EDL(M2-1)の実装で、レンダーパイプラインにdepthStencilを宣言し
 * 忘れる不具合があった。WebGPUのバリデーションエラーはコマンドエンコーダ全体を
 * 無効化し、そのフレームを丸ごと捨てる。結果、所有者の画面は完全に真っ黒に
 * なったが、typecheck/lint/test/build/CIはすべて成功していた（バリデーション
 * エラーはブラウザのWebGPU実装が実行時に出すもので、これらのどこにも現れない
 * ため）。所有者は「真っ黒」という情報しか得られず、原因の特定に時間が
 * かかった。このバナーは、次に同種の不具合が起きたときに所有者がdevtoolsを
 * 開かなくてもエラーメッセージそのものを読めるようにするためのもの
 * （経緯の全文はTaskSheets/ADR-0011-gpu-error-visibility.md）。
 *
 * ノード読み出し失敗も同じ場所に出すことにしたのは、所有者の実機で
 * 「複数ノードを扱うと落ちる」不具合があり、`panic = "abort"`だと原因が
 * 一切残らなかったため（`TaskSheets/ADR-0013-crash-visibility.md`）。
 * Rust側がpanicから復旧して返すメッセージ（panicの内容・ノードキー）も、
 * WebGPUのバリデーションメッセージと同様「本文をそのまま出す」ことが重要
 * という点で要件が同じであり、既存のバナー・連投抑制の仕組みをそのまま
 * 再利用できると判断した。
 *
 * 表示の要件（本文をそのまま出す・複数出ても最初のエラーが隠れない・閉じられる）
 * はすべてこのコンポーネントで満たす。蓄積・重複抑制（同じメッセージの連投を
 * 1件にまとめる）は`src/renderer/gpu-error-log.ts`のGpuErrorLogが担当しており、
 * ここは渡された一覧をそのまま描画するだけ。
 *
 * 意図的にADR-0005のガラス面(GLASS_SURFACE)を使わない。背景が真っ黒なときも
 * 点群の上に出たときも確実に読める必要があるため、不透明な単色背景にする
 * （ぼかし・半透明はどちらも「背景次第で読みにくくなる」リスクを持ち込み、
 * このバナーの存在理由そのものと矛盾する）。通常UIのライト/ダーク追従からも
 * 意図的に外し、エラーであることが一目で分かる警告色（赤系）に固定した。
 */
export function GpuErrorBanner({ errors, onDismiss }: Props) {
  if (errors.length === 0) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-50 flex justify-center p-3">
      {/* 複数出ても最初のエラーが隠れないよう、置き換えずに縦に積む。
          積みすぎて画面からはみ出す場合はこのコンテナ内でスクロールさせる
          （個々のエラーを消すにはonDismissで閉じる操作が必要）。 */}
      <div className="pointer-events-auto flex max-h-[70vh] w-full max-w-2xl flex-col gap-2 overflow-y-auto">
        {errors.map((error) => (
          <div
            key={error.id}
            className="flex items-start gap-3 rounded-lg border border-red-950 bg-red-900 p-3 text-red-50 shadow-xl"
          >
            <div className="min-w-0 flex-1 text-xs">
              <p className="font-semibold">
                {SOURCE_LABEL[error.source]}
                {error.count > 1 ? `（同じエラーが${error.count}回発生）` : ""}
              </p>
              {/* 本文は要約せずそのまま表示する。WebGPUのバリデーションメッセージ・
                  Rust側のpanicメッセージはどちらも具体的で、原因の特定に直接
                  役立つため（タスクシートの必須要件）。 */}
              <p className="mt-1 whitespace-pre-wrap break-words font-mono">{error.message}</p>
            </div>
            <button
              type="button"
              onClick={() => onDismiss(error.id)}
              aria-label="このエラーを閉じる"
              title="このエラーを閉じる"
              className="shrink-0 rounded px-2 py-1 text-xs text-red-50 hover:bg-red-800"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
