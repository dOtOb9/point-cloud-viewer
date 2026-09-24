//! M4-3: 拡張子だけでなく、ヘッダーの中身(COPC info VLRの有無)でCOPCかどうかを
//! 判定する。
//!
//! 理由: `.laz`という拡張子だけでは、生LAZかCOPCかを区別できない。
//! `.copc.laz`という命名慣習に頼ると、慣習を守らない・リネームされたファイルを
//! 誤判定する。COPC仕様は「COPC info VLRを持つ」ことがCOPCの必要条件なので、
//! それを直接見るのが確実(受け入れ条件どおり)。
//!
//! COPC仕様は本来「COPC info VLRはファイル中の最初のVLR」とも定めているが、
//! ここでは「(どの位置であれ)COPC info VLRを持っているか」を見る、やや緩い
//! 判定にした。仕様違反の並びを弾けない代わりに、実装を単純に保てる
//! (拡張子だけの判定よりは確実に改善している)。

use std::io;
use std::path::Path;

const COPC_INFO_USER_ID: &str = "copc";
const COPC_INFO_RECORD_ID: u16 = 1;

/// LAS/LAZ(COPCも含む)のヘッダーを読み、COPC info VLRを持つかどうかを返す。
/// ヘッダーだけを読む(`las::Reader::from_path`は点データを読まない)ので、
/// ファイルサイズに関わらず軽い処理。
pub fn is_copc_file(path: &Path) -> io::Result<bool> {
    let reader = las::Reader::from_path(path)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e.to_string()))?;
    Ok(reader
        .header()
        .vlrs()
        .iter()
        .any(|vlr| vlr.user_id == COPC_INFO_USER_ID && vlr.record_id == COPC_INFO_RECORD_ID))
}

#[cfg(test)]
mod tests {
    use super::*;
    use copc_writer::{
        write_source, CopcPointFields, CopcPointSource, CopcWriteMetadata, CopcWriterParams,
    };

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

    fn write_synthetic_copc(path: &Path) {
        let points = vec![CopcPointFields {
            x: 500_000.0,
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
        }];
        let bounds = copc_core::Bounds::point(points[0].x, points[0].y, points[0].z);
        let source = SyntheticSource { points };
        write_source(
            path,
            &source,
            false,
            bounds,
            &CopcWriterParams::new(64),
            &CopcWriteMetadata::default(),
        )
        .expect("テスト用COPCの書き出しに失敗");
    }

    fn write_plain_las(path: &Path) {
        let header = las::Builder::from((1, 2))
            .into_header()
            .expect("valid header");
        let mut writer = las::Writer::from_path(path, header).expect("LAS writerの作成に失敗");
        // 既定のscale(0.001)だと座標/scaleがi32に収まる範囲(だいたい±2.1e6m)に
        // 収める必要がある。実在の座標系の値である必要は無いテストデータなので、
        // 小さい値にする(大きい座標を使うと`InvalidInverseTransform`になる)。
        let point = las::Point {
            x: 100.0,
            y: 200.0,
            z: 10.0,
            ..Default::default()
        };
        writer.write_point(point).expect("点の書き込みに失敗");
        writer.close().expect("LAS writerのクローズに失敗");
    }

    #[test]
    fn detects_synthetic_copc_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("synthetic.copc.laz");
        write_synthetic_copc(&path);

        assert!(is_copc_file(&path).unwrap());
    }

    #[test]
    fn plain_las_is_not_copc() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("plain.las");
        write_plain_las(&path);

        assert!(!is_copc_file(&path).unwrap());
    }

    #[test]
    fn extension_alone_does_not_determine_the_answer() {
        // 受け入れ条件の核心: 拡張子が".copc.laz"であっても、中身が生LAZなら
        // falseになる(逆に言えば、この関数は拡張子を一切見ていない)。
        let dir = tempfile::tempdir().unwrap();
        let misnamed = dir.path().join("misnamed.copc.laz");
        write_plain_las(&misnamed);

        assert!(!is_copc_file(&misnamed).unwrap());
    }
}
