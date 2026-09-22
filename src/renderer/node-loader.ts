// M1-4: 優先度順にノードをキューイングし、同時リクエスト数を絞って非同期ロードする。
// カメラが動いたら `setWanted` で欲しいノードの集合を丸ごと入れ替える。

import type { DataSource } from "../datasource/DataSource";
import { parseNodeBuffer, type ParsedNode } from "../datasource/node-format";

export interface NodeLoadRequest {
  key: string;
  /** 大きいほど優先。M1-4のscreen-space-errorをそのまま渡す想定。 */
  priority: number;
}

/**
 * 同時に投げるノード取得リクエストの数。
 *
 * 当初は固定値 4 だった（M1-4 で「同時リクエスト数を絞る（4本程度）」と決めた）。
 * しかし `ADR-0007-pcv-protocol-concurrency.md` の実測は、4 では足りないことを
 * 示している（sofi.copc.laz: 並行数4 で 52.7 nodes/s、並行数8 で 88.0 nodes/s。
 * 8 でもまだ頭打ちになっていない）。
 *
 * さらに、Rust 側のリーダープール（`src-tauri/src/copc_state.rs` の `CopcPool`）は
 * 8 本用意されていたため、**フロントが 4 本しか投げないせいでプールの半分が
 * 使われていなかった**。所有者から「点群が精細になるのに時間がかかるが CPU を
 * 使えていないように見える」という報告があり、これがその実体である。
 *
 * そこで端末の論理コア数から決める形にした（`ADR-0009-adaptive-render-settings.md`:
 * 静的な端末情報は初期値と上限を決めるために使う）。開発機は 20 コア、
 * M3 の対象端末 OPPO Pad Air は 8 コアで、固定値では両方に合わない。
 *
 * # 上限を設けない理由
 *
 * 一度 `Math.min(cores, 16)` という上限を置いたが、根拠が無いうえに**同じ無駄を
 * 小さく再現していた**ので外した。Rust 側のプールは
 * `std::thread::available_parallelism()`（この開発機で 20、上限なし）で作られるため、
 * フロントを 16 に切るとプールが 4 本遊ぶ。「4 本しか投げないのでプール 8 本の半分が
 * 遊んでいた」という、いま直したばかりの問題と同じ構造である。
 *
 * **投げすぎても害は無い。** プールが本当の上限で、超えた分は `Condvar` で
 * 次の返却を待つだけである（`src-tauri/src/copc_state.rs` の `CopcPool`）。
 * したがってフロント側とプール側は同じ値に揃えるのが素直で、
 * どちらも端末の論理コア数から決める。
 *
 * # 論理コア数と同じでよいと確認した（`ADR-0007`追記）
 *
 * 上記の「8 を超える範囲は未実測」は解消した。ただし別の発見があったので経緯を残す。
 *
 * `crates/pcv-core/examples/parallel_bench.rs`（webview も IPC も通さない、Rust単体の
 * 上限を測るベンチ）で並行数を上げても**8スレッドで頭打ち**になることが分かった
 * （1コアあたりの効率が0.79xから0.40xへ急落）。これは「フロントの同時リクエスト数」や
 * 「Rustプールのサイズ」の問題ではなく、**`pcv-core`の`read_node`1回のコストそのもの**
 * （1ノードあたり単スレッド約88ms）が原因だった。ノード1つを読むのに、そのレベル全体への
 * 空間クエリを投げて大半を捨てる実装になっていた。詳細は`ADR-0007`追記と
 * `crates/pcv-core/src/copc.rs`を参照。
 *
 * これを直した後（COPCのhierarchy entryが持つoffset/byte_sizeへ直接seekする方式に
 * 変更）、同じベンチで測り直すと、1ノードあたりの時間が約10分の1（約8.7ms）になり、
 * **8スレッドの頭打ちが消え、論理コア数（20）まで素直にスループットが伸びる**ことを
 * 確認した（1→114.6、4→428.7、8→694.5、16→964.7、20→1123.6 nodes/s）。さらに
 * 論理コア数を超えて24〜40スレッドまで振っても、24でわずかに伸びた後32・40では
 * 頭打ちになった（1030〜1150 nodes/s の範囲で横ばい）。つまり**論理コア数が
 * 「これ以上増やしても本質的には伸びない」境目にほぼ一致する**ことを実測で確認できた。
 *
 * したがって、フロントの同時リクエスト数とRustプールサイズをどちらも論理コア数から
 * 決める、という既存の方針（値自体は変えていない）は、**この直しの後で実測に基づく
 * ものになった**。直す前は「頭打ちが8スレッドだった」ため、この方針そのものが
 * 妥当かどうか怪しかった（コア数まで増やしても、ノード読み出しコストのせいで
 * どうせ8で頭打ちになっていた可能性がある）。
 */
function defaultMaxConcurrent(): number {
  const cores = typeof navigator !== "undefined" ? navigator.hardwareConcurrency : undefined;
  // 取れない環境では、実測で裏付けのある 8 を使う（ADR-0007）。
  if (!cores || !Number.isFinite(cores)) return 8;
  // 下限 4 は、コア数を極端に少なく申告する環境で直列化しないための保険。
  return Math.max(4, cores);
}

const DEFAULT_MAX_CONCURRENT = defaultMaxConcurrent();

export class NodeLoader {
  private readonly dataSource: DataSource;
  private readonly onLoaded: (key: string, node: ParsedNode) => void;
  private readonly onFailed: (key: string, error: unknown) => void;
  private readonly maxConcurrent: number;

  /** まだ取得を開始していない、欲しいノード。 */
  private pending = new Map<string, number>();
  /** 取得中のノードキー。 */
  private inFlight = new Set<string>();

  constructor(
    dataSource: DataSource,
    onLoaded: (key: string, node: ParsedNode) => void,
    onFailed: (key: string, error: unknown) => void,
    maxConcurrent = DEFAULT_MAX_CONCURRENT,
  ) {
    this.dataSource = dataSource;
    this.onLoaded = onLoaded;
    this.onFailed = onFailed;
    this.maxConcurrent = maxConcurrent;
  }

  get loadingCount(): number {
    return this.inFlight.size;
  }

  get queuedCount(): number {
    return this.pending.size;
  }

  /**
   * 今欲しいノードの集合を丸ごと入れ替える。既にキャッシュ済み・取得中のものは
   * 呼び出し側で除いてから渡すこと（`isAlreadyAvailable`で除外する）。
   */
  setWanted(requests: NodeLoadRequest[], isAlreadyAvailable: (key: string) => boolean): void {
    this.pending.clear();
    for (const request of requests) {
      if (this.inFlight.has(request.key) || isAlreadyAvailable(request.key)) continue;
      this.pending.set(request.key, request.priority);
    }
    this.pump();
  }

  dispose(): void {
    this.pending.clear();
    // 取得中のPromise自体は止められない（fetchのAbortControllerまでは今回は導入しない）。
    // 完了時のコールバックは呼ばれるが、呼び出し側（renderer）が破棄済みなら無視すればよい。
  }

  private pump(): void {
    while (this.inFlight.size < this.maxConcurrent && this.pending.size > 0) {
      const nextKey = this.pickHighestPriority();
      if (nextKey === null) break;
      this.pending.delete(nextKey);
      this.startLoad(nextKey);
    }
  }

  private pickHighestPriority(): string | null {
    let bestKey: string | null = null;
    let bestPriority = -Infinity;
    for (const [key, priority] of this.pending) {
      if (priority > bestPriority) {
        bestPriority = priority;
        bestKey = key;
      }
    }
    return bestKey;
  }

  private startLoad(key: string): void {
    this.inFlight.add(key);
    this.dataSource
      .readNode(key)
      .then((buffer) => {
        const parsed = parseNodeBuffer(buffer);
        this.onLoaded(key, parsed);
      })
      .catch((error: unknown) => {
        this.onFailed(key, error);
      })
      .finally(() => {
        this.inFlight.delete(key);
        this.pump();
      });
  }
}
