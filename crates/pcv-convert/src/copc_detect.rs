use std::io::{self, Read, Seek};
use std::path::Path;

const COPC_INFO_USER_ID: &str = "copc";
const COPC_INFO_RECORD_ID: u16 = 1;

pub fn is_copc_file(path: &Path) -> io::Result<bool> {
    let reader = las::Reader::from_path(path)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e.to_string()))?;
    Ok(is_copc_header(reader.header()))
}

pub fn is_copc_reader<R: Read + Seek + Send + Sync + 'static>(reader: R) -> io::Result<bool> {
    let reader = las::Reader::new(reader)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e.to_string()))?;
    Ok(is_copc_header(reader.header()))
}

fn is_copc_header(header: &las::Header) -> bool {
    header
        .vlrs()
        .iter()
        .any(|vlr| vlr.user_id == COPC_INFO_USER_ID && vlr.record_id == COPC_INFO_RECORD_ID)
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
        let dir = tempfile::tempdir().unwrap();
        let misnamed = dir.path().join("misnamed.copc.laz");
        write_plain_las(&misnamed);

        assert!(!is_copc_file(&misnamed).unwrap());
    }

    #[test]
    fn is_copc_reader_matches_is_copc_file() {
        let dir = tempfile::tempdir().unwrap();
        let copc_path = dir.path().join("synthetic.copc.laz");
        write_synthetic_copc(&copc_path);
        let las_path = dir.path().join("plain.las");
        write_plain_las(&las_path);

        let copc_file = std::fs::File::open(&copc_path).unwrap();
        assert!(is_copc_reader(copc_file).unwrap());

        let las_file = std::fs::File::open(&las_path).unwrap();
        assert!(!is_copc_reader(las_file).unwrap());
    }
}
