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
 * M4-9追記(`TaskSheets/M4-import-and-conversion.md`): ファイルサイズからの
 * 見積もり。**点数が分かる場合は使わず、`requiredBytesForPointCount`を使う
 * こと。** この係数(ADR-0006の実測、sofi: 入力2.03GB→一時ファイルピーク
 * 21.864GB、比≈10.77倍)は**LAZ(圧縮)の実測**から来ており、非圧縮・f64の
 * PCD等では大きく外れる(実機不具合の原因。所有者がPCD(sofi.pcd、9.47GB)を
 * Web版で開こうとしたとき、9.47GB×11≈104GBという誤った見積もりで「空き容量
 * 不足」と判定された)。点数が読み取れない(ヘッダーが壊れている等)場合の
 * フォールバックとしてのみ残す。デスクトップ版(`crates/pcv-convert/src/
 * disk_space.rs`)と同じ係数を使う。
 */
export const SCRATCH_SIZE_FACTOR = 11;

/** 変換に必要な一時領域の見積もり(バイト、ファイルサイズから。上記の
 *  ドキュメント参照)。 */
export function requiredScratchBytes(inputSizeBytes: number): number {
  return inputSizeBytes * SCRATCH_SIZE_FACTOR;
}

/**
 * M4-9追記: 1点あたりの一時領域(OPFSスクラッチ)の見積もり(バイト)。
 * ADR-0006/M4-1bの実測(一時ファイルのピーク÷点数): beer.laz 49.31〜59.06
 * B/点、sofi.copc.laz 51.06〜60.00 B/点(計測方法によって2系統の値が
 * 記録されている。`TaskSheets/M4-import-and-conversion.md`のM4-1b参照)。
 * 安全側に、記録されている中で最大の値(60)を採用する。
 */
export const SCRATCH_BYTES_PER_POINT = 60;

/**
 * M4-9追記、M4-6追記で根拠を修正: 1点あたりの出力COPCサイズの見積もり
 * (バイト)。
 *
 * **このコメントの旧版は根拠が誤っていた。** 旧版は「beer.laz 7.48 B/点、
 * sofi.copc.laz 9.07 B/点」と書いていたが、7.48はM4-1の**素朴な実装**
 * (全点メモリ、M4-2で`copc-writer`採用により不採用になった実装)の出力
 * (500.04MB/66,848,096点)から来ており、9.07はM4-1bの**`copc-writer`**の出力
 * (3,305.84MB/364,384,576点)から来ていた。**実装の異なる2つの数値を
 * 同じ「1点あたりのバイト数」として並べていた**(現在の実装は`copc-writer`
 * 系列のみで、素朴な実装の値を使う理由が無い)。
 *
 * 本セッションで、M4-1bのスパイクが残していた実際の出力ファイル
 * (`data/beer.copc.laz`、606,308,379バイト。M4-1bの表の「606.31MB」と一致)を
 * 使って、beer.lazも`copc-writer`側の値で再計算した:
 *
 * - beer.laz: 606,308,379 B ÷ 66,848,096点 = **9.0699 B/点**
 *   (`node`で`fs.statSync`のバイト数とLASヘッダー実測点数から算出。
 *   コマンドと結果は`TaskSheets/M4-import-and-conversion.md`のM4-6追記5参照)
 * - sofi.copc.laz: 3,305.84×10^6 B ÷ 364,384,576点 = **9.0724 B/点**
 *   (M4-1bが記録した出力サイズのMB表記から再計算。バイト単位の生値は
 *   タスクシートに残っていないため、これは記載値からの再計算であり
 *   新規の実測ではない)
 *
 * **2点とも`copc-writer`ベースでは9.07 B/点前後に一致する**(旧版が示唆していた
 * 「7.48〜9.07の範囲がある」という形は誤りで、実際は1点に近い値に収束する)。
 * 安全側に切り上げて10とする(これは変えていない。旧版の根拠が誤っていても、
 * 切り上げ先の10という値自体は結果的に変わらない)。
 *
 * Web版(OPFS)の出力もこの値をそのまま使っている。M4-6aで、Web/OPFS用に
 * 改修した`ScratchFs`経由の出力がネイティブ版とSHA-256で完全一致することを
 * 確認済み(`TaskSheets/M4-import-and-conversion.md`のM4-6a 4節)なので、
 * ネイティブで実測したこの値はWeb版にもそのまま転用できる(未検証:
 * M4-7/M4-8/M4-10の後処理の高速化がLAZ圧縮の圧縮率自体を変えていないこと。
 * これらは並列化・バッチ化が目的で圧縮アルゴリズムは変えていないはずだが、
 * 実際にbeer.laz等を再変換して出力バイト数を比較する再検証はしていない)。
 */
export const OUTPUT_BYTES_PER_POINT = 10;

/**
 * 点数から、変換に必要な領域(一時ファイル+出力COPC)の見積もり(バイト)。
 * ファイルサイズではなく点数から見積もることで、入力の圧縮の有無・座標の
 * データ型によらず一貫した見積もりになる(`requiredScratchBytes`のドキュメント
 * 参照。実機不具合の修正)。
 */
export function requiredBytesForPointCount(pointCount: number): number {
  return pointCount * (SCRATCH_BYTES_PER_POINT + OUTPUT_BYTES_PER_POINT);
}

export interface QuotaEstimate {
  /** そのオリジンに割り当てられている上限(バイト)。 */
  quota: number;
  /** 既に使用中の量(バイト)。 */
  usage: number;
}

/**
 * 空き容量(quota-usage)が、変換に必要な見積り(`requiredBytes`、呼び出し側が
 * `requiredBytesForPointCount`または`requiredScratchBytes`で求めた値)以上
 * あるか。
 */
export function hasEnoughQuota(estimate: QuotaEstimate, requiredBytes: number): boolean {
  const available = estimate.quota - estimate.usage;
  return available >= requiredBytes;
}

/** バイトを「約X.XGiB」の形にする(小数1桁)。容量不足の表示・設定画面の
 *  使用量表示で共通して使う。 */
export function toGiBLabel(bytes: number): string {
  return `約${(bytes / 1024 ** 3).toFixed(1)}GiB`;
}

/**
 * M4-6追記(「空き容量が足りません」の改善): `navigator.storage`の
 * `persist`/`persisted`だけを切り出したインターフェース。テストで差し替え
 * られるようにする(`LockManagerLike`と同じ方針。モジュール冒頭のドキュメント
 * 参照。ここでは既定値を持たない。呼び出し側(`web.ts`)が`navigator.storage`を渡す)。
 */
export interface PersistableStorageLike {
  persist(): Promise<boolean>;
  persisted(): Promise<boolean>;
}

export interface PersistenceOutcome {
  /** 呼んだ時点で既に永続化されていたか。 */
  alreadyPersisted: boolean;
  /** 今回`persist()`を呼んで許可されたか(既に永続化済みなら呼ばないのでfalse)。 */
  grantedNow: boolean;
  /** 最終的に永続化されているか(`alreadyPersisted || grantedNow`)。 */
  persisted: boolean;
}

/**
 * まだ永続化されていなければ`persist()`を求める(受け入れ条件「変換の前に
 * 永続的な保存を求める」)。既に永続化済みなら`persist()`自体を呼ばない
 * (Firefoxは毎回ユーザーへの確認ポップアップを出しうるため、既に許可済みの
 * ときに重ねて尋ねる必要は無い)。
 *
 * ブラウザごとの挙動(出典、`TaskSheets/M4-import-and-conversion.md`のM4-6追記参照):
 * - Firefoxはユーザーに確認のポップアップを出し、許可を求める
 *   (MDN「Storage quotas and eviction criteria」の
 *   “Does browser-stored data persist?”節: "the user is notified with a UI
 *   popup that their permission is requested")
 * - Chrome/Edge/Safariはサイトの利用履歴(エンゲージメント・インストール/
 *   ブックマーク・通知許可など)から自動で判定し、確認は出さない
 *   (同ページ: "automatically approve or deny the request based on the
 *   user's history of interaction with the site and do not show any
 *   prompts to the user"。具体的な判定条件はweb.dev「Persistent storage」:
 *   "How high is the level of site engagement? Has the site been installed
 *   or bookmarked? Has the site been granted permission to show
 *   notifications?")
 */
export async function ensurePersistentStorage(storage: PersistableStorageLike): Promise<PersistenceOutcome> {
  const already = await storage.persisted();
  if (already) {
    return { alreadyPersisted: true, grantedNow: false, persisted: true };
  }
  const granted = await storage.persist();
  return { alreadyPersisted: false, grantedNow: granted, persisted: granted };
}

/**
 * 容量不足のときに表示する文言の材料。`quotaBytes`/`usageBytes`は
 * `estimateQuota()`の結果、`persisted`は`isPersisted()`(または
 * `ensurePersistentStorage`の結果)、`reclaimableBytes`は
 * `getOpfsUsageBreakdown()`の内訳(キャッシュ+一時ファイル)の合計。
 */
export interface InsufficientSpaceWebDetails {
  requiredBytes: number;
  quotaBytes: number;
  usageBytes: number;
  persisted: boolean;
  reclaimableBytes: number;
}

/**
 * M4-6追記: Web版の「空き容量が足りません」の文言を組み立てる(純粋関数、
 * テスト可能)。
 *
 * 所有者の実機不具合(「空き容量が足りません(10.0GiB)」という表示だけでは、
 * 10.0GiBが「必要な量」なのか「空き」なのか分からなかった)を受け、
 * 必要・空き・上限・使用中を分けて出す。続けて「空けるには」何をすればよいかを
 * 示す(キャッシュ等が消せるときだけ提案に含め、永続化がまだなら許可を促し、
 * 常にデスクトップ版での変換を案内する)。
 */
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

  return `${summary} 空けるには、${actions.join("、")}、のいずれかを試してください。`;
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

/**
 * M4-14: 複数ファイル選択時のキャッシュキー。**選択した順序に依存しない**
 * ことが要件(同じファイル集合なら選ぶ順番が変わっても同じキャッシュに
 * 当たる)なので、ハッシュに入れる前に(名前, サイズ, 更新日時)の組を
 * 昇順にソートする(デスクトップ版`crates/pcv-convert/src/cache.rs`の
 * `multi_fingerprint_of_paths`と同じ考え方。ソートしてから1本のハッシュに
 * 畳み込むだけなので、1ファイルだけの選択では`cacheKeyFor`と同じ結果になる
 * ことを`opfs.test.ts`で確認する)。
 */
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

/** M4-14: 複数ファイル版の`outputFileNameFor`。 */
export function outputFileNameForMulti(fingerprints: FileFingerprint[]): string {
  return `${cacheKeyForMulti(fingerprints)}.copc.laz`;
}

/**
 * M4-14: 複数ファイル選択時の表示名。「<先頭ファイルの拡張子抜きの名前>
 * ほか<残り件数>ファイル」(要件の表示例「09LD2626 ほか54ファイル」のとおり。
 * デスクトップ版`crates/pcv-convert/src/output_path.rs`の
 * `multi_output_file_name`と同じ考え方)。`sortedNames`は選択順に依存しない
 * 表示にするため、呼び出し側が昇順ソート済みで渡す。
 */
export function multiDisplayNameFor(sortedNames: string[]): string {
  if (sortedNames.length === 0) return "";
  const first = sortedNames[0].replace(/\.(las|laz)$/i, "");
  const rest = sortedNames.length - 1;
  return rest === 0 ? sortedNames[0] : `${first} ほか${rest}ファイル`;
}

interface CacheMeta {
  sourceName: string;
  sourceSize: number;
  sourceLastModified: number;
  outputName: string;
}

/** M4-14: 複数ファイル版のキャッシュ索引。`sources`は選択順に依存しない
 *  比較のため、ソート済みの配列として保存・比較する。 */
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

/** `navigator.storage.persisted()`をラップする(永続化の現在の状態、
 *  設定画面の表示用)。 */
export async function isPersisted(): Promise<boolean> {
  return navigator.storage.persisted();
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

/** M4-14: 複数ファイル版の`findCachedOutput`。選択した集合(順序不問)が
 *  一致するキャッシュがあれば、その出力ファイルを返す。 */
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

/** M4-14: 複数ファイル版の`writeCacheMeta`。 */
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

/** 変換済みキャッシュ1件(設定画面の一覧表示・削除用)。 */
export interface CachedConversionEntry {
  /** OPFS上の出力ファイル名(`outputFileNameFor`が作ったもの、`<key>.copc.laz`)。 */
  outputName: string;
  /** OPFS上のサイドカー索引のファイル名(`<key>.meta.json`)。削除時に一緒に消す。 */
  metaFileName: string;
  /** 元の入力ファイル名(表示用)。 */
  sourceName: string;
  /** 出力ファイル+サイドカーの合計サイズ(バイト)。 */
  sizeBytes: number;
}

/** 残っている一時ファイルのディレクトリ1件(設定画面の一覧表示・削除用)。 */
export interface StaleScratchDirEntry {
  /** OPFS上のディレクトリ名(`pcv-scratch-<id>`、または旧実装の固定名`pcv-scratch`)。 */
  name: string;
  /** 配下の一時ファイルの合計サイズ(バイト)。他のタブが使用中で読めなかった場合は0。 */
  sizeBytes: number;
}

/** OPFSの使用量の内訳(受け入れ条件「キャッシュ・一時ディレクトリの内訳が見える」)。 */
export interface OpfsUsageBreakdown {
  cachedConversions: CachedConversionEntry[];
  cachedConversionsTotalBytes: number;
  staleScratchDirs: StaleScratchDirEntry[];
  staleScratchTotalBytes: number;
}

/** ディレクトリ配下(再帰)の合計バイト数。`removeScratchDirByName`等と違い、
 *  読み取りに失敗しても例外を外へ投げる(呼び出し側`getOpfsUsageBreakdown`が
 *  1エントリ単位でcatchし、他のエントリの集計は続ける)。 */
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

/**
 * OPFSの使用量の内訳を集計する(変換済みキャッシュ・残っている一時ディレクトリ)。
 * 受け入れ条件「OPFSの使用量の内訳が見える」の実体。所有者の実機不具合
 * (「空き容量が足りません」が出ても、何が容量を使っているか・消せば空くのかが
 * 画面から分からなかった)の修正として追加した。
 *
 * 1件ごとに失敗を握りつぶして集計を続ける(索引が壊れている・対応する出力が無い・
 * 他のタブが使用中等。`findCachedOutput`と同じ「安全側に倒す」考え方)。
 */
export async function getOpfsUsageBreakdown(): Promise<OpfsUsageBreakdown> {
  const root = await navigator.storage.getDirectory();

  const cachedConversions: CachedConversionEntry[] = [];
  try {
    const dir = await getConvertedDir();
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind !== "file" || !name.endsWith(".meta.json")) continue;
      try {
        const metaFile = await handle.getFile();
        // M4-14: 複数ファイル版(MultiCacheMeta、`sources`配列を持つ)と
        // 単一ファイル版(CacheMeta、`sourceName`を持つ)の両方がこの
        // ディレクトリに混在するため、形で見分ける。
        const meta = JSON.parse(await metaFile.text()) as CacheMeta | MultiCacheMeta;
        const outputFile = await (await dir.getFileHandle(meta.outputName)).getFile();
        const sourceName =
          "sources" in meta
            ? multiDisplayNameFor(meta.sources.map((f) => f.name))
            : meta.sourceName;
        cachedConversions.push({
          outputName: meta.outputName,
          metaFileName: name,
          sourceName,
          sizeBytes: metaFile.size + outputFile.size,
        });
      } catch {
        // 索引が壊れている・対応する出力が無い等。この1件はスキップする。
      }
    }
  } catch {
    // pcv-convertedディレクトリ自体が無い(まだ何も変換していない)。空のまま。
  }

  const staleScratchDirs: StaleScratchDirEntry[] = [];
  for await (const [name, handle] of root.entries()) {
    if (handle.kind !== "directory" || !isScratchDirName(name)) continue;
    let sizeBytes = 0;
    try {
      sizeBytes = await dirTotalBytes(handle);
    } catch {
      // 他のタブが使用中等。サイズ不明として0のまま一覧には残す
      // (一覧から消すと「個別に消す」操作の対象にできなくなるため)。
    }
    staleScratchDirs.push({ name, sizeBytes });
  }

  return {
    cachedConversions,
    cachedConversionsTotalBytes: cachedConversions.reduce((sum, e) => sum + e.sizeBytes, 0),
    staleScratchDirs,
    staleScratchTotalBytes: staleScratchDirs.reduce((sum, e) => sum + e.sizeBytes, 0),
  };
}

/** 変換済みキャッシュを1件消す(設定画面の「消す」ボタン用)。 */
export async function removeCachedConversionEntry(
  entry: Pick<CachedConversionEntry, "metaFileName" | "outputName">,
): Promise<void> {
  const dir = await getConvertedDir();
  for (const name of [entry.metaFileName, entry.outputName]) {
    try {
      await dir.removeEntry(name);
    } catch {
      // 既に無い等。実害なし(もう一方は消し続ける)。
    }
  }
}

/** 変換済みキャッシュを全て消す(設定画面の「すべて消す」ボタン用)。 */
export async function clearAllCachedConversions(): Promise<void> {
  const dir = await getConvertedDir();
  const names: string[] = [];
  for await (const name of dir.keys()) names.push(name);
  for (const name of names) {
    try {
      await dir.removeEntry(name);
    } catch {
      // 実害なし(個別の失敗で全体を諦めない。他のtry/catchと同じ考え方)。
    }
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
/** 指定した一時ディレクトリを1件消す(設定画面の「消す」ボタン用)。
 *  `isScratchDirName`に当たらない名前は消さない(呼び出し元のミスでOPFS内の
 *  無関係なエントリを消してしまうことを防ぐ安全策)。 */
export async function removeScratchDirByName(name: string): Promise<void> {
  if (!isScratchDirName(name)) return;
  const root = await navigator.storage.getDirectory();
  try {
    await root.removeEntry(name, { recursive: true });
  } catch {
    // 他のタブが使用中等。実害なし(`cleanupStaleScratchDirs`と同じ考え方)。
  }
}

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