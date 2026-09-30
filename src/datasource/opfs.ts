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
/** OPFS上の一時ファイル置き場(サブディレクトリ名)。変換が終わるたびに
 *  丸ごと消す(`removeScratchDir`)。 */
const SCRATCH_DIR_NAME = "pcv-scratch";

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

// --- ここから下はWorker専用(FileSystemSyncAccessHandleを使う) ---

/**
 * 一時ファイルのプールを開く。`poolSize`は`pcv-wasm`の
 * `opfsScratchPoolSize()`(`OPFS_SCRATCH_POOL_SIZE`定数、`crates/pcv-wasm/
 * src/opfs.rs`)と必ず一致させる(理由はそちらのドキュメント参照)。
 *
 * **Dedicated Workerの中でしか呼べない**(`createSyncAccessHandle`がWorker専用のため)。
 */
export async function createScratchPool(poolSize: number): Promise<FileSystemSyncAccessHandle[]> {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle(SCRATCH_DIR_NAME, { create: true });
  const handles: FileSystemSyncAccessHandle[] = [];
  for (let i = 0; i < poolSize; i++) {
    const fileHandle = await dir.getFileHandle(`scratch-${i}`, { create: true });
    handles.push(await fileHandle.createSyncAccessHandle());
  }
  return handles;
}

/** 出力ファイルのハンドルを開く(変換前に1回だけ)。Worker専用(理由は上記)。 */
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

/** 一時ファイルのディレクトリを丸ごと消す。変換の成功・失敗・キャンセルの
 *  いずれでも同じ後始末を通す(受け入れ条件「一時ファイルを必ず消す」)。 */
export async function removeScratchDir(): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(SCRATCH_DIR_NAME, { recursive: true });
  } catch {
    // 一時ファイルを1つも作らずに失敗した等。実害なし。
  }
}