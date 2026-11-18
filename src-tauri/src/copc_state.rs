use std::collections::HashMap;
use std::io::BufReader;
use std::panic::AssertUnwindSafe;
use std::path::Path;
use std::str::FromStr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};

use pcv_core::{CloudInfo, CopcFile, HierarchyNode, NodeKey};
use tauri::{AppHandle, Runtime, State};
use tauri_plugin_fs::{FilePath, FsExt, OpenOptions};

fn default_pool_size() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
}

pub(crate) struct CopcPool {
    idle: Mutex<Vec<CopcFile>>,
    available: Condvar,
    pool_size: usize,
    open_one: Box<dyn Fn() -> Result<CopcFile, String> + Send + Sync>,
}

impl CopcPool {
    fn open_path(path: &Path, pool_size: usize) -> Result<Self, String> {
        let path = path.to_path_buf();
        Self::build(pool_size, move || {
            CopcFile::open(&path).map_err(|e| e.to_string())
        })
    }

    fn open_uri<R: Runtime>(
        app: &AppHandle<R>,
        uri: &str,
        pool_size: usize,
    ) -> Result<Self, String> {
        let app = app.clone();
        let uri = uri.to_string();
        Self::build(pool_size, move || open_uri_reader(&app, &uri))
    }

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

type OpenedFiles = HashMap<u64, Arc<CopcPool>>;

#[derive(Default)]
pub struct CopcState {
    opened: Mutex<OpenedFiles>,
    next_generation: AtomicU64,
}

impl CopcState {
    fn lock_opened(&self) -> Result<MutexGuard<'_, OpenedFiles>, String> {
        self.opened
            .lock()
            .map_err(|_| "CopcState mutex poisoned".to_string())
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct CloudInfoDto {
    pub point_count: u64,
    pub min: [f64; 3],
    pub max: [f64; 3],
    pub scale: [f64; 3],
    pub offset: [f64; 3],
    pub has_color: bool,
    pub crs: CrsInfoDto,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct CrsInfoDto {
    pub epsg: Option<u32>,
    pub name: String,
    pub kind: &'static str,
    pub error: Option<String>,
    pub horizontal_unit_to_meter: Option<f64>,
    pub vertical_unit_to_meter: Option<f64>,
}

impl From<&pcv_core::crs::CrsInfo> for CrsInfoDto {
    fn from(crs: &pcv_core::crs::CrsInfo) -> Self {
        Self {
            epsg: crs.epsg,
            name: crs.name.clone(),
            kind: crs.kind.as_str(),
            error: crs.error.clone(),
            horizontal_unit_to_meter: crs.horizontal_unit_to_meter,
            vertical_unit_to_meter: crs.vertical_unit_to_meter,
        }
    }
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
            crs: CrsInfoDto::from(&info.crs),
        }
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct HierarchyNodeDto {
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
    pub generation: u64,
}

#[tauri::command]
pub fn open_copc(
    app: AppHandle,
    path: String,
    state: State<CopcState>,
) -> Result<OpenCopcResponse, String> {
    let pool_size = default_pool_size();
    let pool =
        match FilePath::from_str(&path).unwrap_or_else(|e: std::convert::Infallible| match e {}) {
            FilePath::Path(p) => CopcPool::open_path(&p, pool_size)?,
            FilePath::Url(_) => CopcPool::open_uri(&app, &path, pool_size)?,
        };
    open_copc_impl(pool, &path, &state)
}

fn open_copc_impl(
    pool: CopcPool,
    path: &str,
    state: &CopcState,
) -> Result<OpenCopcResponse, String> {
    let file = pool.checkout();
    let info = CloudInfoDto::from(file.info());
    let nodes: Vec<HierarchyNodeDto> = file
        .hierarchy()
        .nodes()
        .map(HierarchyNodeDto::from)
        .collect();
    pool.checkin(file);

    let generation = state.next_generation.fetch_add(1, Ordering::SeqCst);

    println!(
        "[pcv] opened {path}: {} points, {} nodes (reader pool size {}, generation {generation})",
        info.point_count,
        nodes.len(),
        pool.pool_size
    );

    state.lock_opened()?.insert(generation, Arc::new(pool));

    Ok(OpenCopcResponse {
        info,
        nodes,
        generation,
    })
}

#[derive(Debug)]
pub enum ReadNodeError {
    Normal(String),
    Panicked(String),
    Stale,
}

fn panic_payload_message(payload: Box<dyn std::any::Any + Send>) -> String {
    if let Some(s) = payload.downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        "詳細不明のpanic（&str/String以外のpayload）".to_string()
    }
}

#[tauri::command]
pub async fn read_section_profile(
    generation: u64,
    line: pcv_core::profile::SectionLine,
    cap: Option<u32>,
    state: State<'_, CopcState>,
) -> Result<tauri::ipc::Response, String> {
    let pool = state
        .lock_opened()?
        .get(&generation)
        .cloned()
        .ok_or_else(|| "断面のレイヤーが閉じられています".to_string())?;
    let cap = cap.map_or(0, |c| c as usize);
    let joined = tauri::async_runtime::spawn_blocking(move || {
        let mut file = pool.checkout();
        let result = std::panic::catch_unwind(AssertUnwindSafe(|| {
            pcv_core::profile::read_section_profile(&mut file, &line, cap)
        }));
        match result {
            Ok(read) => {
                pool.checkin(file);
                read.map_err(|e| e.to_string())
            }
            Err(payload) => {
                pool.replenish_after_panic();
                Err(format!(
                    "断面の読み出し中にpanicが発生した: {}",
                    panic_payload_message(payload)
                ))
            }
        }
    })
    .await;
    match joined {
        Ok(Ok(bytes)) => Ok(tauri::ipc::Response::new(bytes)),
        Ok(Err(message)) => Err(message),
        Err(e) => Err(format!("断面の読み出しを実行できなかった: {e}")),
    }
}

impl CopcState {
    pub(crate) fn pool_of(&self, generation: u64) -> Result<Arc<CopcPool>, String> {
        self.lock_opened()?
            .get(&generation)
            .cloned()
            .ok_or_else(|| "断面線の元になるレイヤーが閉じられています".to_string())
    }
}

impl CopcPool {
    pub(crate) fn run_with_file<T>(
        &self,
        work: impl FnOnce(&mut CopcFile) -> T,
    ) -> Result<T, String> {
        let mut file = self.checkout();
        match std::panic::catch_unwind(AssertUnwindSafe(|| work(&mut file))) {
            Ok(value) => {
                self.checkin(file);
                Ok(value)
            }
            Err(payload) => {
                self.replenish_after_panic();
                Err(format!(
                    "処理中にpanicが発生した: {}",
                    panic_payload_message(payload)
                ))
            }
        }
    }
}

#[cfg(test)]
thread_local! {
    static PANIC_ON_NEXT_READ: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

#[tauri::command]
pub fn close_copc(generation: u64, state: State<CopcState>) -> Result<(), String> {
    close_copc_impl(generation, &state)
}

fn close_copc_impl(generation: u64, state: &CopcState) -> Result<(), String> {
    let removed = state.lock_opened()?.remove(&generation);
    if removed.is_some() {
        println!("[pcv] closed generation {generation}");
    }
    Ok(())
}

pub fn read_node_bytes(
    state: &CopcState,
    requested_generation: u64,
    key: NodeKey,
) -> Result<Vec<u8>, ReadNodeError> {
    let pool = {
        let guard = state.lock_opened().map_err(ReadNodeError::Normal)?;
        guard
            .get(&requested_generation)
            .cloned()
            .ok_or(ReadNodeError::Stale)?
    };

    let mut file = pool.checkout();
    let result = std::panic::catch_unwind(AssertUnwindSafe(|| {
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
        assert_eq!(response.info.crs.kind, "none");
        assert_eq!(response.info.crs.epsg, None);
        assert!(!response.nodes.is_empty());
        assert!(state
            .opened
            .lock()
            .unwrap()
            .contains_key(&response.generation));
    }

    #[test]
    fn copc_pool_open_path_builds_pool_with_requested_size() {
        let (_dir, path) = synthetic_copc_file();
        let pool_size = 3;

        let pool = CopcPool::open_path(&path, pool_size).unwrap();

        assert_eq!(pool.pool_size, pool_size);
        let mut file = pool.checkout();
        assert_eq!(file.info().point_count, 500);
        let root = *file.hierarchy().nodes().next().unwrap();
        assert!(file.read_node(root.key).is_ok());
        pool.checkin(file);
    }

    #[test]
    fn independently_opened_file_handles_have_independent_seek_positions() {
        use std::fs::File;
        use std::io::{Read, Seek, SeekFrom};

        let dir = tempfile::tempdir().expect("tempdir作成に失敗");
        let path = dir.path().join("independent-seek.bin");
        std::fs::write(&path, b"0123456789").expect("テストファイルの書き込みに失敗");

        let mut original = File::open(&path).unwrap();
        let mut cloned = original.try_clone().unwrap();
        let mut buf = [0u8; 4];
        original.read_exact(&mut buf).unwrap();
        let mut buf2 = [0u8; 4];
        cloned.read_exact(&mut buf2).unwrap();
        assert_eq!(&buf2, b"4567", "try_clone()はシーク位置を共有するはず");

        let mut reader_a = File::open(&path).unwrap();
        let mut reader_b = File::open(&path).unwrap();
        reader_a.seek(SeekFrom::Start(6)).unwrap();
        let mut a_buf = [0u8; 4];
        reader_a.read_exact(&mut a_buf).unwrap();
        assert_eq!(&a_buf, b"6789");

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
        let bytes = read_node_bytes(&state, response.generation, key).unwrap();

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
    fn read_node_bytes_is_stale_before_any_file_is_open() {
        let state = CopcState::default();
        let err = read_node_bytes(&state, 0, NodeKey::root()).unwrap_err();
        assert!(matches!(err, ReadNodeError::Stale), "{err:?}");
    }

    #[test]
    fn two_files_open_at_once_and_close_independently() {
        let (_dir, path) = synthetic_copc_file();
        let state = CopcState::default();
        let open = || {
            let pool = CopcPool::open_path(&path, default_pool_size()).unwrap();
            open_copc_impl(pool, path.to_str().unwrap(), &state).unwrap()
        };
        let a = open();
        let b = open();
        assert_ne!(a.generation, b.generation);
        let key = NodeKey::from_str(&a.nodes[0].key).unwrap();

        assert!(read_node_bytes(&state, a.generation, key).is_ok());
        assert!(read_node_bytes(&state, b.generation, key).is_ok());

        close_copc_impl(a.generation, &state).unwrap();
        assert!(matches!(
            read_node_bytes(&state, a.generation, key),
            Err(ReadNodeError::Stale)
        ));
        assert!(read_node_bytes(&state, b.generation, key).is_ok());
        close_copc_impl(a.generation, &state).unwrap();
        assert_eq!(state.opened.lock().unwrap().len(), 1);
    }

    #[test]
    fn read_node_bytes_rejects_stale_generation_after_reopen() {
        let (_dir, path) = synthetic_copc_file();
        let state = CopcState::default();

        let pool1 = CopcPool::open_path(&path, default_pool_size()).unwrap();
        let response1 = open_copc_impl(pool1, path.to_str().unwrap(), &state).unwrap();
        let key = NodeKey::from_str(&response1.nodes[0].key).unwrap();

        let pool2 = CopcPool::open_path(&path, default_pool_size()).unwrap();
        let response2 = open_copc_impl(pool2, path.to_str().unwrap(), &state).unwrap();
        assert_ne!(
            response1.generation, response2.generation,
            "開き直すたびに世代が進むこと"
        );

        close_copc_impl(response1.generation, &state).unwrap();
        let err = read_node_bytes(&state, response1.generation, key).unwrap_err();
        match err {
            ReadNodeError::Stale => {}
            other => panic!("Staleになるはずが別の結果だった: {other:?}"),
        }

        let bytes = read_node_bytes(&state, response2.generation, key).unwrap();
        assert_eq!(&bytes[0..4], pcv_core::MAGIC);
    }

    #[test]
    fn read_node_bytes_recovers_pool_after_panic_during_read() {
        let (_dir, path) = synthetic_copc_file();
        let state = CopcState::default();
        let pool = CopcPool::open_path(&path, default_pool_size()).unwrap();
        let response = open_copc_impl(pool, path.to_str().unwrap(), &state).unwrap();
        let key = NodeKey::from_str(&response.nodes[0].key).unwrap();

        PANIC_ON_NEXT_READ.with(|flag| flag.set(true));
        let err = read_node_bytes(&state, response.generation, key).unwrap_err();
        match &err {
            ReadNodeError::Panicked(message) => {
                assert!(
                    message.contains(&key.to_string()),
                    "パニックメッセージにノードキーが含まれるべき: {message}"
                );
            }
            other => panic!("Panickedになるはずが別の結果だった: {other:?}"),
        }
        assert!(!PANIC_ON_NEXT_READ.with(|flag| flag.get()));

        for node in &response.nodes {
            let node_key = NodeKey::from_str(&node.key).unwrap();
            let bytes = read_node_bytes(&state, response.generation, node_key).unwrap();
            assert_eq!(&bytes[0..4], pcv_core::MAGIC);
        }
    }
}
