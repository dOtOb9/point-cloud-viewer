/* tslint:disable */
/* eslint-disable */

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
 * Worker起動時に一度だけ呼ぶ。パニック時にブラウザのconsoleへ理由を出す
 * (GUIを目視できない開発フローでも、devtoolsのconsoleでwasm側の異常が
 * 追えるようにするため。標準の`std::panic`フックをそのまま`console.error`に
 * 繋ぐだけで、専用クレート(`console_error_panic_hook`)は増やしていない)。
 */
export function init_panic_hook(): void;

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
    readonly __wbg_wasmconverter_free: (a: number, b: number) => void;
    readonly __wbg_wasmcopcfile_free: (a: number, b: number) => void;
    readonly init_panic_hook: () => void;
    readonly opfsScratchPoolSize: () => number;
    readonly wasmconverter_feed: (a: number, b: number) => [number, number, number];
    readonly wasmconverter_finish: (a: number) => [number, number, number];
    readonly wasmconverter_new: (a: any, b: any, c: any, d: number, e: number, f: number) => [number, number, number];
    readonly wasmcopcfile_bytesRead: (a: number) => number;
    readonly wasmcopcfile_hierarchy: (a: number) => [number, number, number];
    readonly wasmcopcfile_info: (a: number) => [number, number, number];
    readonly wasmcopcfile_openFile: (a: any) => [number, number, number];
    readonly wasmcopcfile_openUrl: (a: number, b: number) => [number, number, number];
    readonly wasmcopcfile_readNode: (a: number, b: number, c: number) => [number, number, number, number];
    readonly wasmcopcfile_totalSize: (a: number) => number;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
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
