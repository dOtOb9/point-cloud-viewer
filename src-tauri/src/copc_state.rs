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

use std::path::Path;
use std::sync::{Arc, Condvar, Mutex};

use pcv_core::{CloudInfo, CopcFile, HierarchyNode, NodeKey};
use tauri::State;

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
}

impl CopcPool {
    fn open(path: &Path, pool_size: usize) -> Result<Self, String> {
        let pool_size = pool_size.max(1);
        let mut idle = Vec::with_capacity(pool_size);
        for _ in 0..pool_size {
            idle.push(CopcFile::open(path).map_err(|e| e.to_string())?);
        }
        Ok(Self {
            idle: Mutex::new(idle),
            available: Condvar::new(),
            pool_size,
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
#[tauri::command]
pub fn open_copc(
    path: String,
    pool_size: Option<usize>,
    state: State<CopcState>,
) -> Result<OpenCopcResponse, String> {
    open_copc_impl(&path, pool_size, &state)
}

/// `open_copc`の中身。`tauri::State`を経由しない素の関数にしておくと、
/// テストで実際のTauriランタイムを起動せずに検証できる。
fn open_copc_impl(
    path: &str,
    pool_size: Option<usize>,
    state: &CopcState,
) -> Result<OpenCopcResponse, String> {
    let pool_size = pool_size.unwrap_or_else(default_pool_size);
    let pool = CopcPool::open(Path::new(path), pool_size)?;

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

/// `handle_pcv_protocol` から呼ばれる、実際のノード読み出し。
///
/// `CopcState`のロックは`Arc<CopcPool>`を複製する一瞬だけ持ち、すぐ手放す。
/// 実際のディスクI/O・LAZ伸長（`pool.checkout()`で借りた`CopcFile`に対する
/// `read_node`）はロックの外で行うため、複数リクエストが同時にここへ来ても
/// `CopcState`のロックでは直列化しない（直列化の可能性が残るのは`CopcPool`
/// 自体のプールサイズだけ。`default_pool_size()`のドキュメント参照）。
pub fn read_node_bytes(state: &CopcState, key: NodeKey) -> Result<Vec<u8>, String> {
    let pool = {
        let guard = state.0.lock().expect("CopcState mutex poisoned");
        guard
            .as_ref()
            .ok_or_else(|| "no COPC file is open (call open_copc first)".to_string())?
            .clone()
    };

    let mut file = pool.checkout();
    let result = file.read_node(key);
    pool.checkin(file);

    let buf = result.map_err(|e| e.to_string())?;
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

        let response = open_copc_impl(path.to_str().unwrap(), None, &state).unwrap();

        assert_eq!(response.info.point_count, 500);
        assert!(!response.nodes.is_empty());
        assert!(state.0.lock().unwrap().is_some());
    }

    #[test]
    fn read_node_bytes_matches_m1_2_wire_format() {
        let (_dir, path) = synthetic_copc_file();
        let state = CopcState::default();
        let response = open_copc_impl(path.to_str().unwrap(), None, &state).unwrap();

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
        assert!(err.contains("no COPC file is open"));
    }
}
