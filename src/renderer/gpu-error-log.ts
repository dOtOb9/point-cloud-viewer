// WebGPUのエラーを画面に出す仕組み（ADR-0011）の中核。
//
// なぜ要るか: EDL(M2-1)の実装で、レンダーパイプラインにdepthStencilを宣言し
// 忘れる不具合があった。WebGPUでは、depthStencilAttachmentを持つレンダーパスの
// 中でdrawするパイプラインは、同じフォーマットのdepthStencilを宣言していないと
// パスと非互換になる。非互換なパイプラインでdrawするとバリデーションエラーに
// なり、コマンドエンコーダ全体が無効化されてそのフレームが丸ごと捨てられる。
// 結果、画面は完全に真っ黒になったが、typecheck/lint/test/build/CIはすべて
// 成功していた（バリデーションエラーはブラウザのWebGPU実装が実行時に出すもので、
// これらのどこにも現れないため）。所有者は「真っ黒」という情報しか得られず、
// 原因の特定に時間がかかった。経緯の全文はTaskSheets/ADR-0011-gpu-error-visibility.mdに、
// 事故そのものの記録はTaskSheets/M2-shading-and-ui.md M2-1「実機不具合: 画面が
// 真っ黒になる」にある。
//
// このファイルはWebGPUに一切依存しない、エラーメッセージの蓄積・重複抑制だけを
// 行う純粋なクラス（規約3: src/renderer/はReactを知らないが、GPUの型にも
// 依存させる必要が無いためここでは意図的に外している。単体テストがGPUDeviceの
// モックを一切必要としないのはこのため）。呼び出し側（point-cloud-renderer.ts）が
// device.onuncapturederror / device.lost / pushErrorScope の結果を文字列に
// してここへ渡し、React側（src/state/useCopcViewer.ts、src/ui/shell/GpuErrorBanner.tsx）が
// 表示を担当する。
//
// M3（TaskSheets/ADR-0013-crash-visibility.md）: `pcv://`のノード読み出しが
// 失敗した（Rust側でpanicが起きた場合を含む）ときも、同じ蓄積・重複抑制の
// 仕組みに乗せることにした。専用の仕組みを別に作ると、連投抑制やバナーの
// 表示要件（本文そのまま・複数保持・閉じられる）を二重に実装することになる
// ため。クラス名・ファイル名は"Gpu"のままにしてある（名前が実態と完全に一致
// しなくなった点は認めるが、(1) 中身はGPUに一切依存しない汎用ロジックで
// 元々そうだったこと、(2) 名前を変えるとpoint-cloud-renderer.ts/
// useCopcViewer.ts/AppShell.tsxなど複数ファイルに影響し、ちょうど並行して
// 別の作業がpoint-cloud-renderer.ts/useCopcViewer.tsを触っていたため変更
// 対象ファイルを増やしたくなかったこと、(3) バナーの表示テキストは`source`で
// 出し分けるため、所有者から見て紛らわしくならないこと、の3点から今回は
// 見送った。`GpuErrorEntry.source`でどちらのエラーかを区別する）。

/** エラーの発生元。バナーの見出し文言を出し分けるために使う。 */
export type GpuErrorSource = "gpu" | "node-read";

/** バナーに表示する1件分のエラー。 */
export interface GpuErrorEntry {
  readonly id: number;
  readonly message: string;
  /** このエラーがWebGPU由来か、`pcv://`のノード読み出し失敗由来か。 */
  readonly source: GpuErrorSource;
  /** 同じメッセージが連続して報告された回数。1件にまとめた合計（連投の抑制）。 */
  readonly count: number;
  /** 最初に報告された時刻（ミリ秒。呼び出し側が渡さなければDate.now()）。 */
  readonly firstAt: number;
  /** 直近に報告された時刻。 */
  readonly lastAt: number;
}

/**
 * WebGPUのエラーメッセージを蓄積するログ。
 *
 * 抑制の方針: 「直前に報告されたエントリと同じメッセージなら、新しいエントリを
 * 作らずcountを増やすだけにする」。毎フレーム同じバリデーションエラーが出続ける
 * ケース（EDLの事故がまさにこれで、壊れたパイプラインでdrawするたびに同じ
 * メッセージが出続ける）でコンソール・バナーが埋まらないようにするための、
 * 一番単純な形の抑制。異なるメッセージ、または間に別のメッセージを挟んだ
 * 同じメッセージは、別エントリとしてそのまま両方保持する（「複数のエラーが
 * 出たときに最初のエラーが見えなくならない」という要件のため。エントリを
 * 上書きしたり自動で消したりはしない。消すのは`dismiss()`を呼んだときだけ）。
 */
export class GpuErrorLog {
  private entries: GpuErrorEntry[] = [];
  private nextId = 1;

  /**
   * エラーメッセージを1件報告する。
   *
   * 直前のエントリ（`entries`の末尾。報告した順で並んでいる）と
   * メッセージ・発生元(`source`)の両方が一致する場合はそのエントリのcountを
   * 増やすだけにする。それ以外（メッセージか発生元が違う、またはまだ1件も
   * 無い）は新しいエントリを末尾に追加する。`source`も比較に含めるのは、
   * たまたま同じ文言のGPUエラーとノード読み出しエラーが連続した場合に、
   * 片方の発生元ラベルの下にもう一方が紛れ込まないようにするため。
   *
   * `now`を省略しても`source`だけ指定したい場合は、`report(message, undefined,
   * "node-read")`のように`now`に`undefined`を明示して渡す（デフォルト引数は
   * `undefined`が渡されたときにも適用される、というJS/TSの通常の挙動）。
   */
  report(message: string, now: number = Date.now(), source: GpuErrorSource = "gpu"): void {
    const last = this.entries[this.entries.length - 1];
    if (last !== undefined && last.message === message && last.source === source) {
      this.entries = this.entries.map((entry) =>
        entry.id === last.id ? { ...entry, count: entry.count + 1, lastAt: now } : entry,
      );
      return;
    }
    this.entries = [
      ...this.entries,
      { id: this.nextId++, message, source, count: 1, firstAt: now, lastAt: now },
    ];
  }

  /** 指定したidのエントリを消す（バナーの「閉じる」操作から呼ぶ）。 */
  dismiss(id: number): void {
    this.entries = this.entries.filter((entry) => entry.id !== id);
  }

  /** 現在保持しているエントリの一覧（報告した順）。 */
  list(): GpuErrorEntry[] {
    return this.entries;
  }
}
