//! 現在開いているCOPCファイルのアプリ状態と、それを操作する制御コマンド。
//!
//! ADR-0001の規約通り、ここは「どのファイルを開くか」という制御メッセージだけを
//! `invoke` で扱う。ノードの点データそのものは `pcv://` 経由で流す（`lib.rs` の
//! `handle_pcv_protocol` 参照）。重い処理（COPCのパース・octree走査）は
//! `pcv-core` に任せ、ここはTauriとの橋渡しだけをする。
//!
//! ## M2: `pcv://` の並行リクエストを直列化させない
//!
//! 経緯は `TaskSheets/ADR-0007-pcv-protocol-concurrency.md` を参照。要点だけここに残す。
//!
//! `pcv://` のハンドラを非同期版（`register_asynchronous_uri_scheme_protocol`）に
//! 切り替え、ノード読み出しをブロッキング用スレッドプールに逃がしても、
//! **`CopcFile` を1個だけ`Mutex`で共有したままでは直列化が解消しない**。
//! 理由は2つ絡み合っている。
//!
//! 1. `CopcFile::read_node` は `&mut self` を取る（`copc-reader`が内部でシーク
//!    位置を進めながら読むため、共有参照では呼べない）。1個のMutexで包むと、
//!    結局「1本のreaderをスレッド間で奪い合う」形になり、ロックを読み出しの
//!    間じゅう持ち続ける実装をつい書いてしまいやすい。
//! 2. 仮にロック区間を最小化できたとしても、`CopcFile`が1個しか無い以上、
//!    ある瞬間にディスクI/O・LAZ伸長を実行できるのは1スレッドだけである。
//!
//! 採った解決策: **同じファイルを独立にプールサイズ分だけ開き、専用のFile
//! ハンドルを持つ`CopcFile`をプールする**（`CopcPool`）。読み出しは
//! プールから1本借りて使い、終わったら返す。プールが空なら次に返却される
//! まで待つ（`Condvar`）。これによりプールサイズ本まで、ディスクI/Oと
//! LAZ伸長が本当に並行して走る。`CopcState`のMutexは「どのプールを使うか」
//! という`Arc`のクローンを取り出す間だけロックし、実際の読み出しはロックの
//! 外で行う（`read_node_bytes`参照）。
//!
//! プールサイズは当初`POOL_SIZE: usize = 8`という決め打ちの定数だったが、
//! `ADR-0007-pcv-protocol-concurrency.md`の追記（並行数1/4/8/16/20の実測）で
//! フロントの同時リクエスト数(4)が先に頭打ちになっていたと分かり、
//! `default_pool_size()`（`std::thread::available_parallelism()`）から
//! 動的に決める形に変えた。`open_copc`の`pool_size`引数で明示的に上書きも
//! できる（計測ハーネス用）。
//!
//! 検討して採らなかった案は`CopcPool`のドキュメントコメントに書いた。
//!
//! ## M3: OSのファイル選択ダイアログとAndroidの`content://` URI
//!
//! Tauri版にファイルパスの手入力しか無いと、Androidでは実質ファイルを開けない
//! （Androidアプリは通常パスを手入力できるUIを持たず、ダイアログが返すのも
//! `content://` URIであってファイルシステムパスではない）。そこで
//! `tauri-plugin-dialog`でOS標準の選択ダイアログを出し（デスクトップ・Android共通）、
//! 返ってきた文字列を`CopcPool::open_path`（通常のパス）か`CopcPool::open_uri`
//! （`content://`等のURI）のどちらかに渡す。
//!
//! `open_uri`は`tauri-plugin-fs`の`FsExt`を使う。`Fs::open`はデスクトップでは
//! `std::fs::OpenOptions::open`をそのまま呼ぶだけ（`open_path`と実質同じ処理）。
//! Androidでは`content://`を`ContentResolver.openAssetFileDescriptor`
//! （ネイティブKotlin側、`tauri-plugin-fs`の`FsPlugin.kt`）で解決し、得られた
//! 生のファイルディスクリプタを`std::fs::File::from_raw_fd`で包んで返す —
//! **ファイル全体をアプリのキャッシュにコピーしない**（2GB級のファイルがあるため、
//! この経路を実際にソースを読んで確認せずに使うことはできなかった。確認した
//! 根拠は`TaskSheets/M3-release-and-update.md`を参照）。
//!
//! `CopcPool::open_path`/`open_uri`はどちらも`pool_size`回、独立に「1本開く」
//! 処理を呼び直す。**`File::try_clone()`は使わない**（複製したハンドルは
//! シーク位置を共有するため、N本のリーダーで並行読みすると壊れる。本ファイル
//! 冒頭の解説と同じ理由）。毎回オープンし直すことで、パスの場合もURIの場合も
//! 新しいFile/fdが得られ、シーク位置が独立することを保証する。
//!
//! `open_uri`は`tauri::AppHandle`を要求するため、Androidの`content://` URIは
//! 実機（またはAndroidエミュレータ）でしか作れず、ユニットテストの対象にしにくい
//! （テスト用にAppHandleを用意する`tauri::test::mock_app()`は、この開発機の
//! 環境では別の問題でテストプロセスが起動できなかった。詳細は
//! `TaskSheets/M3-release-and-update.md`）。そのため`open_path`（AppHandle不要、
//! これまでと同じ`std::fs::File`直開き）と`open_uri`を意図的に分け、
//! ユニットテストは`open_path`側だけを対象にしている。
//!
//! ## M3: panicが起きてもアプリを落とさない（`TaskSheets/ADR-0013-crash-visibility.md`）
//!
//! 所有者の実機(OPPO Pad Air)で「点群が複数ノードにまたがると落ちる」という報告が
//! あった。ルートの`Cargo.toml`は`panic = "abort"`だったため、`read_node`
//! （LAZ伸長）のどこかで1回でもpanicすれば、ログを一切残さずプロセスが即終了して
//! いた可能性が高い。詳しい経緯はADR-0013を参照し、ここでは対処だけ記す。
//!
//! `read_node_bytes`は、実際にLAZ伸長を行う`file.read_node(key)`の呼び出しだけを
//! `std::panic::catch_unwind`で囲む（`checkout`/`checkin`自体は囲まない。理由は
//! 下記）。panicを捕まえたら、そのリクエストにはHTTP 500とpanicメッセージ・
//! ノードキーを返す（`lib.rs`の`handle_pcv_protocol`参照）。
//!
//! panicした`CopcFile`はプールに返さず捨てる。`&mut self`を取る`read_node`が
//! 途中で異常終了した場合、内部のシーク位置や状態が正しいままである保証が
//! 無いため、次のリクエストに使い回すと二次的な不具合（誤った位置を読む等）を
//! 招きかねない。捨てるだけだとプールが1本ずつ縮んでいってしまうため、
//! `CopcPool`は開き方（`open_one`）を覚えておき、panicのたびに同じ開き方で
//! 新しいリーダーを1本開き直してプールに補充する（`replenish_after_panic`）。
//! 補充自体が失敗した場合（ディスクエラー等）はプールが1本減ったまま続行する。
//! 二次的な失敗にまでリトライを重ねて複雑にするより、「プールが痩せても
//! アプリは生き続ける」ことを優先した。
//!
//! `checkout`/`checkin`自体をcatch_unwindの対象に含めなかったのは、
//! `CopcPool`自身の`idle`Mutexをpanicの間じゅう持たないようにするため
//! （現状の実装では実際に持っていない。`checkout()`はリーダーを取り出したら
//! すぐロックを手放す）。これにより、`read_node`がpanicしても`CopcPool`の
//! Mutex自体がpoisonされることは無い（poisonされるのは、ロックを保持した
//! ままpanicした場合だけ）。

use std::io::BufReader;
use std::panic::AssertUnwindSafe;
use std::path::Path;
use std::str::FromStr;
use std::sync::{Arc, Condvar, Mutex};

use pcv_core::{CloudInfo, CopcFile, HierarchyNode, NodeKey};
use tauri::{AppHandle, Runtime, State};
use tauri_plugin_fs::{FilePath, FsExt, OpenOptions};

/// `open_copc`が明示的なプールサイズ指定を受け取らなかったときに使う既定値。
///
/// 当初は`POOL_SIZE: usize = 8`という決め打ちの定数だった。
///
/// 8 に固定していた理由は`ADR-0007-pcv-protocol-concurrency.md`に
/// 「1リクエストがCPU律速なのでコア数まで増やしても頭打ちになると考えた」と
/// 書かれているが、**これは検証されていない仮定**であり、同ADRにも
/// 「変えるときは測り直すべき値」と明記されていた。
///
/// その後、フロントの同時リクエスト数（`src/renderer/node-loader.ts`の
/// `DEFAULT_MAX_CONCURRENT`）が **4** であることが分かった。プールが8あっても
/// フロントが4本しか投げないため、**プールの半分は使われていない**。
/// ADR-0007 が並行数8まで測ったとき、この点は考慮されていなかった。
///
/// そこで決め打ちをやめ、`std::thread::available_parallelism()`から決める形にした。
///
/// # 論理コア数と同じでよいと確認した（`ADR-0007`追記）
///
/// 当初はここが「実測に基づく最適値ではない」という状態だった。その後
/// `crates/pcv-core/examples/parallel_bench.rs`（webview/IPCを通さず`pcv-core`単体の
/// 上限を測るベンチ）で調べたところ、並行数を上げても**8スレッドで頭打ち**に
/// なっていた。原因はプールサイズではなく、`pcv-core::CopcFile::read_node`
/// 1回のコストが単スレッドで約88msもかかっていたこと（そのレベル全体への空間
/// クエリを投げて大半の点を捨てる実装だった）。
///
/// これを直し（hierarchy entryのoffset/byte_sizeへ直接seekする方式に変更。
/// `vendor/copc-reader/PATCH.md`参照）、同じベンチ・同じ`sofi.copc.laz`で
/// 測り直すと、1ノードあたりの時間が約10分の1（約8.7ms）になり、
/// 8スレッドの頭打ちが解消して論理コア数（この開発機で20）までスループットが
/// 素直に伸びた（1→114.6、8→694.5、16→964.7、20→1123.6 nodes/s）。
/// 論理コア数を超えて24〜40スレッドまで振っても、24でわずかに伸びた後
/// 32・40では頭打ちになった（1030〜1150 nodes/s の範囲で横ばい）。
/// つまり**論理コア数が「これ以上プールを増やしても本質的には伸びない」
/// 境目にほぼ一致する**ことを実測で確認できた。
///
/// したがって`std::thread::available_parallelism()`から決めるという値そのものは
/// 変えていないが、「実測に基づく最適値ではない」という以前の注記はもう正しくない。
/// 詳しい数値は`TaskSheets/ADR-0007-pcv-protocol-concurrency.md`の追記を参照。
///
/// 測り直すときは ADR-0007 と同じ方法（互いに重ならないノード集合、リリースビルド）で、
/// フロント側の同時リクエスト数とプールサイズの両方を振って測ること。
/// 片方だけ振っても、もう片方が先に頭打ちになって意味のある数値が出ない。
fn default_pool_size() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
}

/// 独立した`CopcFile`をプールし、読み出しリクエストに貸し出す。
///
/// 検討して採らなかった案:
/// - **`Arc<Mutex<CopcFile>>`のまま** — 今回直したかった問題そのもの。
///   ロックを読み出し中ずっと持たなければ`&mut self`の要求を満たせず、
///   結局1本のreaderの奪い合いになる。
/// - **`RwLock<CopcFile>`** — `read_node`が`&mut self`を要求するので
///   共有参照(`read()`)では呼べない。書き込みロック(`write()`)を使うなら
///   `Mutex`と変わらない。
/// - **hierarchyの走査だけ`pcv-core`に新APIを足し、`CopcReader`をリクエスト
///   の都度使い捨てで開く** — ノードを読むたびにファイルを開き直す
///   ことになり、毎回ヘッダとVLRを読み直すコストを払う。プールで使い回す
///   ほうが単純かつ安い（hierarchy再構築のコストは`ADR-0003`実測で
///   1〜16ms。プール初期化時にプールサイズの回数だけ払うだけで済み、
///   リクエストのたびには払わない）。
struct CopcPool {
    idle: Mutex<Vec<CopcFile>>,
    available: Condvar,
    /// プールした本数。ログ表示だけに使う（`idle`の初期長と同じ）。
    pool_size: usize,
    /// panicで失ったリーダーを同じ開き方で作り直すためのオープナー
    /// （`replenish_after_panic`参照）。`open_path`/`open_uri`がそれぞれ
    /// 自分の開き方をクロージャとして渡す。
    open_one: Box<dyn Fn() -> Result<CopcFile, String> + Send + Sync>,
}

impl CopcPool {
    /// 通常のファイルシステムパスから開く。`std::fs::File`を直接使う
    /// （`tauri-plugin-fs`を経由しない。デスクトップでの挙動はこれまでと
    /// 完全に同じで、`AppHandle`も要らない。ユニットテストはこちらだけを対象にする）。
    fn open_path(path: &Path, pool_size: usize) -> Result<Self, String> {
        let path = path.to_path_buf();
        Self::build(pool_size, move || {
            CopcFile::open(&path).map_err(|e| e.to_string())
        })
    }

    /// Androidの`content://`（または`file://`）URIから開く。`tauri-plugin-fs`の
    /// `FsExt`経由（本ファイル冒頭のコメント参照）。実機でしか作れないURIを扱うため
    /// `AppHandle`が要る。
    fn open_uri<R: Runtime>(
        app: &AppHandle<R>,
        uri: &str,
        pool_size: usize,
    ) -> Result<Self, String> {
        let app = app.clone();
        let uri = uri.to_string();
        Self::build(pool_size, move || open_uri_reader(&app, &uri))
    }

    /// `pool_size`回、独立に`open_one`を呼んでプールを作る（`File::try_clone()`は
    /// 使わない。本ファイル冒頭のコメント参照）。`open_one`は`Fn`（`FnMut`ではない）
    /// にした。パニック後の補充（`replenish_after_panic`）で`&self`から
    /// 何度でも呼び直せる必要があるため。
    fn build<F>(pool_size: usize, open_one: F) -> Result<Self, String>
    where
        F: Fn() -> Result<CopcFile, String> + Send + Sync + 'static,
    {
        let pool_size = pool_size.max(1);
        let mut idle = Vec::with_capacity(pool_size);
        for _ in 0..pool_size {
            idle.push(open_one()?);
        }
        Ok(Self {
            idle: Mutex::new(idle),
            available: Condvar::new(),
            pool_size,
            open_one: Box::new(open_one),
        })
    }

    /// プールから1本借りる。空なら、誰かが`checkin`するまでこのスレッドを
    /// ブロックする。呼び出し元は常に`spawn_blocking`の中（ブロッキング用
    /// スレッドプール上）なので、ここでブロックしてもUIスレッドは止まらない。
    fn checkout(&self) -> CopcFile {
        let mut idle = self.idle.lock().expect("CopcPool mutex poisoned");
        loop {
            if let Some(file) = idle.pop() {
                return file;
            }
            idle = self
                .available
                .wait(idle)
                .expect("CopcPool condvar poisoned");
        }
    }

    fn checkin(&self, file: CopcFile) {
        self.idle
            .lock()
            .expect("CopcPool mutex poisoned")
            .push(file);
        self.available.notify_one();
    }

    /// `read_node`がpanicし、そのリーダーを捨てた後に呼ぶ。同じ開き方
    /// （`open_one`）で新しいリーダーを1本開き直し、プールに補充する。
    /// これをしないと、panicが起きるたびにプールが1本ずつ縮んでいってしまう
    /// （本ファイル冒頭のコメント参照）。
    ///
    /// 開き直し自体が失敗した場合（ディスクエラー等）は、プールが1本減った
    /// ままになることを許容する。ここでリトライを重ねると設計が複雑になる
    /// うえ、失敗の原因（例えばファイル自体が既に閉じられた等）がリトライで
    /// 直る見込みは薄い。「プールが痩せてもアプリは生き続ける」ことを優先し、
    /// ログだけ残す。
    fn replenish_after_panic(&self) {
        match (self.open_one)() {
            Ok(file) => self.checkin(file),
            Err(err) => {
                log::error!(
                    "[pcv] panic後のリーダー再生成に失敗した。プールが1本減った状態のまま続行する: {err}"
                );
            }
        }
    }
}

/// `content://`/`file://` URIを1本、`tauri_plugin_fs`経由で開く。
///
/// `FilePath::from_str`は`Infallible`（常に`Ok`）を返す実装になっている
/// （`url::Url`としてパースでき、かつscheme長が2文字以上ならURL、それ以外
/// （Windowsのドライブレター`C:`のようなscheme長1文字も含む）はパス扱いになる、
/// という判別を`tauri-plugin-fs`側が持つ）。ここでは常にURIとして扱いたいので
/// 判別結果は使わず、そのまま`app.fs().open()`に渡す。
///
/// `app.fs().open()`はデスクトップでは`std::fs::OpenOptions::open`を直接呼ぶだけ
/// （Tauriのfsスコープ・権限チェックは`invoke`経由のJS呼び出しにだけ掛かるもので、
/// このRustからの直接呼び出しには掛からない）。Androidでは
/// `ContentResolver.openAssetFileDescriptor`から得た生のfdを
/// `std::fs::File::from_raw_fd`で包んで返す（`tauri-plugin-fs`のソース
/// `android.rs`/`FsPlugin.kt`で確認済み。コピーは発生しない）。
fn open_uri_reader<R: Runtime>(app: &AppHandle<R>, uri: &str) -> Result<CopcFile, String> {
    let file_path = FilePath::from_str(uri)
        .unwrap_or_else(|infallible: std::convert::Infallible| match infallible {});
    let mut open_options = OpenOptions::new();
    open_options.read(true);
    let file = app
        .fs()
        .open(file_path, open_options)
        .map_err(|e| format!("URIを開けなかった ({uri}): {e}"))?;
    CopcFile::from_reader(BufReader::new(file)).map_err(|e| e.to_string())
}

/// 現在開いているCOPCファイル。同時に1つしか開けない前提（M1時点ではタブ等は無い）。
/// 中身は`CopcPool`（上記参照）。`Arc`にしているのは、`read_node_bytes`が
/// `CopcState`のロックをプールの参照を取り出す一瞬だけに留め、実際の読み出しは
/// ロックの外で行うため（`Arc::clone`してすぐロックを手放す）。
#[derive(Default)]
pub struct CopcState(Mutex<Option<Arc<CopcPool>>>);

/// `open_copc` がフロントに返す、点群全体のサマリ。`CloudInfo`をそのままJSONにできる
/// 形へ詰め替える（pcv-coreはserdeに依存しないので、DTOはここで定義する）。
#[derive(Debug, Clone, serde::Serialize)]
pub struct CloudInfoDto {
    pub point_count: u64,
    pub min: [f64; 3],
    pub max: [f64; 3],
    pub scale: [f64; 3],
    pub offset: [f64; 3],
    pub has_color: bool,
}

impl From<&CloudInfo> for CloudInfoDto {
    fn from(info: &CloudInfo) -> Self {
        Self {
            point_count: info.point_count,
            min: info.min,
            max: info.max,
            scale: info.scale,
            offset: info.offset,
            has_color: info.has_color,
        }
    }
}

/// octreeの1ノード分のメタデータ（点データそのものは含まない。M1-4のLOD選択で使う）。
#[derive(Debug, Clone, serde::Serialize)]
pub struct HierarchyNodeDto {
    /// `pcv://<key>` にそのまま使える文字列表現（例: "0-0-0-0"）。
    pub key: String,
    pub point_count: u32,
    pub bounds_min: [f64; 3],
    pub bounds_max: [f64; 3],
}

impl From<&HierarchyNode> for HierarchyNodeDto {
    fn from(node: &HierarchyNode) -> Self {
        Self {
            key: node.key.to_string(),
            point_count: node.point_count,
            bounds_min: node.bounds_min,
            bounds_max: node.bounds_max,
        }
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct OpenCopcResponse {
    pub info: CloudInfoDto,
    pub nodes: Vec<HierarchyNodeDto>,
}

/// COPCファイルを開き、以後の `pcv://<key>` リクエストがこのファイルを参照するようにする。
/// 点数・BBOX・hierarchy一覧（メタデータのみ）をフロントに返す。
///
/// hierarchyはノードあたり数十バイトのメタデータなので`invoke`で送る
/// （大きい点データそのものではない。ADR-0001の「invokeは制御メッセージ専用」に沿う）。
///
/// `pool_size`を省略（`null`）すると`default_pool_size()`（論理コア数）を使う。
/// 通常のUIからは省略して呼ぶ。明示的に渡せるのは
/// `src/state/useNodeConcurrencyBench.ts`が並行数ごとにプールサイズも振って
/// 計測するため（`ADR-0007-pcv-protocol-concurrency.md`参照）。同じファイルを
/// 開き直すとプールを作り直すだけで、ハンドラの他の状態には影響しない。
///
/// `path`はファイルシステムパス、またはAndroidの`content://` URI（OSのファイル
/// 選択ダイアログが返したものをそのまま渡す。`src/datasource/tauri.ts`の
/// `pickLocalFile()`参照）。`app`はTauriが自動で注入する（フロントから渡す
/// 引数ではない）。
#[tauri::command]
pub fn open_copc(
    app: AppHandle,
    path: String,
    pool_size: Option<usize>,
    state: State<CopcState>,
) -> Result<OpenCopcResponse, String> {
    let pool_size = pool_size.unwrap_or_else(default_pool_size);
    // パスかURIかは`tauri_plugin_fs`の判別に任せる（本ファイル冒頭のコメント参照）。
    // Windowsのドライブレター(`C:\...`)はscheme長1文字のためPath扱いになる。
    let pool =
        match FilePath::from_str(&path).unwrap_or_else(|e: std::convert::Infallible| match e {}) {
            FilePath::Path(p) => CopcPool::open_path(&p, pool_size)?,
            FilePath::Url(_) => CopcPool::open_uri(&app, &path, pool_size)?,
        };
    open_copc_impl(pool, &path, &state)
}

/// プールが開けた後の共通処理（hierarchy取得・`CopcState`更新・ログ出力）。
/// `AppHandle`を必要としない素の関数にしておくと、テストでは
/// `CopcPool::open_path`（`AppHandle`不要）で開いたプールをそのまま渡して検証できる
/// （`content://` URIは実機でしか作れないため、`CopcPool::open_uri`はユニット
/// テストの対象にしていない。本ファイル冒頭のコメント参照）。
fn open_copc_impl(
    pool: CopcPool,
    path: &str,
    state: &CopcState,
) -> Result<OpenCopcResponse, String> {
    // info/hierarchyはプール内のどの`CopcFile`でも同じ内容なので、1本借りて読む。
    let file = pool.checkout();
    let info = CloudInfoDto::from(file.info());
    let nodes: Vec<HierarchyNodeDto> = file
        .hierarchy()
        .nodes()
        .map(HierarchyNodeDto::from)
        .collect();
    pool.checkin(file);

    println!(
        "[pcv] opened {path}: {} points, {} nodes (reader pool size {})",
        info.point_count,
        nodes.len(),
        pool.pool_size
    );

    *state.0.lock().expect("CopcState mutex poisoned") = Some(Arc::new(pool));

    Ok(OpenCopcResponse { info, nodes })
}

/// `read_node_bytes`が返すエラー。`lib.rs`の`handle_pcv_protocol`は、これがどちらの
/// 種類かでHTTPステータスを変える（`Normal`=400 Bad Request、`Panicked`=500
/// Internal Server Error）。panicは「クライアントの入力が悪い」のではなく
/// 「サーバ側の処理が予期せず異常終了した」ことを表すため、意味の異なる
/// ステータスコードを割り当てる（`TaskSheets/ADR-0013-crash-visibility.md`参照）。
#[derive(Debug)]
pub enum ReadNodeError {
    /// 通常のエラー（ファイル未オープン、キー不正など）。
    Normal(String),
    /// `read_node`の呼び出し中にpanicが起き、`catch_unwind`で捕まえた。
    Panicked(String),
}

/// `catch_unwind`が返す`Box<dyn Any + Send>`から、人間が読めるメッセージを取り出す。
/// `panic!("...")`や`.expect("...")`は`&str`か`String`のどちらかでpayloadを積むのが
/// 標準ライブラリの挙動なので、その2種類だけを見る。それ以外（自作のpanic payload型
/// を使うケース）は稀なので、素直に「詳細不明」とする。
fn panic_payload_message(payload: Box<dyn std::any::Any + Send>) -> String {
    if let Some(s) = payload.downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        "詳細不明のpanic（&str/String以外のpayload）".to_string()
    }
}

// テスト専用: trueにすると、次の`read_node_bytes`呼び出しが実際の`read_node`より
// 前に必ずpanicする（読んだら自動的にfalseへ戻る、一回限りのフラグ）。
// スレッドローカルにしてあるのは、他のテストと状態を共有しないため
// （`cargo test`はテストごとに別スレッドで並行実行される）。
#[cfg(test)]
thread_local! {
    static PANIC_ON_NEXT_READ: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// `handle_pcv_protocol` から呼ばれる、実際のノード読み出し。
///
/// `CopcState`のロックは`Arc<CopcPool>`を複製する一瞬だけ持ち、すぐ手放す。
/// 実際のディスクI/O・LAZ伸長（`pool.checkout()`で借りた`CopcFile`に対する
/// `read_node`）はロックの外で行うため、複数リクエストが同時にここへ来ても
/// `CopcState`のロックでは直列化しない（直列化の可能性が残るのは`CopcPool`
/// 自体のプールサイズだけ。`default_pool_size()`のドキュメント参照）。
///
/// M3: `file.read_node(key)`の呼び出しだけを`catch_unwind`で囲む（本ファイル
/// 冒頭のコメント「M3: panicが起きてもアプリを落とさない」参照）。panicを
/// 捕まえたら、そのリーダーは`checkin`せずに捨て、`replenish_after_panic`で
/// プールを補充してから`ReadNodeError::Panicked`を返す。
pub fn read_node_bytes(state: &CopcState, key: NodeKey) -> Result<Vec<u8>, ReadNodeError> {
    let pool = {
        let guard = state.0.lock().expect("CopcState mutex poisoned");
        guard
            .as_ref()
            .ok_or_else(|| {
                ReadNodeError::Normal("no COPC file is open (call open_copc first)".to_string())
            })?
            .clone()
    };

    let mut file = pool.checkout();
    // `&mut file`をクロージャで捕まえるため`AssertUnwindSafe`で包む。`file`は
    // panicした場合そのまま(catch_unwindのErr分岐で)dropされ、プールには戻らない
    // （本ファイル冒頭のコメント参照: panic後の状態を信用しない）。
    let result = std::panic::catch_unwind(AssertUnwindSafe(|| {
        // テスト専用の差し込み: `PANIC_ON_NEXT_READ`が立っていれば、実際の
        // LAZ伸長より前に必ずpanicする。「読み出しの途中でpanicが起きても
        // アプリが落ちず、プールが壊れたままにならないこと」を確かめるための
        // 仕込みで、本番ビルド（`cfg(test)`が外れる）には一切含まれない。
        #[cfg(test)]
        if PANIC_ON_NEXT_READ.with(|flag| flag.replace(false)) {
            panic!("test-injected panic while reading node {key}");
        }
        file.read_node(key)
    }));

    let read_result = match result {
        Ok(read_result) => read_result,
        Err(panic_payload) => {
            pool.replenish_after_panic();
            let panic_message = panic_payload_message(panic_payload);
            return Err(ReadNodeError::Panicked(format!(
                "ノード{key}の読み出し中にpanicが発生した: {panic_message}"
            )));
        }
    };

    // panicしなかった場合だけ、借りたリーダーをプールに返す。
    pool.checkin(file);

    let buf = read_result.map_err(|e| ReadNodeError::Normal(e.to_string()))?;
    println!(
        "[pcv] served node {key}: {} points, {} bytes",
        buf.point_count,
        buf.bytes.len()
    );
    Ok(buf.bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use copc_writer::{
        write_source, CopcPointFields, CopcPointSource, CopcWriteMetadata, CopcWriterParams,
    };
    use std::str::FromStr;

    // pcv-coreのテストと同じ考え方: fixtureファイルをリポジトリに置かず、
    // その場で極小のCOPCを生成する（M1-point-rendering.mdの「テストデータの扱い」）。
    struct SyntheticSource {
        points: Vec<CopcPointFields>,
    }

    impl CopcPointSource for SyntheticSource {
        fn len(&self) -> usize {
            self.points.len()
        }

        fn xyz(&self, index: usize) -> copc_core::Result<(f64, f64, f64)> {
            let p = &self.points[index];
            Ok((p.x, p.y, p.z))
        }

        fn fields_into(&self, index: usize, out: &mut CopcPointFields) -> copc_core::Result<()> {
            out.clone_from(&self.points[index]);
            Ok(())
        }
    }

    fn synthetic_copc_file() -> (tempfile::TempDir, std::path::PathBuf) {
        let mut points = Vec::new();
        for i in 0..500 {
            points.push(CopcPointFields {
                x: 500_000.0 + i as f64 * 0.01,
                y: 4_000_000.0,
                z: 10.0,
                intensity: 0,
                return_number: 1,
                number_of_returns: 1,
                synthetic: 0,
                key_point: 0,
                withheld: 0,
                overlap: 0,
                scan_channel: 0,
                scan_direction_flag: 0,
                edge_of_flight_line: 0,
                classification: 2,
                user_data: 0,
                scan_angle: 0.0,
                point_source_id: 1,
                gps_time: 0.0,
                red: 0,
                green: 0,
                blue: 0,
                extra_bytes: Vec::new(),
            });
        }
        let bounds = points.iter().fold(
            copc_core::Bounds::point(points[0].x, points[0].y, points[0].z),
            |mut bounds, p| {
                bounds.extend(p.x, p.y, p.z);
                bounds
            },
        );

        let dir = tempfile::tempdir().expect("tempdir作成に失敗");
        let path = dir.path().join("synthetic.copc.laz");
        let source = SyntheticSource { points };
        write_source(
            &path,
            &source,
            false,
            bounds,
            &CopcWriterParams::new(64),
            &CopcWriteMetadata::default(),
        )
        .expect("テスト用COPCの書き出しに失敗");

        (dir, path)
    }

    #[test]
    fn open_copc_impl_populates_state_and_reports_summary() {
        let (_dir, path) = synthetic_copc_file();
        let state = CopcState::default();
        let pool = CopcPool::open_path(&path, default_pool_size()).unwrap();

        let response = open_copc_impl(pool, path.to_str().unwrap(), &state).unwrap();

        assert_eq!(response.info.point_count, 500);
        assert!(!response.nodes.is_empty());
        assert!(state.0.lock().unwrap().is_some());
    }

    /// 受け入れ条件: パスから`CopcPool`が組めること。明示的なプールサイズが
    /// そのまま反映されることも合わせて確認する（`useNodeConcurrencyBench`が
    /// 依存している挙動）。
    #[test]
    fn copc_pool_open_path_builds_pool_with_requested_size() {
        let (_dir, path) = synthetic_copc_file();
        let pool_size = 3;

        let pool = CopcPool::open_path(&path, pool_size).unwrap();

        assert_eq!(pool.pool_size, pool_size);
        // プールから借りたリーダーが実際に点を読めること（開き方が壊れていないこと）の確認。
        let mut file = pool.checkout();
        assert_eq!(file.info().point_count, 500);
        let root = *file.hierarchy().nodes().next().unwrap();
        assert!(file.read_node(root.key).is_ok());
        pool.checkin(file);
    }

    /// 受け入れ条件: `CopcPool`がリーダーごとに独立したファイルハンドルを開き、
    /// `File::try_clone()`のようにシーク位置を共有しないこと。
    ///
    /// Androidの`content://` URIは実機でしか作れないため（`CopcPool::open_uri`は
    /// このテストの対象にしていない。本ファイル冒頭のコメント参照）、ここでは
    /// 「同じパスを2回ファイルシステムから開くと、独立したシーク位置を持つ」という、
    /// `open_path`/`open_uri`がどちらも依拠している一般的なOSの前提そのものを検証する。
    /// `File::try_clone()`との違いを直接対比する形で確認する。
    #[test]
    fn independently_opened_file_handles_have_independent_seek_positions() {
        use std::fs::File;
        use std::io::{Read, Seek, SeekFrom};

        let dir = tempfile::tempdir().expect("tempdir作成に失敗");
        let path = dir.path().join("independent-seek.bin");
        std::fs::write(&path, b"0123456789").expect("テストファイルの書き込みに失敗");

        // 対比1: try_clone()は同じシーク位置を共有する（これがCopcPoolで
        // 使ってはいけない理由そのもの）。
        let mut original = File::open(&path).unwrap();
        let mut cloned = original.try_clone().unwrap();
        let mut buf = [0u8; 4];
        original.read_exact(&mut buf).unwrap(); // originalが0..4を消費
                                                // try_clone由来のハンドルも同じ位置(4)から読み始まる=共有されている証拠。
        let mut buf2 = [0u8; 4];
        cloned.read_exact(&mut buf2).unwrap();
        assert_eq!(&buf2, b"4567", "try_clone()はシーク位置を共有するはず");

        // 対比2: 独立にopen()し直すと、それぞれ別の位置から読める
        // （open_path/open_uriが毎回これをやっている、という前提の検証）。
        let mut reader_a = File::open(&path).unwrap();
        let mut reader_b = File::open(&path).unwrap();
        reader_a.seek(SeekFrom::Start(6)).unwrap();
        let mut a_buf = [0u8; 4];
        reader_a.read_exact(&mut a_buf).unwrap();
        assert_eq!(&a_buf, b"6789");

        // reader_bはreader_aのシークに一切影響されず、先頭から読める。
        let mut b_buf = [0u8; 4];
        reader_b.read_exact(&mut b_buf).unwrap();
        assert_eq!(
            &b_buf, b"0123",
            "独立にopenしたハンドルは互いのシークに影響されない"
        );
    }

    #[test]
    fn read_node_bytes_matches_m1_2_wire_format() {
        let (_dir, path) = synthetic_copc_file();
        let state = CopcState::default();
        let pool = CopcPool::open_path(&path, default_pool_size()).unwrap();
        let response = open_copc_impl(pool, path.to_str().unwrap(), &state).unwrap();

        let first_node = &response.nodes[0];
        let key = NodeKey::from_str(&first_node.key).unwrap();
        let bytes = read_node_bytes(&state, key).unwrap();

        // M1-2のヘッダ形式をここでも直接検証する（フロントのパーサと同じ並び）。
        assert_eq!(&bytes[0..4], pcv_core::MAGIC);
        let version = u32::from_le_bytes(bytes[4..8].try_into().unwrap());
        let point_count = u32::from_le_bytes(bytes[8..12].try_into().unwrap());
        assert_eq!(version, pcv_core::VERSION);
        assert_eq!(point_count, first_node.point_count);
        assert_eq!(
            bytes.len(),
            pcv_core::HEADER_BYTES + point_count as usize * pcv_core::POINT_STRIDE
        );
    }

    #[test]
    fn read_node_bytes_fails_before_any_file_is_open() {
        let state = CopcState::default();
        let err = read_node_bytes(&state, NodeKey::root()).unwrap_err();
        match err {
            ReadNodeError::Normal(message) => assert!(message.contains("no COPC file is open")),
            ReadNodeError::Panicked(message) => {
                panic!("Normalになるはずが Panicked だった: {message}")
            }
        }
    }

    /// 受け入れ条件（TaskSheets/ADR-0013）: 読み出しの途中でpanicが起きても、
    /// (a) `ReadNodeError::Panicked`になり（`lib.rs`側でHTTP 500に変換される）、
    /// (b) その後も同じ`CopcState`（同じプール）で別のノードを読めること
    /// （プールが縮んだまま・壊れたままにならない）。
    ///
    /// panicの起こし方: `read_node_bytes`本体に仕込んだ`PANIC_ON_NEXT_READ`
    /// （このファイル上部、`#[cfg(test)]`限定）を立てる。実際のLAZ伸長より前に
    /// 必ずpanicするので、`CopcFile`側やpcv-core側には一切手を加えていない。
    #[test]
    fn read_node_bytes_recovers_pool_after_panic_during_read() {
        let (_dir, path) = synthetic_copc_file();
        let state = CopcState::default();
        let pool = CopcPool::open_path(&path, default_pool_size()).unwrap();
        let response = open_copc_impl(pool, path.to_str().unwrap(), &state).unwrap();
        let key = NodeKey::from_str(&response.nodes[0].key).unwrap();

        // (a) 次の1回だけpanicさせる。
        PANIC_ON_NEXT_READ.with(|flag| flag.set(true));
        let err = read_node_bytes(&state, key).unwrap_err();
        match &err {
            ReadNodeError::Panicked(message) => {
                assert!(
                    message.contains(&key.to_string()),
                    "パニックメッセージにノードキーが含まれるべき: {message}"
                );
            }
            ReadNodeError::Normal(message) => {
                panic!("Panickedになるはずが Normal だった: {message}")
            }
        }
        // フラグは`read_node_bytes`内で読んだ時点でfalseに戻る（一回限り）ので、
        // ここでも明示的に確認しておく（次のアサーションが偶然通っただけ、を防ぐ）。
        assert!(!PANIC_ON_NEXT_READ.with(|flag| flag.get()));

        // (b) 同じCopcStateで、全ノードを問題なく読めること
        // （panicしたリーダーがプールに残らず、かつプールが縮んでいないこと）。
        for node in &response.nodes {
            let node_key = NodeKey::from_str(&node.key).unwrap();
            let bytes = read_node_bytes(&state, node_key).unwrap();
            assert_eq!(&bytes[0..4], pcv_core::MAGIC);
        }
    }
}
