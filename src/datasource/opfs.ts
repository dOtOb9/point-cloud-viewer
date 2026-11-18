export interface FileFingerprint {
  name: string;
  size: number;
  lastModified: number;
}

export const SCRATCH_SIZE_FACTOR = 11;

export function requiredScratchBytes(inputSizeBytes: number): number {
  return inputSizeBytes * SCRATCH_SIZE_FACTOR;
}

export const SCRATCH_BYTES_PER_POINT = 60;

export const OUTPUT_BYTES_PER_POINT = 10;

export function requiredBytesForPointCount(pointCount: number): number {
  return pointCount * (SCRATCH_BYTES_PER_POINT + OUTPUT_BYTES_PER_POINT);
}

export interface QuotaEstimate {
  quota: number;
  usage: number;
}

export function hasEnoughQuota(estimate: QuotaEstimate, requiredBytes: number): boolean {
  const available = estimate.quota - estimate.usage;
  return available >= requiredBytes;
}

export function toGiBLabel(bytes: number): string {
  return `約${(bytes / 1024 ** 3).toFixed(1)}GiB`;
}

export interface PersistableStorageLike {
  persist(): Promise<boolean>;
  persisted(): Promise<boolean>;
}

export interface PersistenceOutcome {
  alreadyPersisted: boolean;
  grantedNow: boolean;
  persisted: boolean;
}

export async function ensurePersistentStorage(storage: PersistableStorageLike): Promise<PersistenceOutcome> {
  const already = await storage.persisted();
  if (already) {
    return { alreadyPersisted: true, grantedNow: false, persisted: true };
  }
  const granted = await storage.persist();
  return { alreadyPersisted: false, grantedNow: granted, persisted: granted };
}

export interface InsufficientSpaceWebDetails {
  requiredBytes: number;
  quotaBytes: number;
  usageBytes: number;
  persisted: boolean;
  reclaimableBytes: number;
}

export function describeInsufficientSpaceWeb(details: InsufficientSpaceWebDetails): string {
  const availableBytes = Math.max(0, details.quotaBytes - details.usageBytes);
  const summary =
    `空き容量が足りません(必要: ${toGiBLabel(details.requiredBytes)}／空き: ${toGiBLabel(availableBytes)}` +
    `(上限 ${toGiBLabel(details.quotaBytes)}、使用中 ${toGiBLabel(details.usageBytes)}))。`;

  const actions: string[] = [];
  if (details.reclaimableBytes > 0) {
    actions.push(
      `設定の「ブラウザの保存領域」から変換済みキャッシュ・残っている一時ファイル` +
        `(${toGiBLabel(details.reclaimableBytes)})を消す`,
    );
  }
  if (!details.persisted) {
    actions.push("設定から永続的な保存を許可する");
  }
  actions.push("デスクトップ版でCOPC(.copc.laz)に変換してから開く");

  const privateNote = details.persisted
    ? ""
    : " 永続的な保存が許可されていません。シークレットウィンドウでは保存領域が小さく、大きな点群を変換できないことがあります。";

  return `${summary} 空けるには、${actions.join("、")}、のいずれかを試してください。${privateNote}`;
}

export function cacheKeyFor(fingerprint: FileFingerprint): string {
  const raw = `${fingerprint.name}\u0000${fingerprint.size}\u0000${fingerprint.lastModified}`;
  return fnv1a32(raw).toString(16).padStart(8, "0");
}

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

export function cacheKeyForMulti(fingerprints: FileFingerprint[]): string {
  const sorted = [...fingerprints].sort((a, b) => {
    if (a.name !== b.name) return a.name < b.name ? -1 : 1;
    if (a.size !== b.size) return a.size - b.size;
    return a.lastModified - b.lastModified;
  });
  const raw = sorted
    .map((f) => `${f.name}\u0000${f.size}\u0000${f.lastModified}`)
    .join("\u0001");
  return fnv1a32(raw).toString(16).padStart(8, "0");
}

const CONVERTED_DIR_NAME = "pcv-converted";

const SCRATCH_DIR_PREFIX = "pcv-scratch-";
const LEGACY_SCRATCH_DIR_NAME = "pcv-scratch";

function metaFileNameFor(key: string): string {
  return `${key}.meta.json`;
}

export function outputFileNameFor(fingerprint: FileFingerprint): string {
  return `${cacheKeyFor(fingerprint)}.copc.laz`;
}

export function outputFileNameForMulti(fingerprints: FileFingerprint[]): string {
  return `${cacheKeyForMulti(fingerprints)}.copc.laz`;
}

export function multiDisplayNameFor(sortedNames: string[]): string {
  if (sortedNames.length === 0) return "";
  const first = sortedNames[0].replace(/\.(las|laz|pcd|ply|e57)$/i, "");
  const rest = sortedNames.length - 1;
  return rest === 0 ? sortedNames[0] : `${first} ほか${rest}ファイル`;
}

interface CacheMeta {
  sourceName: string;
  sourceSize: number;
  sourceLastModified: number;
  outputName: string;
}

interface MultiCacheMeta {
  sources: FileFingerprint[];
  outputName: string;
}

function sortedFingerprints(fingerprints: FileFingerprint[]): FileFingerprint[] {
  return [...fingerprints].sort((a, b) => {
    if (a.name !== b.name) return a.name < b.name ? -1 : 1;
    if (a.size !== b.size) return a.size - b.size;
    return a.lastModified - b.lastModified;
  });
}

function fingerprintsEqual(a: FileFingerprint[], b: FileFingerprint[]): boolean {
  if (a.length !== b.length) return false;
  return a.every(
    (f, i) => f.name === b[i].name && f.size === b[i].size && f.lastModified === b[i].lastModified,
  );
}

export async function isOpfsAvailable(): Promise<boolean> {
  try {
    if (typeof navigator === "undefined" || !navigator.storage?.getDirectory) return false;
    await navigator.storage.getDirectory();
    return true;
  } catch {
    return false;
  }
}

export async function estimateQuota(): Promise<QuotaEstimate> {
  const estimate = await navigator.storage.estimate();
  return { quota: estimate.quota ?? 0, usage: estimate.usage ?? 0 };
}

export async function isPersisted(): Promise<boolean> {
  return navigator.storage.persisted();
}

async function getConvertedDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(CONVERTED_DIR_NAME, { create: true });
}

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
    return null;
  }
}

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

export async function findCachedMultiOutput(fingerprints: FileFingerprint[]): Promise<File | null> {
  try {
    const dir = await getConvertedDir();
    const key = cacheKeyForMulti(fingerprints);
    const metaHandle = await dir.getFileHandle(metaFileNameFor(key));
    const metaFile = await metaHandle.getFile();
    const meta = JSON.parse(await metaFile.text()) as MultiCacheMeta;
    if (!fingerprintsEqual(sortedFingerprints(fingerprints), meta.sources)) {
      return null;
    }
    const outputHandle = await dir.getFileHandle(meta.outputName);
    return await outputHandle.getFile();
  } catch {
    return null;
  }
}

export async function writeMultiCacheMeta(
  fingerprints: FileFingerprint[],
  outputName: string,
): Promise<void> {
  const dir = await getConvertedDir();
  const key = cacheKeyForMulti(fingerprints);
  const handle = await dir.getFileHandle(metaFileNameFor(key), { create: true });
  const writable = await handle.createWritable();
  const meta: MultiCacheMeta = {
    sources: sortedFingerprints(fingerprints),
    outputName,
  };
  await writable.write(JSON.stringify(meta));
  await writable.close();
}

export async function getConvertedFile(outputName: string): Promise<File | null> {
  try {
    const dir = await getConvertedDir();
    const handle = await dir.getFileHandle(outputName);
    return await handle.getFile();
  } catch {
    return null;
  }
}

async function attempt(action: () => Promise<unknown>): Promise<boolean> {
  try {
    await action();
    return true;
  } catch {
    return false;
  }
}

function attemptSync(action: () => void): boolean {
  try {
    action();
    return true;
  } catch {
    return false;
  }
}

export async function removeOutputFile(outputName: string): Promise<void> {
  await attempt(async () => {
    const dir = await getConvertedDir();
    await dir.removeEntry(outputName);
  });
}

export interface CachedConversionEntry {
  outputName: string;
  metaFileName: string;
  sourceName: string;
  sizeBytes: number;
}

export interface StaleScratchDirEntry {
  name: string;
  sizeBytes: number;
}

export interface OpfsUsageBreakdown {
  cachedConversions: CachedConversionEntry[];
  cachedConversionsTotalBytes: number;
  staleScratchDirs: StaleScratchDirEntry[];
  staleScratchTotalBytes: number;
}

async function dirTotalBytes(dir: FileSystemDirectoryHandle): Promise<number> {
  let total = 0;
  for await (const [, handle] of dir.entries()) {
    if (handle.kind === "file") {
      total += (await handle.getFile()).size;
    } else {
      total += await dirTotalBytes(handle);
    }
  }
  return total;
}

async function readCachedConversionEntry(
  dir: FileSystemDirectoryHandle,
  metaFileName: string,
  metaHandle: FileSystemFileHandle,
): Promise<CachedConversionEntry> {
  const metaFile = await metaHandle.getFile();
  const meta = JSON.parse(await metaFile.text()) as CacheMeta | MultiCacheMeta;
  const outputFile = await (await dir.getFileHandle(meta.outputName)).getFile();
  const sourceName =
    "sources" in meta
      ? multiDisplayNameFor(meta.sources.map((f) => f.name))
      : meta.sourceName;
  return {
    outputName: meta.outputName,
    metaFileName,
    sourceName,
    sizeBytes: metaFile.size + outputFile.size,
  };
}

async function collectReadableCachedConversions(into: CachedConversionEntry[]): Promise<void> {
  const dir = await getConvertedDir();
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind !== "file" || !name.endsWith(".meta.json")) continue;
    await attempt(async () => into.push(await readCachedConversionEntry(dir, name, handle)));
  }
}

const SIZE_OF_A_DIR_IN_USE_BY_ANOTHER_TAB = 0;

export async function getOpfsUsageBreakdown(): Promise<OpfsUsageBreakdown> {
  const root = await navigator.storage.getDirectory();

  const cachedConversions: CachedConversionEntry[] = [];
  await attempt(() => collectReadableCachedConversions(cachedConversions));

  const staleScratchDirs: StaleScratchDirEntry[] = [];
  for await (const [name, handle] of root.entries()) {
    if (handle.kind !== "directory" || !isScratchDirName(name)) continue;
    const sizeBytes = await dirTotalBytes(handle).catch(() => SIZE_OF_A_DIR_IN_USE_BY_ANOTHER_TAB);
    staleScratchDirs.push({ name, sizeBytes });
  }

  return {
    cachedConversions,
    cachedConversionsTotalBytes: cachedConversions.reduce((sum, e) => sum + e.sizeBytes, 0),
    staleScratchDirs,
    staleScratchTotalBytes: staleScratchDirs.reduce((sum, e) => sum + e.sizeBytes, 0),
  };
}

export async function removeCachedConversionEntry(
  entry: Pick<CachedConversionEntry, "metaFileName" | "outputName">,
): Promise<void> {
  const dir = await getConvertedDir();
  for (const name of [entry.metaFileName, entry.outputName]) {
    await attempt(() => dir.removeEntry(name));
  }
}

export async function clearAllCachedConversions(): Promise<void> {
  const dir = await getConvertedDir();
  const names: string[] = [];
  for await (const name of dir.keys()) names.push(name);
  for (const name of names) {
    await attempt(() => dir.removeEntry(name));
  }
}

export async function openHandlePool<H>(
  poolSize: number,
  createOne: (index: number) => Promise<H>,
  closeOne: (handle: H) => void,
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
      attemptSync(() => closeOne(handle));
    }
    throw err;
  }
  return handles;
}

function randomJobId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export async function createScratchPool(
  poolSize: number,
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
    await attempt(() => root.removeEntry(dirName, { recursive: true }));
    throw err;
  }
}

export async function createOutputHandle(outputName: string): Promise<FileSystemSyncAccessHandle> {
  const dir = await getConvertedDir();
  const fileHandle = await dir.getFileHandle(outputName, { create: true });
  return await fileHandle.createSyncAccessHandle();
}

export function closeHandles(handles: readonly FileSystemSyncAccessHandle[]): void {
  for (const handle of handles) {
    attemptSync(() => handle.close());
  }
}

export async function removeScratchDir(dirName: string): Promise<void> {
  await attempt(async () => {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(dirName, { recursive: true });
  });
}

export function isScratchDirName(name: string): boolean {
  return name.startsWith(SCRATCH_DIR_PREFIX) || name === LEGACY_SCRATCH_DIR_NAME;
}

export async function removeScratchDirByName(name: string): Promise<void> {
  if (!isScratchDirName(name)) return;
  const root = await navigator.storage.getDirectory();
  await attempt(() => root.removeEntry(name, { recursive: true }));
}

export async function cleanupStaleScratchDirs(): Promise<void> {
  const root = await navigator.storage.getDirectory();
  const staleNames: string[] = [];
  for await (const name of root.keys()) {
    if (isScratchDirName(name)) staleNames.push(name);
  }
  for (const name of staleNames) {
    await attempt(() => root.removeEntry(name, { recursive: true }));
  }
}

export async function cleanupStaleScratchDirsWithoutStoppingTheJob(): Promise<void> {
  await attempt(cleanupStaleScratchDirs);
}

export const CONVERSION_LOCK_NAME = "pcv-web-conversion";

export interface LockManagerLike {
  request<T>(
    name: string,
    options: { ifAvailable: boolean },
    callback: (lock: unknown) => Promise<T>,
  ): Promise<T>;
}

export type LockOutcome<T> = { kind: "acquired"; result: T } | { kind: "busy" };

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

export function toolOutputName(): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `tool-${Date.now().toString(36)}-${random}.copc.laz`;
}

export async function writeToolOutputMeta(outputName: string, label: string): Promise<void> {
  const dir = await getConvertedDir();
  const key = outputName.replace(/\.copc\.laz$/, "");
  const handle = await dir.getFileHandle(metaFileNameFor(key), { create: true });
  const writable = await handle.createWritable();
  const meta: CacheMeta = {
    sourceName: label,
    sourceSize: 0,
    sourceLastModified: 0,
    outputName,
  };
  await writable.write(JSON.stringify(meta));
  await writable.close();
}
