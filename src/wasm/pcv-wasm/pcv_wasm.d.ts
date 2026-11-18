/* tslint:disable */
/* eslint-disable */

export class LazRangeDecompressor {
    free(): void;
    [Symbol.dispose](): void;
    feed(batch_size: number): Uint8Array;
    constructor(file: File, start_index: number, count: number);
}

export class WasmConverter {
    free(): void;
    [Symbol.dispose](): void;
    feed(batch_size: number): any;
    finish(): any;
    constructor(file: File, scratch_handles: Array<any>, output_handle: FileSystemSyncAccessHandle, output_name: string, max_points_per_node: number);
    openNextFile(file: File): void;
    pushSerializedRecords(bytes: Uint8Array): void;
    recordWidth(): number;
    setDeclaredTotals(total_points: number, total_file_size_bytes: number): void;
    totalPoints(): number;
}

export class WasmCopcFile {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    bytesRead(): number;
    hierarchy(): any;
    info(): any;
    static openFile(file: File): WasmCopcFile;
    static openUrl(url: string): WasmCopcFile;
    readNode(key: string): Uint8Array;
    readSectionProfile(line: any, cap: number): Uint8Array;
    totalSize(): number;
}

export class WasmDtm {
    free(): void;
    [Symbol.dispose](): void;
    advance(): any;
    finish(): any;
    geotiff(): Uint8Array;
    info(): any;
    landxml(unix_seconds: number): Uint8Array;
    constructor(file: File, request: any, scratch_handles: Array<any>, output_handle: FileSystemSyncAccessHandle, output_name: string, max_points_per_node: number);
}

export class WasmExtractor {
    free(): void;
    [Symbol.dispose](): void;
    feed(batch_size: number): any;
    finish(): any;
    constructor(file: File, filter: any, scratch_handles: Array<any>, output_handle: FileSystemSyncAccessHandle, output_name: string, max_points_per_node: number);
}

export class WasmPointFileConverter {
    free(): void;
    [Symbol.dispose](): void;
    feed(batch_size: number): any;
    finish(): any;
    constructor(formats: Array<any>, files: Array<any>, scratch_handles: Array<any>, output_handle: FileSystemSyncAccessHandle, output_name: string, max_points_per_node: number);
    totalPoints(): number;
}

export class WasmRasterPreview {
    free(): void;
    [Symbol.dispose](): void;
    feed(batch_size: number): any;
    info(): any;
    constructor(file: File);
    render(options: any): Uint8Array;
}

export class WasmRasterizer {
    free(): void;
    [Symbol.dispose](): void;
    feed(batch_size: number): any;
    geotiff(): Uint8Array;
    info(): any;
    constructor(file: File, options: any);
}

export class WasmSectionLine {
    free(): void;
    [Symbol.dispose](): void;
    advance(file: WasmCopcFile): number;
    finish(): Uint8Array;
    isDone(): boolean;
    constructor(file: WasmCopcFile, line: any, request: any);
}

export class WasmThinFilter {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    advance(): any;
    finish(): any;
    static forFilter(file: File, request: any, scratch_handles: Array<any>, output_handle: FileSystemSyncAccessHandle, output_name: string, max_points_per_node: number): WasmThinFilter;
    static forThin(file: File, request: any, scratch_handles: Array<any>, output_handle: FileSystemSyncAccessHandle, output_name: string, max_points_per_node: number): WasmThinFilter;
}

export function init_panic_hook(): void;

export function inspectLasHeaderSummary(file: File): any;

export function lastAllocationFailureMessage(): string | undefined;

export function opfsScratchPoolSize(): number;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_lazrangedecompressor_free: (a: number, b: number) => void;
    readonly __wbg_wasmconverter_free: (a: number, b: number) => void;
    readonly __wbg_wasmcopcfile_free: (a: number, b: number) => void;
    readonly __wbg_wasmdtm_free: (a: number, b: number) => void;
    readonly __wbg_wasmextractor_free: (a: number, b: number) => void;
    readonly __wbg_wasmpointfileconverter_free: (a: number, b: number) => void;
    readonly __wbg_wasmrasterizer_free: (a: number, b: number) => void;
    readonly __wbg_wasmrasterpreview_free: (a: number, b: number) => void;
    readonly __wbg_wasmsectionline_free: (a: number, b: number) => void;
    readonly __wbg_wasmthinfilter_free: (a: number, b: number) => void;
    readonly init_panic_hook: () => void;
    readonly inspectLasHeaderSummary: (a: any) => [number, number, number];
    readonly lastAllocationFailureMessage: () => [number, number];
    readonly lazrangedecompressor_feed: (a: number, b: number) => [number, number, number, number];
    readonly lazrangedecompressor_new: (a: any, b: number, c: number) => [number, number, number];
    readonly opfsScratchPoolSize: () => number;
    readonly wasmconverter_feed: (a: number, b: number) => [number, number, number];
    readonly wasmconverter_finish: (a: number) => [number, number, number];
    readonly wasmconverter_new: (a: any, b: any, c: any, d: number, e: number, f: number) => [number, number, number];
    readonly wasmconverter_openNextFile: (a: number, b: any) => [number, number];
    readonly wasmconverter_pushSerializedRecords: (a: number, b: number, c: number) => [number, number];
    readonly wasmconverter_recordWidth: (a: number) => number;
    readonly wasmconverter_setDeclaredTotals: (a: number, b: number, c: number) => void;
    readonly wasmconverter_totalPoints: (a: number) => number;
    readonly wasmcopcfile_bytesRead: (a: number) => number;
    readonly wasmcopcfile_hierarchy: (a: number) => [number, number, number];
    readonly wasmcopcfile_info: (a: number) => [number, number, number];
    readonly wasmcopcfile_openFile: (a: any) => [number, number, number];
    readonly wasmcopcfile_openUrl: (a: number, b: number) => [number, number, number];
    readonly wasmcopcfile_readNode: (a: number, b: number, c: number) => [number, number, number, number];
    readonly wasmcopcfile_readSectionProfile: (a: number, b: any, c: number) => [number, number, number, number];
    readonly wasmcopcfile_totalSize: (a: number) => number;
    readonly wasmdtm_advance: (a: number) => [number, number, number];
    readonly wasmdtm_finish: (a: number) => [number, number, number];
    readonly wasmdtm_geotiff: (a: number) => [number, number, number, number];
    readonly wasmdtm_info: (a: number) => [number, number, number];
    readonly wasmdtm_landxml: (a: number, b: number) => [number, number, number, number];
    readonly wasmdtm_new: (a: any, b: any, c: any, d: any, e: number, f: number, g: number) => [number, number, number];
    readonly wasmextractor_feed: (a: number, b: number) => [number, number, number];
    readonly wasmextractor_finish: (a: number) => [number, number, number];
    readonly wasmextractor_new: (a: any, b: any, c: any, d: any, e: number, f: number, g: number) => [number, number, number];
    readonly wasmpointfileconverter_feed: (a: number, b: number) => [number, number, number];
    readonly wasmpointfileconverter_finish: (a: number) => [number, number, number];
    readonly wasmpointfileconverter_new: (a: any, b: any, c: any, d: any, e: number, f: number, g: number) => [number, number, number];
    readonly wasmpointfileconverter_totalPoints: (a: number) => number;
    readonly wasmrasterizer_feed: (a: number, b: number) => [number, number, number];
    readonly wasmrasterizer_geotiff: (a: number) => [number, number, number, number];
    readonly wasmrasterizer_info: (a: number) => [number, number, number];
    readonly wasmrasterizer_new: (a: any, b: any) => [number, number, number];
    readonly wasmrasterpreview_feed: (a: number, b: number) => [number, number, number];
    readonly wasmrasterpreview_info: (a: number) => [number, number, number];
    readonly wasmrasterpreview_new: (a: any) => [number, number, number];
    readonly wasmrasterpreview_render: (a: number, b: any) => [number, number, number, number];
    readonly wasmsectionline_advance: (a: number, b: number) => [number, number, number];
    readonly wasmsectionline_finish: (a: number) => [number, number, number, number];
    readonly wasmsectionline_isDone: (a: number) => number;
    readonly wasmsectionline_new: (a: number, b: any, c: any) => [number, number, number];
    readonly wasmthinfilter_advance: (a: number) => [number, number, number];
    readonly wasmthinfilter_finish: (a: number) => [number, number, number];
    readonly wasmthinfilter_forFilter: (a: any, b: any, c: any, d: any, e: number, f: number, g: number) => [number, number, number];
    readonly wasmthinfilter_forThin: (a: any, b: any, c: any, d: any, e: number, f: number, g: number) => [number, number, number];
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
