/* @ts-self-types="./pcv_wasm.d.ts" */

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
}
if (Symbol.dispose) WasmCopcFile.prototype[Symbol.dispose] = WasmCopcFile.prototype.free;

/**
 * Worker起動時に一度だけ呼ぶ。パニック時にブラウザのconsoleへ理由を出す
 * (GUIを目視できない開発フローでも、devtoolsのconsoleでwasm側の異常が
 * 追えるようにするため。標準の`std::panic`フックをそのまま`console.error`に
 * 繋ぐだけで、専用クレート(`console_error_panic_hook`)は増やしていない)。
 */
export function init_panic_hook() {
    wasm.init_panic_hook();
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
        __wbg_getResponseHeader_5a541924b53981da: function() { return handleError(function (arg0, arg1, arg2, arg3) {
            const ret = arg1.getResponseHeader(getStringFromWasm0(arg2, arg3));
            var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            var len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        }, arguments); },
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
        __wbg_length_31bdaf014f5fbde2: function(arg0) {
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
        __wbg_open_053384ed7511930b: function() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5) {
            arg0.open(getStringFromWasm0(arg1, arg2), getStringFromWasm0(arg3, arg4), arg5 !== 0);
        }, arguments); },
        __wbg_prototypesetcall_ae9f5e7459250748: function(arg0, arg1, arg2) {
            Uint8Array.prototype.set.call(getArrayU8FromWasm0(arg0, arg1), arg2);
        },
        __wbg_readAsArrayBuffer_2b86b6267c40a312: function() { return handleError(function (arg0, arg1) {
            const ret = arg0.readAsArrayBuffer(arg1);
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
        __wbg_status_08d7fb024687db2b: function() { return handleError(function (arg0) {
            const ret = arg0.status;
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
const WasmCopcFileFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_wasmcopcfile_free(ptr, 1));

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
