/* @ts-self-types="./pcv_wasm.d.ts" */

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
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        LazRangeDecompressorFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_lazrangedecompressor_free(ptr, 0);
    }
    /**
     * 最大`batch_size`点を読み、`copc_core::serialize_le`形式(`recordWidth()`
     * ちょうどの幅)の固定長レコードを連結したバイト列を返す。戻り値の長さは
     * 常に`(読めた点数) * recordWidth()`で、`batch_size * recordWidth()`を
     * 超えない(=メモリ使用量が担当範囲全体の点数に比例しない、という
     * このAPIの目的そのもの)。空の`Vec`を返したら、担当範囲を読み終えた
     * (呼び出し側はこれ以上`feed`を呼ばない)。
     * @param {number} batch_size
     * @returns {Uint8Array}
     */
    feed(batch_size) {
        const ret = wasm.lazrangedecompressor_feed(this.__wbg_ptr, batch_size);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * `start_index`が`total_points`以上、または末尾付近で`count`点に
     * 満たない場合は、実際に読める点数だけを担当範囲として扱う(エラーに
     * しない。呼び出し側がファイル全体を`hardwareConcurrency`等分するときに、
     * 割り切れない端数が出てもそのまま渡せるようにするため。旧
     * `decompress_laz_range`と同じ方針)。
     * @param {File} file
     * @param {number} start_index
     * @param {number} count
     */
    constructor(file, start_index, count) {
        const ret = wasm.lazrangedecompressor_new(file, start_index, count);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0];
        LazRangeDecompressorFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
}
if (Symbol.dispose) LazRangeDecompressor.prototype[Symbol.dispose] = LazRangeDecompressor.prototype.free;

export class WasmConverter {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        WasmConverterFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_wasmconverter_free(ptr, 0);
    }
    /**
     * 最大`batch_size`点を読み、spillへ書く。呼び出し側
     * (`src/datasource/copc.worker.ts`)はこれを繰り返し呼び、呼び出しの
     * 合間に`await`でWorkerのイベントループへ制御を返す
     * (キャンセル要求を受け取れるようにするため。モジュールドキュメント参照)。
     *
     * 戻り値(`dto::FeedResultDto`)の`done`が`true`になったら、これ以上
     * `feed`を呼ばず`finish`へ進む。
     * @param {number} batch_size
     * @returns {any}
     */
    feed(batch_size) {
        const ret = wasm.wasmconverter_feed(this.__wbg_ptr, batch_size);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * 読み込みを終え、octreeを構築してOPFSの出力ハンドルへ書き出す。
     * この呼び出しの間はキャンセルできない(モジュールドキュメント参照)。
     * 呼び出し元はこれを呼ぶ前に、直近の`feed`で`done: true`が返っている
     * ことを確認すること(このメソッド自身は`feed`が尽きたかを検証しない。
     * spillに一部の点しか無い状態でも変換自体は成立してしまうため、
     * 呼び出し順の誤りは検出しない設計にしてある。単純さを優先した)。
     * @returns {any}
     */
    finish() {
        const ptr = this.__destroy_into_raw();
        const ret = wasm.wasmconverter_finish(ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * `file`は変換元のLAS/LAZ。`scratch_handles`は事前に開いた一時ファイルの
     * プール(`opfs.rs`のドキュメント参照)、`output_handle`は出力先として
     * 事前に開いたハンドル、`output_name`は`ScratchFs::create_output`へ渡す
     * 識別名(OPFS向け実装は内容の確定にファイル名を使わないため、
     * ログ・デバッグ用途以上の意味は持たない)。
     * @param {File} file
     * @param {Array<any>} scratch_handles
     * @param {FileSystemSyncAccessHandle} output_handle
     * @param {string} output_name
     * @param {number} max_points_per_node
     */
    constructor(file, scratch_handles, output_handle, output_name, max_points_per_node) {
        const ptr0 = passStringToWasm0(output_name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.wasmconverter_new(file, scratch_handles, output_handle, ptr0, len0, max_points_per_node);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0];
        WasmConverterFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * M4-14: 複数ファイル選択時、このファイルを読み終えた後に次のファイルへ
     * 切り替える。`spill`(1本のoctree用の書き込み先)・`metadata`・`params`は
     * そのまま使い続け、読み込み元(`reader`/`point_data`)だけを入れ替える
     * (デスクトップ版`pcv_convert::merge::MultiFileLasPoints`が複数ファイルを
     * 1本のイテレータにまとめるのと同じ考え方。モジュール冒頭のドキュメント
     * 「M4-7」の設計がWeb版でも成立する根拠(`SpillWriter::push`は呼ばれた
     * 順にその場で蓄積するだけ)は、ここでも変わらない)。
     *
     * 呼び出し側(`src/datasource/copc.worker.ts`)は、呼ぶ前に
     * `inspectLasHeaderSummary`で全ファイルのpoint format・CRSが一致することを
     * 確認している前提だが、ここでも同じ確認をもう一度行う(触った関数の
     * 周りはpanicしない形にする、CLAUDE.mdのエラー処理方針。TypeScript側の
     * 確認漏れ・不整合があっても、ここで明確なエラーとして止まる)。
     * @param {File} file
     */
    openNextFile(file) {
        const ret = wasm.wasmconverter_openNextFile(this.__wbg_ptr, file);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
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
     * @param {Uint8Array} bytes
     */
    pushSerializedRecords(bytes) {
        const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.wasmconverter_pushSerializedRecords(this.__wbg_ptr, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * spillの1レコードあたりのバイト数。並列展開Workerが返すバイト列は
     * この幅ちょうどの倍数になるため、TypeScript側は
     * `buffer.byteLength / recordWidth()`で点数を逆算できる(M4-7、
     * 戻り値を別途やり取りする手間を省くため)。
     * @returns {number}
     */
    recordWidth() {
        const ret = wasm.wasmconverter_recordWidth(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * M4-14: 複数ファイル選択時、全ファイルのヘッダー確認
     * (`inspectLasHeaderSummary`)で事前に計算した合計点数・合計サイズで
     * 上書きする。`new()`時点では先頭ファイルのヘッダーしか見えていない
     * ため(`totalPoints()`はまだ1ファイル分)、全体の進捗バー・内訳表示を
     * 正しくするために呼ぶ(呼ばなければ単一ファイルの値のまま=既存の
     * 単一ファイル経路は無変更)。
     * @param {number} total_points
     * @param {number} total_file_size_bytes
     */
    setDeclaredTotals(total_points, total_file_size_bytes) {
        wasm.wasmconverter_setDeclaredTotals(this.__wbg_ptr, total_points, total_file_size_bytes);
    }
    /**
     * 入力の総点数(ヘッダーの申告値)。TypeScript側
     * (`src/datasource/copc.worker.ts`)が、並列展開Workerへ割り振る
     * 点インデックスの範囲を決めるために使う(M4-7)。
     * @returns {number}
     */
    totalPoints() {
        const ret = wasm.wasmconverter_totalPoints(this.__wbg_ptr);
        return ret;
    }
}
if (Symbol.dispose) WasmConverter.prototype[Symbol.dispose] = WasmConverter.prototype.free;

/**
 * 開いたCOPCファイル。ローカルファイル(`openFile`)かURL(`openUrl`)かは
 * 内部の`Box<dyn ReadSeek>`にしまってあるので、以降のメソッドは区別しない。
 */
export class WasmCopcFile {
    static __wrap(ptr) {
        const obj = Object.create(WasmCopcFile.prototype);
        obj.__wbg_ptr = ptr;
        WasmCopcFileFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        WasmCopcFileFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_wasmcopcfile_free(ptr, 0);
    }
    /**
     * これまでにJS側へ渡したバイト数の合計。ファイルサイズと比べることで
     * 「ファイル全体を読んでいないこと」を確認できる(受け入れ条件)。
     * @returns {number}
     */
    bytesRead() {
        const ret = wasm.wasmcopcfile_bytesRead(this.__wbg_ptr);
        return ret;
    }
    /**
     * octreeのノード一覧(`HierarchyNodeDto`の配列)。
     * @returns {any}
     */
    hierarchy() {
        const ret = wasm.wasmcopcfile_hierarchy(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * 点群全体の情報(`src/datasource/copc-dto.ts`の`CloudInfoDto`と同じ形)。
     * @returns {any}
     */
    info() {
        const ret = wasm.wasmcopcfile_info(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * `<input type="file">`やドラッグ&ドロップで得た`File`を開く。
     * `FileReaderSync`を使うため、この呼び出し自体もWorker内でしか動かない。
     * @param {File} file
     * @returns {WasmCopcFile}
     */
    static openFile(file) {
        const ret = wasm.wasmcopcfile_openFile(file);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return WasmCopcFile.__wrap(ret[0]);
    }
    /**
     * CORSとHTTP Rangeに対応したURLを開く。対応していないサーバーの場合は
     * 最初のRangeプローブの時点でエラーになる(`http_reader::HttpRangeReader::new`参照)。
     * @param {string} url
     * @returns {WasmCopcFile}
     */
    static openUrl(url) {
        const ptr0 = passStringToWasm0(url, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.wasmcopcfile_openUrl(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return WasmCopcFile.__wrap(ret[0]);
    }
    /**
     * 指定ノードの点データを読み、`src/datasource/node-format.ts`が読める
     * バイト列(M1-2の形式)を返す。`Vec<u8>`はwasm-bindgen越しに`Uint8Array`になる。
     * @param {string} key
     * @returns {Uint8Array}
     */
    readNode(key) {
        const ptr0 = passStringToWasm0(key, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.wasmcopcfile_readNode(this.__wbg_ptr, ptr0, len0);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v2;
    }
    /**
     * 元のファイル/URL全体のバイト数。`bytesRead()`と比べることで
     * 「ファイル全体を読んでいないこと」を確認できる(受け入れ条件)。
     * @returns {number}
     */
    totalSize() {
        const ret = wasm.wasmcopcfile_totalSize(this.__wbg_ptr);
        return ret;
    }
}
if (Symbol.dispose) WasmCopcFile.prototype[Symbol.dispose] = WasmCopcFile.prototype.free;

/**
 * Web版のPCD→COPC変換。`src/datasource/copc.worker.ts`の
 * `handlePcdConvertStart`が使う。メソッド構成は`convert.rs`の
 * `WasmConverter`に揃えてある(`totalPoints`/`feed`/`finish`)。
 */
export class WasmPcdConverter {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        WasmPcdConverterFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_wasmpcdconverter_free(ptr, 0);
    }
    /**
     * 最大`batch_size`点を読み、spillへ書く。LAS/LAZ版と違い並列展開は無い
     * (モジュールドキュメント参照)ので、呼び出し側は常にこの逐次バッチ
     * ループで進める。
     * @param {number} batch_size
     * @returns {any}
     */
    feed(batch_size) {
        const ret = wasm.wasmpcdconverter_feed(this.__wbg_ptr, batch_size);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * 読み込みを終え、octreeを構築してOPFSの出力ハンドルへ書き出す
     * (`convert.rs`の`WasmConverter::finish`と同じ役割)。
     * @returns {any}
     */
    finish() {
        const ptr = this.__destroy_into_raw();
        const ret = wasm.wasmpcdconverter_finish(ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * @param {File} file
     * @param {Array<any>} scratch_handles
     * @param {FileSystemSyncAccessHandle} output_handle
     * @param {string} output_name
     * @param {number} max_points_per_node
     */
    constructor(file, scratch_handles, output_handle, output_name, max_points_per_node) {
        const ptr0 = passStringToWasm0(output_name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.wasmpcdconverter_new(file, scratch_handles, output_handle, ptr0, len0, max_points_per_node);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0];
        WasmPcdConverterFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * 入力の総点数(ヘッダーの申告値)。`convert.rs`の`WasmConverter::total_points`
     * と同じ役割。
     * @returns {number}
     */
    totalPoints() {
        const ret = wasm.wasmpcdconverter_totalPoints(this.__wbg_ptr);
        return ret;
    }
}
if (Symbol.dispose) WasmPcdConverter.prototype[Symbol.dispose] = WasmPcdConverter.prototype.free;

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
export function init_panic_hook() {
    wasm.init_panic_hook();
}

/**
 * M4-14: 複数ファイル選択時の事前確認。`file`の**ヘッダーだけ**を読み
 * (`las::Reader::new`はヘッダー+VLRしか読まず、点データは`fill_points`を
 * 呼ぶまで読まれない。デスクトップ版`pcv_convert::merge::summarize_headers`の
 * ドキュメントと同じ理由)、point format・CRS・申告点数・ファイルサイズを
 * 返す。
 *
 * `layout_key`/`crs_label`は`StreamingLayout`/`pcv_core::crs::Crs`の`Debug`
 * 表示そのまま。呼び出し側(`src/datasource/copc.worker.ts`)は文字列として
 * `===`比較するだけで、中身の構造は解釈しない(デスクトップ版の
 * `MergeError::LayoutMismatch`/`CrsMismatch`のエラー文言と同じく`{:?}`を使う。
 * 値を2箇所で比較するための「比較可能な文字列」として十分という判断)。
 * @param {File} file
 * @returns {any}
 */
export function inspectLasHeaderSummary(file) {
    const ret = wasm.inspectLasHeaderSummary(file);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * 2026-10-07追記: 直前にメモリ確保の失敗(`alloc_guard.rs`)が起きていれば
 * そのメッセージを返す。`src/datasource/copc.worker.ts`が変換失敗の
 * catchブロックで呼び、`unreachable`トラップしか伝わらないエラーメッセージに
 * この詳細を足して画面にも出す(`alloc_guard.rs`のドキュメント参照)。
 * @returns {string | undefined}
 */
export function lastAllocationFailureMessage() {
    const ret = wasm.lastAllocationFailureMessage();
    let v1;
    if (ret[0] !== 0) {
        v1 = getStringFromWasm0(ret[0], ret[1]);
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    }
    return v1;
}

/**
 * `opfs.rs`の`OPFS_SCRATCH_POOL_SIZE`をJS側にも公開する。TypeScript側
 * (`src/datasource/opfs.ts`)が事前に開くOPFS一時ファイルの個数を、この値と
 * 二重管理せずに揃えるため(値がずれると「Rustは600個用意されている前提で
 * 動くのにTS側は別の数しか開いていない」という食い違いが起きる)。
 * @returns {number}
 */
export function opfsScratchPoolSize() {
    const ret = wasm.opfsScratchPoolSize();
    return ret >>> 0;
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg_Error_67e7344beaa85059: function(arg0, arg1) {
            const ret = Error(getStringFromWasm0(arg0, arg1));
            return ret;
        },
        __wbg_String_8564e559799eccda: function(arg0, arg1) {
            const ret = String(arg1);
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_is_undefined_8c687d0b90d5b524: function(arg0) {
            const ret = arg0 === undefined;
            return ret;
        },
        __wbg___wbindgen_string_get_92ab86bb19cbc12f: function(arg0, arg1) {
            const obj = arg1;
            const ret = typeof(obj) === 'string' ? obj : undefined;
            var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            var len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_throw_5d9e815e6fdf150f: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_error_756c5934221e6fee: function(arg0) {
            console.error(arg0);
        },
        __wbg_flush_91458c8278aae724: function() { return handleError(function (arg0) {
            arg0.flush();
        }, arguments); },
        __wbg_getResponseHeader_5a541924b53981da: function() { return handleError(function (arg0, arg1, arg2, arg3) {
            const ret = arg1.getResponseHeader(getStringFromWasm0(arg2, arg3));
            var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            var len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        }, arguments); },
        __wbg_getSize_479486b8ac438f8e: function() { return handleError(function (arg0) {
            const ret = arg0.getSize();
            return ret;
        }, arguments); },
        __wbg_get_unchecked_363572bdd397d473: function(arg0, arg1) {
            const ret = arg0[arg1 >>> 0];
            return ret;
        },
        __wbg_instanceof_ArrayBuffer_d4ff01f8247925ae: function(arg0) {
            let result;
            try {
                result = arg0 instanceof ArrayBuffer;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_FileSystemSyncAccessHandle_bdd2286185c22623: function(arg0) {
            let result;
            try {
                result = arg0 instanceof FileSystemSyncAccessHandle;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_length_31bdaf014f5fbde2: function(arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_length_4e1adc0d42e23620: function(arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_message_1cbc5bc03dcf1dee: function(arg0) {
            const ret = arg0.message;
            return ret;
        },
        __wbg_new_1da3429bc3c4541c: function(arg0) {
            const ret = new Uint8Array(arg0);
            return ret;
        },
        __wbg_new_957a482ac6d88831: function() { return handleError(function () {
            const ret = new XMLHttpRequest();
            return ret;
        }, arguments); },
        __wbg_new_b138d76cf000f9f4: function() { return handleError(function () {
            const ret = new FileReaderSync();
            return ret;
        }, arguments); },
        __wbg_new_bebc3f4757acf305: function() {
            const ret = new Object();
            return ret;
        },
        __wbg_new_ffa92086ea89f79c: function() {
            const ret = new Array();
            return ret;
        },
        __wbg_now_d1fb6650485d7f3e: function() {
            const ret = Date.now();
            return ret;
        },
        __wbg_now_e7c6795a7f81e10f: function(arg0) {
            const ret = arg0.now();
            return ret;
        },
        __wbg_open_053384ed7511930b: function() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5) {
            arg0.open(getStringFromWasm0(arg1, arg2), getStringFromWasm0(arg3, arg4), arg5 !== 0);
        }, arguments); },
        __wbg_performance_3fcf6e32a7e1ed0a: function(arg0) {
            const ret = arg0.performance;
            return ret;
        },
        __wbg_prototypesetcall_ae9f5e7459250748: function(arg0, arg1, arg2) {
            Uint8Array.prototype.set.call(getArrayU8FromWasm0(arg0, arg1), arg2);
        },
        __wbg_readAsArrayBuffer_2b86b6267c40a312: function() { return handleError(function (arg0, arg1) {
            const ret = arg0.readAsArrayBuffer(arg1);
            return ret;
        }, arguments); },
        __wbg_read_259baab664b5f318: function() { return handleError(function (arg0, arg1, arg2, arg3) {
            const ret = arg0.read(getArrayU8FromWasm0(arg1, arg2), arg3);
            return ret;
        }, arguments); },
        __wbg_response_4f02562be5de11ab: function() { return handleError(function (arg0) {
            const ret = arg0.response;
            return ret;
        }, arguments); },
        __wbg_send_09550890a56d202e: function() { return handleError(function (arg0) {
            arg0.send();
        }, arguments); },
        __wbg_setRequestHeader_8153dcef951fa83c: function() { return handleError(function (arg0, arg1, arg2, arg3, arg4) {
            arg0.setRequestHeader(getStringFromWasm0(arg1, arg2), getStringFromWasm0(arg3, arg4));
        }, arguments); },
        __wbg_set_13d25b81ab403f5e: function(arg0, arg1, arg2) {
            arg0[arg1 >>> 0] = arg2;
        },
        __wbg_set_6be42768c690e380: function(arg0, arg1, arg2) {
            arg0[arg1] = arg2;
        },
        __wbg_set_at_f64_3c6b553861b50f18: function(arg0, arg1) {
            arg0.at = arg1;
        },
        __wbg_set_responseType_5340c8e9ffe32197: function(arg0, arg1) {
            arg0.responseType = __wbindgen_enum_XmlHttpRequestResponseType[arg1];
        },
        __wbg_size_338f1717fbf84c4e: function(arg0) {
            const ret = arg0.size;
            return ret;
        },
        __wbg_slice_49f10e038e37aae3: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = arg0.slice(arg1, arg2);
            return ret;
        }, arguments); },
        __wbg_static_accessor_GLOBAL_8eb4cd83130a11a0: function() {
            const ret = typeof global === 'undefined' ? null : global;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_GLOBAL_THIS_1e7044f654e934db: function() {
            const ret = typeof globalThis === 'undefined' ? null : globalThis;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_SELF_d8b50611246a6d92: function() {
            const ret = typeof self === 'undefined' ? null : self;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_WINDOW_fd0bc376bf0f8b42: function() {
            const ret = typeof window === 'undefined' ? null : window;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_status_08d7fb024687db2b: function() { return handleError(function (arg0) {
            const ret = arg0.status;
            return ret;
        }, arguments); },
        __wbg_truncate_596e341e494285d5: function() { return handleError(function (arg0, arg1) {
            arg0.truncate(arg1 >>> 0);
        }, arguments); },
        __wbg_write_3e78f5b3224d701e: function() { return handleError(function (arg0, arg1, arg2, arg3) {
            const ret = arg0.write(getArrayU8FromWasm0(arg1, arg2), arg3);
            return ret;
        }, arguments); },
        __wbindgen_generic_0000000000000001: function(arg0) {
            // Cast intrinsic for `F64 -> Externref`.
            const ret = arg0;
            return ret;
        },
        __wbindgen_generic_0000000000000002: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_generic_0000000000000003: function(arg0) {
            // Cast intrinsic for `U64 -> Externref`.
            const ret = BigInt.asUintN(64, arg0);
            return ret;
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./pcv_wasm_bg.js": import0,
    };
}

const __wbindgen_enum_XmlHttpRequestResponseType = ["", "arraybuffer", "blob", "document", "json", "text"];
const LazRangeDecompressorFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_lazrangedecompressor_free(ptr, 1));
const WasmConverterFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_wasmconverter_free(ptr, 1));
const WasmCopcFileFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_wasmcopcfile_free(ptr, 1));
const WasmPcdConverterFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_wasmpcdconverter_free(ptr, 1));

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        const idx = addToExternrefTable0(e);
        wasm.__wbindgen_exn_store(idx);
    }
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedDataViewMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (!module.ok) {
            throw new Error(`failed to fetch Wasm: ${module.status} ${module.statusText} fetching '${module.url}'`);
        }

        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('pcv_wasm_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
