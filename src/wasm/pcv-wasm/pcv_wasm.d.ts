/* tslint:disable */
/* eslint-disable */

/**
 * M4-7追記(2026-10-07、緊急修正): 展開専用Worker
 * (`src/datasource/laz-decompress.worker.ts`)から呼ぶ。`file`の点インデックス
 * `[start_index, start_index + count)`の範囲を、**小さなバッチ単位で**展開する。
 *
 * # なぜ「全部まとめて返す」設計をやめたか
 *
 * 旧設計(`decompress_laz_range`、1回の呼び出しで担当範囲**全体**の
 * `Vec<u8>`を作って返す)は、展開Worker1つあたりのメモリ使用量が担当範囲の
 * 点数に**比例**してしまう。1点あたり約43〜57バイト
 * (`vendor/copc-writer/tests/scratch_read_is_bounded.rs`参照)なので、
 * 例えば数千万点の入力を数個のWorkerに分けても、1Workerあたり数百MB〜
 * 1GB超のバッファになりうる。これがwasm32の4GiBアドレス空間を圧迫し、
 * 所有者の実機で確認された「変換に失敗しました: unreachable」(メモリ確保
 * 失敗によるトラップ)の一因になっていた
 * (`decompress-partition.ts`の`MAX_DECOMPRESS_WORKERS_MOBILE`のドキュメント、
 * `TaskSheets/M4-import-and-conversion.md`のM4-7追記参照)。
 *
 * `WasmConverter::feed`(変換用Worker側)が既に採用している「呼び出し側が
 * 小さなバッチ単位で何度も呼ぶ」設計を、展開側にも同じ考え方で導入する。
 * `LazRangeDecompressor`は自分専用の`las::Reader`を1回だけ開いて担当範囲の
 * 先頭まで`seek`し、以降は`feed(batch_size)`を呼ばれるたびに**その
 * バッチ分だけ**メモリを確保して返す。呼び出し側(`laz-decompress.worker.ts`)
 * は1バッチ返すたびに`postMessage`で変換用Workerへ渡し、変換用Workerが
 * `pushSerializedRecords`で消費し終えてから次のバッチを要求する
 * (pull型・背圧。`src/datasource/copc.worker.ts`の`runParallelReadPhase`、
 * `src/datasource/decompress-partition.ts`の`BoundedBatchFlow`参照)。これにより
 * 同時にメモリ上に存在するのは「バッチサイズ×Worker数」程度に収まり、
 * **点数に比例しない。**
 *
 * `WasmConverter`とは完全に独立したインスタンス(自分専用の`las::Reader`)を
 * 開く。Web Workerはメモリを共有しないグローバルなので、これは「1つの
 * `File`を複数のWorkerがそれぞれ自分のReaderで読む」ことになるが、
 * `File`は不変なスナップショットであり、読み出しは`FileRangeReader`経由の
 * 範囲読み(`File.slice`)なので競合しない。
 */
export class LazRangeDecompressor {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * 最大`batch_size`点を読み、`copc_core::serialize_le`形式(`recordWidth()`
     * ちょうどの幅)の固定長レコードを連結したバイト列を返す。戻り値の長さは
     * 常に`(読めた点数) * recordWidth()`で、`batch_size * recordWidth()`を
     * 超えない(=メモリ使用量が担当範囲全体の点数に比例しない、という
     * このAPIの目的そのもの)。空の`Vec`を返したら、担当範囲を読み終えた
     * (呼び出し側はこれ以上`feed`を呼ばない)。
     */
    feed(batch_size: number): Uint8Array;
    /**
     * `start_index`が`total_points`以上、または末尾付近で`count`点に
     * 満たない場合は、実際に読める点数だけを担当範囲として扱う(エラーに
     * しない。呼び出し側がファイル全体を`hardwareConcurrency`等分するときに、
     * 割り切れない端数が出てもそのまま渡せるようにするため。旧
     * `decompress_laz_range`と同じ方針)。
     */
    constructor(file: File, start_index: number, count: number);
}

export class WasmConverter {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * 最大`batch_size`点を読み、spillへ書く。呼び出し側
     * (`src/datasource/copc.worker.ts`)はこれを繰り返し呼び、呼び出しの
     * 合間に`await`でWorkerのイベントループへ制御を返す
     * (キャンセル要求を受け取れるようにするため。モジュールドキュメント参照)。
     *
     * 戻り値(`dto::FeedResultDto`)の`done`が`true`になったら、これ以上
     * `feed`を呼ばず`finish`へ進む。
     */
    feed(batch_size: number): any;
    /**
     * 読み込みを終え、octreeを構築してOPFSの出力ハンドルへ書き出す。
     * この呼び出しの間はキャンセルできない(モジュールドキュメント参照)。
     * 呼び出し元はこれを呼ぶ前に、直近の`feed`で`done: true`が返っている
     * ことを確認すること(このメソッド自身は`feed`が尽きたかを検証しない。
     * spillに一部の点しか無い状態でも変換自体は成立してしまうため、
     * 呼び出し順の誤りは検出しない設計にしてある。単純さを優先した)。
     */
    finish(): any;
    /**
     * `file`は変換元のLAS/LAZ。`scratch_handles`は事前に開いた一時ファイルの
     * プール(`opfs.rs`のドキュメント参照)、`output_handle`は出力先として
     * 事前に開いたハンドル、`output_name`は`ScratchFs::create_output`へ渡す
     * 識別名(OPFS向け実装は内容の確定にファイル名を使わないため、
     * ログ・デバッグ用途以上の意味は持たない)。
     */
    constructor(file: File, scratch_handles: Array<any>, output_handle: FileSystemSyncAccessHandle, output_name: string, max_points_per_node: number);
    /**
     * M4-7: 並列展開Worker(`decompress_laz_range`)が返したバイト列を
     * spillへ書く。バイト列は`recordWidth()`ちょうどの倍数の長さを持つ、
     * `copc_core::serialize_le`形式のレコードが連続したものであること。
     *
     * 展開Worker側で独立に`StreamingLayout::from_las_header`を計算して
     * いるため(同じファイルの同じヘッダーから導くので値は一致するはずだが、
     * 保険として)、渡されたバイト列の長さが`recordWidth()`の倍数で
     * ないときはエラーにする(値が合わなければ即座に気づけるようにする。
     * 黙って余りを捨てない)。
     */
    pushSerializedRecords(bytes: Uint8Array): void;
    /**
     * spillの1レコードあたりのバイト数。並列展開Workerが返すバイト列は
     * この幅ちょうどの倍数になるため、TypeScript側は
     * `buffer.byteLength / recordWidth()`で点数を逆算できる(M4-7、
     * 戻り値を別途やり取りする手間を省くため)。
     */
    recordWidth(): number;
    /**
     * 入力の総点数(ヘッダーの申告値)。TypeScript側
     * (`src/datasource/copc.worker.ts`)が、並列展開Workerへ割り振る
     * 点インデックスの範囲を決めるために使う(M4-7)。
     */
    totalPoints(): number;
}

/**
 * 開いたCOPCファイル。ローカルファイル(`openFile`)かURL(`openUrl`)かは
 * 内部の`Box<dyn ReadSeek>`にしまってあるので、以降のメソッドは区別しない。
 */
export class WasmCopcFile {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * これまでにJS側へ渡したバイト数の合計。ファイルサイズと比べることで
     * 「ファイル全体を読んでいないこと」を確認できる(受け入れ条件)。
     */
    bytesRead(): number;
    /**
     * octreeのノード一覧(`HierarchyNodeDto`の配列)。
     */
    hierarchy(): any;
    /**
     * 点群全体の情報(`src/datasource/copc-dto.ts`の`CloudInfoDto`と同じ形)。
     */
    info(): any;
    /**
     * `<input type="file">`やドラッグ&ドロップで得た`File`を開く。
     * `FileReaderSync`を使うため、この呼び出し自体もWorker内でしか動かない。
     */
    static openFile(file: File): WasmCopcFile;
    /**
     * CORSとHTTP Rangeに対応したURLを開く。対応していないサーバーの場合は
     * 最初のRangeプローブの時点でエラーになる(`http_reader::HttpRangeReader::new`参照)。
     */
    static openUrl(url: string): WasmCopcFile;
    /**
     * 指定ノードの点データを読み、`src/datasource/node-format.ts`が読める
     * バイト列(M1-2の形式)を返す。`Vec<u8>`はwasm-bindgen越しに`Uint8Array`になる。
     */
    readNode(key: string): Uint8Array;
    /**
     * 元のファイル/URL全体のバイト数。`bytesRead()`と比べることで
     * 「ファイル全体を読んでいないこと」を確認できる(受け入れ条件)。
     */
    totalSize(): number;
}

/**
 * Web版のPCD→COPC変換。`src/datasource/copc.worker.ts`の
 * `handlePcdConvertStart`が使う。メソッド構成は`convert.rs`の
 * `WasmConverter`に揃えてある(`totalPoints`/`feed`/`finish`)。
 */
export class WasmPcdConverter {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * 最大`batch_size`点を読み、spillへ書く。LAS/LAZ版と違い並列展開は無い
     * (モジュールドキュメント参照)ので、呼び出し側は常にこの逐次バッチ
     * ループで進める。
     */
    feed(batch_size: number): any;
    /**
     * 読み込みを終え、octreeを構築してOPFSの出力ハンドルへ書き出す
     * (`convert.rs`の`WasmConverter::finish`と同じ役割)。
     */
    finish(): any;
    constructor(file: File, scratch_handles: Array<any>, output_handle: FileSystemSyncAccessHandle, output_name: string, max_points_per_node: number);
    /**
     * 入力の総点数(ヘッダーの申告値)。`convert.rs`の`WasmConverter::total_points`
     * と同じ役割。
     */
    totalPoints(): number;
}

/**
 * Worker起動時に一度だけ呼ぶ。パニック時にブラウザのconsoleへ理由を出す
 * (GUIを目視できない開発フローでも、devtoolsのconsoleでwasm側の異常が
 * 追えるようにするため。標準の`std::panic`フックをそのまま`console.error`に
 * 繋ぐだけで、専用クレート(`console_error_panic_hook`)は増やしていない)。
 *
 * `#[wasm_bindgen(start)]`により、`init()`が解決した時点でwasm-bindgenの
 * 生成コードが自動的に1回呼ぶ(`src/datasource/copc.worker.ts`の
 * `ensureWasmReady`も、実装を追いやすくするため明示的にもう一度呼んでいる。
 * 副作用はない)。
 *
 * **メモリ確保の失敗はこのpanicフックを経由しない**(`std::alloc`は
 * 確保失敗時にpanicせず`handle_alloc_error`→`unreachable`で即座にトラップ
 * するため)。そちらは`alloc_guard.rs`の`#[global_allocator]`が別途検知する。
 */
export function init_panic_hook(): void;

/**
 * 2026-10-07追記: 直前にメモリ確保の失敗(`alloc_guard.rs`)が起きていれば
 * そのメッセージを返す。`src/datasource/copc.worker.ts`が変換失敗の
 * catchブロックで呼び、`unreachable`トラップしか伝わらないエラーメッセージに
 * この詳細を足して画面にも出す(`alloc_guard.rs`のドキュメント参照)。
 */
export function lastAllocationFailureMessage(): string | undefined;

/**
 * `opfs.rs`の`OPFS_SCRATCH_POOL_SIZE`をJS側にも公開する。TypeScript側
 * (`src/datasource/opfs.ts`)が事前に開くOPFS一時ファイルの個数を、この値と
 * 二重管理せずに揃えるため(値がずれると「Rustは600個用意されている前提で
 * 動くのにTS側は別の数しか開いていない」という食い違いが起きる)。
 */
export function opfsScratchPoolSize(): number;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_lazrangedecompressor_free: (a: number, b: number) => void;
    readonly __wbg_wasmconverter_free: (a: number, b: number) => void;
    readonly __wbg_wasmcopcfile_free: (a: number, b: number) => void;
    readonly __wbg_wasmpcdconverter_free: (a: number, b: number) => void;
    readonly init_panic_hook: () => void;
    readonly lastAllocationFailureMessage: () => [number, number];
    readonly lazrangedecompressor_feed: (a: number, b: number) => [number, number, number, number];
    readonly lazrangedecompressor_new: (a: any, b: number, c: number) => [number, number, number];
    readonly opfsScratchPoolSize: () => number;
    readonly wasmconverter_feed: (a: number, b: number) => [number, number, number];
    readonly wasmconverter_finish: (a: number) => [number, number, number];
    readonly wasmconverter_new: (a: any, b: any, c: any, d: number, e: number, f: number) => [number, number, number];
    readonly wasmconverter_pushSerializedRecords: (a: number, b: number, c: number) => [number, number];
    readonly wasmconverter_recordWidth: (a: number) => number;
    readonly wasmconverter_totalPoints: (a: number) => number;
    readonly wasmcopcfile_bytesRead: (a: number) => number;
    readonly wasmcopcfile_hierarchy: (a: number) => [number, number, number];
    readonly wasmcopcfile_info: (a: number) => [number, number, number];
    readonly wasmcopcfile_openFile: (a: any) => [number, number, number];
    readonly wasmcopcfile_openUrl: (a: number, b: number) => [number, number, number];
    readonly wasmcopcfile_readNode: (a: number, b: number, c: number) => [number, number, number, number];
    readonly wasmcopcfile_totalSize: (a: number) => number;
    readonly wasmpcdconverter_feed: (a: number, b: number) => [number, number, number];
    readonly wasmpcdconverter_finish: (a: number) => [number, number, number];
    readonly wasmpcdconverter_new: (a: any, b: any, c: any, d: number, e: number, f: number) => [number, number, number];
    readonly wasmpcdconverter_totalPoints: (a: number) => number;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
