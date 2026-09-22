//! 現在開いているCOPCファイルのアプリ状態と、それを操作する制御コマンド。
//!
//! ADR-0001の規約通り、ここは「どのファイルを開くか」という制御メッセージだけを
//! `invoke` で扱う。ノードの点データそのものは `pcv://` 経由で流す（`lib.rs` の
//! `handle_pcv_protocol` 参照）。重い処理（COPCのパース・octree走査）は
//! `pcv-core` に任せ、ここはTauriとの橋渡しだけをする。

use std::path::Path;
use std::sync::Mutex;

use pcv_core::{CloudInfo, CopcFile, HierarchyNode, NodeKey};
use tauri::State;

/// 現在開いているCOPCファイル。同時に1つしか開けない前提（M1時点ではタブ等は無い）。
#[derive(Default)]
pub struct CopcState(pub Mutex<Option<CopcFile>>);

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
#[tauri::command]
pub fn open_copc(path: String, state: State<CopcState>) -> Result<OpenCopcResponse, String> {
    open_copc_impl(&path, &state)
}

/// `open_copc`の中身。`tauri::State`を経由しない素の関数にしておくと、
/// テストで実際のTauriランタイムを起動せずに検証できる。
fn open_copc_impl(path: &str, state: &CopcState) -> Result<OpenCopcResponse, String> {
    let file = CopcFile::open(Path::new(path)).map_err(|e| e.to_string())?;

    let info = CloudInfoDto::from(file.info());
    let nodes: Vec<HierarchyNodeDto> = file
        .hierarchy()
        .nodes()
        .map(HierarchyNodeDto::from)
        .collect();

    println!(
        "[pcv] opened {path}: {} points, {} nodes",
        info.point_count,
        nodes.len()
    );

    *state.0.lock().expect("CopcState mutex poisoned") = Some(file);

    Ok(OpenCopcResponse { info, nodes })
}

/// `handle_pcv_protocol` から呼ばれる、実際のノード読み出し。
/// ロック取得とエラーメッセージ整形をここに集約する。
pub fn read_node_bytes(state: &CopcState, key: NodeKey) -> Result<Vec<u8>, String> {
    let mut guard = state.0.lock().expect("CopcState mutex poisoned");
    let file = guard
        .as_mut()
        .ok_or_else(|| "no COPC file is open (call open_copc first)".to_string())?;
    let buf = file.read_node(key).map_err(|e| e.to_string())?;
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

        let response = open_copc_impl(path.to_str().unwrap(), &state).unwrap();

        assert_eq!(response.info.point_count, 500);
        assert!(!response.nodes.is_empty());
        assert!(state.0.lock().unwrap().is_some());
    }

    #[test]
    fn read_node_bytes_matches_m1_2_wire_format() {
        let (_dir, path) = synthetic_copc_file();
        let state = CopcState::default();
        let response = open_copc_impl(path.to_str().unwrap(), &state).unwrap();

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
