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
