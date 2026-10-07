// M4-7: LAZ展開を複数Workerへ分担させるときの、範囲分割とWorker数の決定。
// Web Worker本体(`copc.worker.ts`)から使うが、Worker固有のAPI(`self`・
// `postMessage`等)を一切使わない純粋関数としてここに切り出してあるので、
// 普通のvitestのユニットテスト(`decompress-partition.test.ts`)で確認できる。

/** 1つの展開Workerが担当する点インデックスの範囲(半開区間)。 */
export interface PointRange {
  startIndex: number;
  count: number;
}

/**
 * `totalPoints`個の点を`workerCount`個の範囲にできるだけ均等に分ける
 * (最後の範囲に余りを寄せる)。`workerCount`が1以下、または`totalPoints`が
 * 0以下のときは、範囲1つ(`[0, totalPoints)`、負なら0点)を返す。
 */
export function pointRangesFor(totalPoints: number, workerCount: number): PointRange[] {
  const total = Math.max(0, Math.trunc(totalPoints));
  if (workerCount <= 1 || total === 0) {
    return [{ startIndex: 0, count: total }];
  }
  const base = Math.floor(total / workerCount);
  const ranges: PointRange[] = [];
  let start = 0;
  for (let i = 0; i < workerCount; i++) {
    const isLast = i === workerCount - 1;
    const count = isLast ? total - start : base;
    ranges.push({ startIndex: start, count });
    start += count;
  }
  return ranges;
}

/** 並列化する展開Workerの数を決めるときに参照する環境値。 */
export interface DecompressWorkerCountOptions {
  /** `navigator.hardwareConcurrency`相当。取得できない環境では`undefined`。 */
  hardwareConcurrency: number | undefined;
  /** `src/renderer/device-profile.ts`の`isMobileDevice`が返す判定(M4-11)。
   *  メインスレッドで求めた値を渡す想定(`decompressWorkerCountFor`の
   *  呼び出し元である`copc.worker.ts`のドキュメント参照。Worker内では
   *  `matchMedia`が使えずタッチUIの判定ができないため、ここでは
   *  再判定しない)。 */
  isMobile: boolean;
}

/**
 * 並列化(複数の展開Workerを立てる)を始める点数のしきい値。これ未満は
 * 常に1(直列、`WasmConverter.feed`のバッチループ)を返す。
 *
 * 根拠: ネイティブ版の実測(`TaskSheets/M4-import-and-conversion.md`の
 * M4-7、`crates/pcv-convert/examples/parallel_read_bench.rs`)で、
 * 分担の単位が小さすぎるとスレッド起動のオーバーヘッドが展開本体の時間を
 * 上回り、直列より遅くなる逆転が実際に観測された(バッチサイズ64Ki点、
 * 20コアで直列18.1秒・並列30.2秒)。Web版のWorker起動・`File`の構造化
 * クローンのコストはネイティブのスレッド起動よりさらに重いと見て、
 * 余裕を持った値にしてある。
 */
export const PARALLEL_MIN_POINTS = 500_000;

/**
 * 並列化するときに立てる展開Workerの数の上限。
 *
 * 根拠: `TaskSheets/ADR-0007-pcv-protocol-concurrency.md`の`POOL_SIZE`と
 * 同じ考え方の決め打ち。各Workerは独立したwasmヒープ(メモリ)と起動コストを
 * 持つため、`navigator.hardwareConcurrency`をそのまま無制限に使わず、
 * 妥当な値で頭打ちにする。実機で比率を測り直せていないため、将来実測して
 * 変える余地を残す値として、ここにコメントごと置いてある。
 */
export const MAX_DECOMPRESS_WORKERS = 8;

/**
 * モバイルで立てる展開Workerの数の上限(M4-11、`TaskSheets/
 * M4-import-and-conversion.md`)。**1にした(=追加の展開Workerを1つも
 * 立てず、既存の`feed`逐次バッチループにフォールバックする)。**
 *
 * 根拠(所有者の実機で「準備中のまま止まってタブが落ちる」不具合の調査):
 *
 * - 展開Worker1個につき**独立したwasmモジュールのインスタンス化+ヒープ**
 *   が必要になる(コーディネーターの見立てどおり)。デスクトップ(開発機
 *   20論理コア、RAM 31.8GB)で正しかった判断がモバイル(所有者の実機は
 *   RAM 4GB、`device-profile.ts`の`MOBILE_FALLBACK_DEVICE_MEMORY_GIB`参照)
 *   でも正しいとは限らない
 * - **さらに重要な点(このタスクで`crates/pcv-wasm/src/convert.rs`の
 *   `decompress_point_range`を読んで判明): 各展開Workerは、担当する点
 *   範囲**全体**のシリアライズ済みレコードを`Vec<u8>`として
 *   メモリに貯めてから`postMessage`で返す(`out.with_capacity(to_read *
 *   record_width)`)。** 1点あたり約43〜57バイト(`vendor/copc-writer/
 *   tests/scratch_read_is_bounded.rs`参照)なので、例えば数千万点の
 *   入力を2分割しただけでも1Workerあたり数百MB〜1GB超のバッファになりうる。
 *   これは「Workerの数だけ固定コストがかかる」話ではなく、**Workerの数が
 *   増えるほど1個あたりの負担は減るが、合計のピークは点数にほぼ比例して
 *   残る**ため、モバイルでは追加のWorkerを増やすメリットよりメモリ不足の
 *   リスクの方が大きいと判断した
 * - 「展開用のWorkerを1つも追加で立てない(変換用のWorkerだけで逐次に
 *   展開する)」という選択肢も検討したが、`decompressWorkerCountFor`が
 *   1を返すと呼び出し側(`copc.worker.ts`)は既にその経路(`feed`の
 *   逐次バッチループ、追加Workerを一切起動しない)にフォールバックする
 *   設計になっていたため、値を1にするだけでちょうどその選択肢を選んだ
 *   ことになる(新しい分岐を増やさずに済んだ)
 *
 * **未検証の初期値。** 実機で確かめてもらい、クラッシュしなくなったことを
 * 確認できたら2以上に緩める余地を残す値として、ここにコメントごと置いてある。
 *
 * 2026-10-07追記: 上記の根拠(「各展開Workerが担当範囲**全体**をメモリに
 * 貯めてから返す」こと)自体は、同日の緊急修正でバッチ単位に直した
 * (`DECOMPRESS_BATCH_POINTS`・`BoundedBatchFlow`のドキュメント参照)。
 * そのためこの値を1にする直接の根拠は弱まったが、モバイルでWorkerを増やす
 * ことの妥当性自体を実機で確かめたわけではない(Worker起動のオーバーヘッド・
 * 複数wasmヒープの固定コストなど、点数に比例しない理由は他にも残る)ため、
 * この値は変更していない。緩めるかどうかは、やはり実機確認の後に判断する。
 */
export const MAX_DECOMPRESS_WORKERS_MOBILE = 1;

/**
 * 立てる展開Workerの数を決める。`totalPoints`が`PARALLEL_MIN_POINTS`未満、
 * または`hardwareConcurrency`が不明・1以下なら1(直列)を返す。モバイルでは
 * `MAX_DECOMPRESS_WORKERS_MOBILE`(=1)で頭打ちになる(上記ドキュメント参照。
 * 実質的に追加の展開Workerを一切立てない)。
 */
export function decompressWorkerCountFor(
  totalPoints: number,
  options: DecompressWorkerCountOptions,
): number {
  if (totalPoints < PARALLEL_MIN_POINTS) return 1;
  const available =
    options.hardwareConcurrency !== undefined && options.hardwareConcurrency > 0
      ? options.hardwareConcurrency
      : 1;
  const cap = options.isMobile ? MAX_DECOMPRESS_WORKERS_MOBILE : MAX_DECOMPRESS_WORKERS;
  return Math.max(1, Math.min(available, cap));
}

// --- 2026-10-07の緊急修正: 展開Workerをバッチ単位で駆動する(メモリが点数に比例する不具合の修正) ---
//
// 以前は展開Worker1個が「担当範囲の点を全部シリアライズしてメモリに貯めてから」
// 1回のpostMessageで返す設計だった(`crates/pcv-wasm/src/convert.rs`の旧
// `decompress_laz_range`)。1点あたり約43〜57バイト
// (`vendor/copc-writer/tests/scratch_read_is_bounded.rs`)なので、数千万点の
// 入力を数個のWorkerに分けても、1Workerあたり数百MB〜1GB超のバッファになり
// うる(`MAX_DECOMPRESS_WORKERS_MOBILE`のドキュメント参照)。
//
// 代わりに、展開Workerは`crates/pcv-wasm/src/convert.rs`の
// `LazRangeDecompressor::feed(batchSize)`を使い、小さなバッチ単位で結果を
// 返す(`laz-decompress.worker.ts`)。変換用Worker(`copc.worker.ts`)は
// バッチを受け取るたびに`pushSerializedRecords`へ渡して即座に捨て、
// 「次のバッチをまだ要求してよいか」を`BoundedBatchFlow`で判定する
// (pull型のプロトコル。展開Workerは次のリクエストが来るまで何もしない=
// 待たされる、という形で背圧がかかる)。

/**
 * 1回の`feed`で読む点数。`src/datasource/copc.worker.ts`の
 * `CONVERT_BATCH_SIZE`(変換用Workerの逐次バッチループ、デスクトップ版の
 * `READ_BATCH_SIZE`と同じ桁)と同じ値を使う。この値を選んだ根拠:
 *
 * - 1点あたりの最大バイト数(約57バイト、color+GPS+extra bytesを含む
 *   フォーマット。`vendor/copc-writer/tests/scratch_read_is_bounded.rs`参照)
 *   で見積もると、64Ki点 × 57バイト ≈ 3.65MiBが1バッチの最大サイズになる。
 *   これは点数に関係なく一定(=このタスクの目的そのもの)。
 * - 既存の`CONVERT_BATCH_SIZE`と揃えることで、進捗報告・キャンセルの反応
 *   粒度が今までと同じ桁になる(新しい値を増やさない)。
 */
export const DECOMPRESS_BATCH_POINTS = 64 * 1024;

/**
 * 展開Worker1個につき、変換用Workerが同時に要求してよい(=まだ
 * `pushSerializedRecords`に渡していない)バッチ数の上限。
 *
 * **現在の実装(`copc.worker.ts`の`runWorkerLoop`)は、実際には厳密な
 * lockstepになっている**: 次の`requestBatch`は、前のバッチを`push`して
 * `flow.release`した**後**にしか送らない(先読みはしていない)。そのため
 * 同時に抱えるバッチは実質Worker1個につき常に1個で頭打ちになり、この値を
 * 2にしても実際に2個同時に抱えることはない。
 *
 * それでも2にしてある理由: 将来、現在のバッチを`push`している間に展開
 * Workerへ次の`requestBatch`を先に送る(先読み・パイプライン化)よう変えても、
 * この上限の値自体は変えずに済むようにするため。3以上にしない理由:
 * 上限を増やすほど同時に抱えるバッチのバイト数が増える
 * (`DECOMPRESS_BATCH_POINTS`×この値、Worker数倍)ため、「点数に比例しない」
 * というこの修正の目的を弱める。
 */
export const MAX_IN_FLIGHT_BATCHES_PER_WORKER = 2;

/** `BoundedBatchFlow`の上限設定。 */
export interface BatchFlowLimits {
  /** 同時に抱えてよいバッチ数の上限(要求済みでまだ消費していない件数)。 */
  maxInFlightBatches: number;
  /** 同時に抱えてよい概算バイト数の上限。 */
  maxInFlightBytes: number;
}

/**
 * 展開Workerへの「次のバッチを要求してよいか」を判定する、ブラウザのAPIに
 * 依存しない小さなクラス。`copc.worker.ts`の`runParallelReadPhase`が、
 * 複数の展開Worker(ひいては合計の点数)をまとめて1つのインスタンスで
 * 監視するのに使う。
 *
 * **このクラスが保証すること**: `acquire`で記録した件数・バイト数が
 * `release`で解放されるまで`limits`を超えて増え続けることはない。
 * `canAcquire()`がこれを守るための唯一のゲートで、呼び出し側(本番コードも
 * テストも)は必ず`canAcquire()`を確認してから`acquire()`を呼ぶ規約にする
 * (このクラス自身は`acquire()`を呼ばれたら無条件に加算する。呼び出し側の
 * 誤りを検出するためではなく、単純さを優先した設計)。
 *
 * 総リクエスト数(点数に比例して増える)をいくら増やしても、同時に
 * 抱える量自体は`limits`で頭打ちになることをテストで確認する
 * (`decompress-partition.test.ts`)。
 */
export class BoundedBatchFlow {
  private batches = 0;
  private bytes = 0;

  constructor(private readonly limits: BatchFlowLimits) {}

  /** 次のバッチを要求してよいか(上限に余裕があるか)。 */
  canAcquire(): boolean {
    return this.batches < this.limits.maxInFlightBatches && this.bytes < this.limits.maxInFlightBytes;
  }

  /** バッチを1つ要求した(まだ届いていない)ことを記録する。 */
  acquire(estimatedBytes: number): void {
    this.batches += 1;
    this.bytes += estimatedBytes;
  }

  /**
   * バッチが届いた時点で、要求時の見積もりと実際のバイト数の差を補正する
   * (`estimatedBytes`は`acquire`に渡した値と同じものを渡すこと)。
   */
  adjustBytes(estimatedBytes: number, actualBytes: number): void {
    this.bytes += actualBytes - estimatedBytes;
  }

  /** バッチを使い切って捨てた(`pushSerializedRecords`に渡し終えた)ことを記録する。 */
  release(bytes: number): void {
    this.batches -= 1;
    this.bytes -= bytes;
  }

  /** テスト・デバッグ用: 現在抱えているバッチ数。 */
  get inFlightBatches(): number {
    return this.batches;
  }

  /** テスト・デバッグ用: 現在抱えている概算バイト数。 */
  get inFlightBytes(): number {
    return this.bytes;
  }
}
