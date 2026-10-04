// M4-6b: Web版の変換(生LAS/LAZ→COPC)が使う、OPFS(Origin Private File System)
// まわりのヘルパー。
//
// このファイルは2種類の関数を意図的に分けてある:
//
// 1. 純粋関数(キャッシュのキー・容量の判定)。OPFSにもWorkerにも依存しない、
//    入力から出力が決まるだけの計算なので、vitestで直接テストできる
//    (`opfs.test.ts`)。
// 2. 実際のOPFS I/O(非同期)。ブラウザでしか意味を持たず、vitestの
//    jsdom環境には実体が無い。所有者がブラウザで確かめる手順は
//    `TaskSheets/M4-import-and-conversion.md`のM4-6bに書く。
//
// `FileSystemSyncAccessHandle`(同期の読み書き)を使う関数だけがWorker専用
// (`createSyncAccessHandle`はDedicated Workerの中でしか呼べない。MDN/WHATWG仕様、
// `TaskSheets/M4-import-and-conversion.md`のM4-6a 7節参照)。それ以外(ディレクトリ
// ハンドルの取得・`getFile()`・`createWritable()`・`navigator.storage.estimate()`)は
// メインスレッドからも呼べるので、`web.ts`(メインスレッド)と
// `copc.worker.ts`(Worker)の両方からこのファイルをimportする。

/** ファイルの指紋。名前・サイズ・更新日時の組で「同じファイルか」を判定する
 *  (デスクトップ版`crates/pcv-convert/src/cache.rs`と同じ考え方)。 */
export interface FileFingerprint {
  name: string;
  size: number;
  lastModified: number;
}

/**
 * ADR-0006の実測(sofi: 入力2.03GB→一時ファイルピーク21.864GB、比≈10.77倍)を
 * 根拠に11倍を必要容量の見積もりとする。デスクトップ版
 * (`crates/pcv-convert/src/disk_space.rs`)と同じ係数を使う。
 */
export const SCRATCH_SIZE_FACTOR = 11;

/** 変換に必要な一時領域の見積もり(バイト)。 */
export function requiredScratchBytes(inputSizeBytes: number): number {
  return inputSizeBytes * SCRATCH_SIZE_FACTOR;
}

export interface QuotaEstimate {
  /** そのオリジンに割り当てられている上限(バイト)。 */
  quota: number;
  /** 既に使用中の量(バイト)。 */
  usage: number;
}

/** 空き容量(quota-usage)が、変換に必要な見積り以上あるか。 */
export function hasEnoughQuota(estimate: QuotaEstimate, inputSizeBytes: number): boolean {
  const available = estimate.quota - estimate.usage;
  return available >= requiredScratchBytes(inputSizeBytes);
}

/**
 * ファイルの指紋から、OPFS上のファイル名として安全な(スラッシュ等を含まない)
 * キーを作る。暗号学的な強度は要らない(同じ入力から同じキーが決定的に
 * 出せればよく、衝突耐性はファイル名の一意性を保証する用途には過剰)ため、
 * `crates/pcv-convert/tests/streaming_conversion.rs`のFNV-1aと同じ考え方の
 * 軽量なハッシュを自前で書いた(新しいnpm依存を増やさない)。
 */
export function cacheKeyFor(fingerprint: FileFingerprint): string {
  const raw = `${fingerprint.name}\u0000${fingerprint.size}\u0000${fingerprint.lastModified}`;
  return fnv1a32(raw).toString(16).padStart(8, "0");
}

/** FNV-1a(32bit)。出典: IANAが公開する既知の定数(offset basis/prime)。 */
function fnv1a32(input: string): number {
  const OFFSET_BASIS = 0x811c9dc5;
  const PRIME = 0x01000193;
  let hash = OFFSET_BASIS;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, PRIME);
  }
  return hash >>> 0;
}

/** OPFS上の変換結果の置き場所(サブディレクトリ名)。 */
const CONVERTED_DIR_NAME = "pcv-converted";

/**
 * M4-6bの最初の実装は、一時ファイルの置き場所に固定名`"pcv-scratch"`を
 * 使っていた。**これが実機不具合の原因だった**: 別のタブの変換や、前の版で
 * 「準備中」のまま止まった変換が同じ名前のファイルのハンドルを握っていると、
 * 新しい変換が`createSyncAccessHandle`の時点で
 * 「Access Handles cannot be created if there is another open Access Handle
 * ...」というエラーで失敗し、そのページを開き直すまで直らなかった。
 *
 * 直し方: 変換ごとに一意なディレクトリ名
 * (`${SCRATCH_DIR_PREFIX}<ランダムID>`)を使う(`createScratchPool`参照)。
 * 固定名の方は`LEGACY_SCRATCH_DIR_NAME`として残し、`cleanupStaleScratchDirs`
 * の掃除対象に含める(前の版が作った残骸も消せるようにするため)。
 */
const SCRATCH_DIR_PREFIX = "pcv-scratch-";
const LEGACY_SCRATCH_DIR_NAME = "pcv-scratch";

/** キャッシュの索引(サイドカー)のファイル名。 */
function metaFileNameFor(key: string): string {
  return `${key}.meta.json`;
}

/** OPFS上の変換結果本体のファイル名。 */
export function outputFileNameFor(fingerprint: FileFingerprint): string {
  return `${cacheKeyFor(fingerprint)}.copc.laz`;
}

interface CacheMeta {
  sourceName: string;
  sourceSize: number;
  sourceLastModified: number;
  outputName: string;
}

/** OPFSが使える環境かどうか(Worker専用のcreateSyncAccessHandleではなく、
 *  メインスレッドからも呼べる基本APIの有無で判定する。変換自体は
 *  Worker内でしか行わないが、この判定はメインスレッドから使うため)。 */
export async function isOpfsAvailable(): Promise<boolean> {
  try {
    if (typeof navigator === "undefined" || !navigator.storage?.getDirectory) return false;
    await navigator.storage.getDirectory();
    return true;
  } catch {
    return false;
  }
}

/** `navigator.storage.estimate()`をラップする。`quota`/`usage`が
 *  `undefined`を返す実装があるため0で補う(安全側: 空きが無いと判定されやすくなる)。 */
export async function estimateQuota(): Promise<QuotaEstimate> {
  const estimate = await navigator.storage.estimate();
  return { quota: estimate.quota ?? 0, usage: estimate.usage ?? 0 };
}

async function getConvertedDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(CONVERTED_DIR_NAME, { create: true });
}

/**
 * 変換済みキャッシュを探す。指紋(名前・サイズ・更新日時)が一致するものが
 * あれば、その出力ファイル(`File`)を返す。無い、または指紋が食い違って
 * いれば`null`(呼び出し側は変換をやり直す。安全側に倒す)。
 */
export async function findCachedOutput(fingerprint: FileFingerprint): Promise<File | null> {
  try {
    const dir = await getConvertedDir();
    const key = cacheKeyFor(fingerprint);
    const metaHandle = await dir.getFileHandle(metaFileNameFor(key));
    const metaFile = await metaHandle.getFile();
    const meta = JSON.parse(await metaFile.text()) as CacheMeta;
    if (
      meta.sourceName !== fingerprint.name ||
      meta.sourceSize !== fingerprint.size ||
      meta.sourceLastModified !== fingerprint.lastModified
    ) {
      return null;
    }
    const outputHandle = await dir.getFileHandle(meta.outputName);
    return await outputHandle.getFile();
  } catch {
    // getFileHandle(create未指定)は無ければ例外を投げる。「キャッシュが無い」
    // という正常な状態なので、ここで握りつぶしてnullを返す。
    return null;
  }
}

/** 変換成功後に呼ぶ。キャッシュの索引(サイドカー)を書く。 */
export async function writeCacheMeta(fingerprint: FileFingerprint, outputName: string): Promise<void> {
  const dir = await getConvertedDir();
  const key = cacheKeyFor(fingerprint);
  const handle = await dir.getFileHandle(metaFileNameFor(key), { create: true });
  const writable = await handle.createWritable();
  const meta: CacheMeta = {
    sourceName: fingerprint.name,
    sourceSize: fingerprint.size,
    sourceLastModified: fingerprint.lastModified,
    outputName,
  };
  await writable.write(JSON.stringify(meta));
  await writable.close();
}

/** OPFS上の変換結果を`File`として取り出す(`outputName`は
 *  `outputFileNameFor`が作ったもの)。 */
export async function getConvertedFile(outputName: string): Promise<File | null> {
  try {
    const dir = await getConvertedDir();
    const handle = await dir.getFileHandle(outputName);
    return await handle.getFile();
  } catch {
    return null;
  }
}

/** 失敗・キャンセル時に出力ファイルを消す。 */
export async function removeOutputFile(outputName: string): Promise<void> {
  try {
    const dir = await getConvertedDir();
    await dir.removeEntry(outputName);
  } catch {
    // 既に無い(作られる前に失敗した等)。実害なし。
  }
}

/**
 * `poolSize`個のハンドルを順に作る。**途中で失敗したら、それまでに作った
 * ものを閉じてから投げ直す**(実機不具合の修正: 以前は失敗した`for`ループの
 * 外に結果を返していなかったため、それまでに開いたハンドルが呼び出し元に
 * 届かず、`closeHandles`に渡らずに漏れていた。これが
 * 「Access Handles cannot be created if there is another open Access Handle」
 * というエラーが"一度起きると直らない"原因の一つだった)。
 *
 * OPFSへの依存をこの関数自体からは切り離してある(`createOne`/`closeOne`を
 * 引数で受け取るだけ)ので、ブラウザ無しでテストできる(`opfs.test.ts`)。
 */
export async function openHandlePool<H>(
  poolSize: number,
  createOne: (index: number) => Promise<H>,
  closeOne: (handle: H) => void,
  // M4-11: 準備段階の進捗(何個中何個目か)を画面に出すためのコールバック。
  // `copc.worker.ts`が「一時ファイルを開いています(i/poolSize)」を
  // postMessageするのに使う(省略可能。テストでは通常省略する)。
  onProgress?: (opened: number, total: number) => void,
): Promise<H[]> {
  const handles: H[] = [];
  try {
    for (let i = 0; i < poolSize; i++) {
      handles.push(await createOne(i));
      onProgress?.(i + 1, poolSize);
    }
  } catch (err) {
    for (const handle of handles) {
      try {
        closeOne(handle);
      } catch {
        // 後始末中の失敗は無視して、他のハンドルも閉じ続ける。
      }
    }
    throw err;
  }
  return handles;
}

function randomJobId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // crypto.randomUUIDが無い環境向けの簡易フォールバック(衝突しなければよく、
  // 暗号学的な強度は要らない)。
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

// --- ここから下はWorker専用(FileSystemSyncAccessHandleを使う) ---

/**
 * 一時ファイルのプールを開く。変換ごとに一意なディレクトリ
 * (`${SCRATCH_DIR_PREFIX}<ランダムID>`)を使う(モジュール冒頭のドキュメント
 * 「なぜ一意な名前にしたか」参照)。`poolSize`は`pcv-wasm`の
 * `opfsScratchPoolSize()`(`OPFS_SCRATCH_POOL_SIZE`定数、`crates/pcv-wasm/
 * src/opfs.rs`)と必ず一致させる(理由はそちらのドキュメント参照)。
 *
 * **Dedicated Workerの中でしか呼べない**(`createSyncAccessHandle`がWorker専用のため)。
 */
export async function createScratchPool(
  poolSize: number,
  // M4-11: 「一時ファイルを開いています(i/poolSize)」を画面に出すための
  // 進捗コールバック(省略可能)。
  onProgress?: (opened: number, total: number) => void,
): Promise<{ dirName: string; handles: FileSystemSyncAccessHandle[] }> {
  const root = await navigator.storage.getDirectory();
  const dirName = `${SCRATCH_DIR_PREFIX}${randomJobId()}`;
  const dir = await root.getDirectoryHandle(dirName, { create: true });
  try {
    const handles = await openHandlePool(
      poolSize,
      async (i) => {
        const fileHandle = await dir.getFileHandle(`scratch-${i}`, { create: true });
        return await fileHandle.createSyncAccessHandle();
      },
      (handle) => handle.close(),
      onProgress,
    );
    return { dirName, handles };
  } catch (err) {
    // `openHandlePool`自体は(そこまでに開いた)ハンドルを閉じてから投げ直す
    // (上のドキュメント参照)が、ハンドルを閉じただけではこのディレクトリ
    // 自体(途中まで作ったscratch-*ファイルが残る)は消えない。呼び出し元の
    // `scratchDirName`はこの関数が例外を投げた時点では代入されず
    // (`copc.worker.ts`参照)、次回の`cleanupStaleScratchDirs`任せになって
    // しまうため、ここで自分の作ったディレクトリを自分で消す。
    try {
      await root.removeEntry(dirName, { recursive: true });
    } catch {
      // 後始末の失敗は無視する(次回のcleanupStaleScratchDirsで拾われる)。
    }
    throw err;
  }
}

/** 出力ファイルのハンドルを開く(変換前に1回だけ)。Worker専用(理由は上記)。
 *  1個しか作らないため、`openHandlePool`を経由しない(途中失敗で閉じるべき
 *  「それまでに開いたもの」が無い。`getFileHandle`は成功済みでも
 *  `createSyncAccessHandle`自体が失敗すればハンドルは何も残らない)。 */
export async function createOutputHandle(outputName: string): Promise<FileSystemSyncAccessHandle> {
  const dir = await getConvertedDir();
  const fileHandle = await dir.getFileHandle(outputName, { create: true });
  return await fileHandle.createSyncAccessHandle();
}

/** ハンドルを閉じる。既に閉じているものが混ざっていても後始末全体は続ける
 *  (受け入れ条件「一時ファイルを必ず消す」を、1個の失敗で止めない)。 */
export function closeHandles(handles: readonly FileSystemSyncAccessHandle[]): void {
  for (const handle of handles) {
    try {
      handle.close();
    } catch {
      // 既に閉じられている等。後始末全体は続ける。
    }
  }
}

/** 一時ファイルのディレクトリ(`createScratchPool`が返した`dirName`)を
 *  丸ごと消す。変換の成功・失敗・キャンセルのいずれでも同じ後始末を通す
 *  (受け入れ条件「一時ファイルを必ず消す」)。 */
export async function removeScratchDir(dirName: string): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(dirName, { recursive: true });
  } catch {
    // 一時ファイルを1つも作らずに失敗した等。実害なし。
  }
}

/** 一時ファイルのディレクトリ名として掃除の対象かどうか(純粋関数、
 *  テスト可能)。新しい命名(`${SCRATCH_DIR_PREFIX}...`)と、M4-6bの最初の
 *  実装が使っていた固定名(`LEGACY_SCRATCH_DIR_NAME`)の両方を対象にする。 */
export function isScratchDirName(name: string): boolean {
  return name.startsWith(SCRATCH_DIR_PREFIX) || name === LEGACY_SCRATCH_DIR_NAME;
}

/**
 * 古い一時ファイルのディレクトリを掃除する。タブを閉じる・クラッシュする等で
 * 後始末(`removeScratchDir`)が走らなかった残骸を、次の変換の前に試しに消す。
 * **使用中(他のタブが変換中)のものは`removeEntry`が失敗するので、その失敗は
 * 無視する**(そのタブの変換を妨げない。受け入れ条件どおり)。
 *
 * Web Locks(`withConversionLock`)で保護された区間の中で呼ぶ想定
 * (`copc.worker.ts`参照)。そうすることで、「掃除の最中に別のタブがちょうど
 * 新しいディレクトリを作り始めた直後(まだハンドルを開く前)」という
 * すり抜けの窓を無くしている(ロックを取っている間は他のタブが
 * `createScratchPool`を同時に始められないため)。
 */
export async function cleanupStaleScratchDirs(): Promise<void> {
  const root = await navigator.storage.getDirectory();
  const staleNames: string[] = [];
  for await (const name of root.keys()) {
    if (isScratchDirName(name)) staleNames.push(name);
  }
  for (const name of staleNames) {
    try {
      await root.removeEntry(name, { recursive: true });
    } catch {
      // 他のタブが使用中、等。実害なし。
    }
  }
}

/** 変換を1つに限るためのロック名。 */
export const CONVERSION_LOCK_NAME = "pcv-web-conversion";

/** `navigator.locks`と同じ形のインターフェース。テストで差し替えられるようにする。 */
export interface LockManagerLike {
  request<T>(
    name: string,
    options: { ifAvailable: boolean },
    callback: (lock: unknown) => Promise<T>,
  ): Promise<T>;
}

export type LockOutcome<T> = { kind: "acquired"; result: T } | { kind: "busy" };

/**
 * `callback`を、変換用のロックを持っている間だけ実行する。ロックが
 * 取れなければ(=既に別のタブ/Workerが変換中)`{kind: "busy"}`を返し、
 * `callback`は一切呼ばない。ロックは`callback`が返すPromiseが解決・拒否
 * されるまで持ち続ける(`navigator.locks.request`の仕様どおり。
 * 成功・失敗・キャンセルのいずれでも`callback`内のtry/finallyが終わるまで
 * 持つ、という受け入れ条件はこれで満たされる)。
 *
 * `lockManager`は呼び出し側(`copc.worker.ts`)が`navigator.locks`を渡す。
 * ここでは既定値を持たない(opfs.tsをテストする側がブラウザ外の環境
 * (vitest)でも`navigator.locks`という名前の未定義値に触れないようにするため)。
 */
export async function withConversionLock<T>(
  lockManager: LockManagerLike,
  callback: () => Promise<T>,
): Promise<LockOutcome<T>> {
  return lockManager.request(CONVERSION_LOCK_NAME, { ifAvailable: true }, async (lock) => {
    if (lock === null || lock === undefined) {
      return { kind: "busy" };
    }
    const result = await callback();
    return { kind: "acquired", result };
  });
}