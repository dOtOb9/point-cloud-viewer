//! M4-6b: 元のLASヘッダーから`copc_writer::CopcWriteMetadata`を組み立てる。
//!
//! デスクトップ版(`crates/pcv-convert/src/write_metadata.rs`)と役割は同じだが、
//! **意図的に簡略化してある**。デスクトップ版の
//! `resolved_wkt_crs_for_header`(`crates/pcv-convert/src/crs_override.rs`)は
//! 「WKTがあればそれを使う」に加え「GeoTIFFキーだけならpcv-coreの座標系表
//! (M4-5、平面直角座標系19系・UTM)からWKTを合成する」処理まで持つが、
//! これを持ち込むには`pcv-wasm`が`pcv_core::crs`に依存する必要があり
//! (依存自体は問題ない。`pcv-core`はwasm32でビルドできる、規約1)、
//! M4-6bの受け入れ条件(OPFSでの変換経路)には含まれていないため、
//! **範囲を絞った**。
//!
//! **したがって、Web版はWKTのCRS VLRを持つ入力はそのまま引き継ぐが、
//! GeoTIFFキーだけの入力はCRSが失われる**(変換自体は失敗しない。
//! `write_copc_from_spill_with_fs`が呼ぶ検証は`validate_streaming_layout_supported`
//! であり、デスクトップ版の一括関数が使う`validate_las_conversion_supported`
//! (GeoTIFFのみの入力を`Error::Unsupported`で拒否する)とは別の、より緩い
//! 検証であることをソースで確認済み)。この制約は
//! `TaskSheets/ADR-0006-conversion-strategy.md`のWeb版の節に記録する。

use copc_writer::CopcWriteMetadata;

/// 元のLASヘッダーから、変換に必要な最小限のメタデータを引き継ぐ。
/// WKTのCRS VLRがあればそのまま使う。GeoTIFFキーだけの場合はCRSを持たない
/// (モジュールドキュメント参照)。
pub fn copc_write_metadata_from_source_header(header: &las::Header) -> CopcWriteMetadata {
    let transforms = header.transforms();
    let creation_date = header.date().map(|date| {
        let year = date.format("%Y").to_string().parse().unwrap_or(0);
        let day = date.format("%j").to_string().parse().unwrap_or(0);
        (day, year)
    });

    let mut metadata = CopcWriteMetadata::default();
    metadata.wkt_crs = header.get_wkt_crs_bytes().map(decode_wkt_bytes);
    metadata.file_source_id = header.file_source_id();
    metadata.guid = *header.guid().as_bytes();
    metadata.creation_date = creation_date;
    metadata.gps_standard_time = header.gps_time_type().is_standard();
    metadata.scale = Some((transforms.x.scale, transforms.y.scale, transforms.z.scale));
    metadata.offset = Some((
        transforms.x.offset,
        transforms.y.offset,
        transforms.z.offset,
    ));
    metadata
}

/// WKTのVLRデータはヌル終端されていることがある(`crates/pcv-convert/src/
/// crs_override.rs`の`decode_wkt_bytes`と同じ処理。デスクトップ版と揃えた)。
fn decode_wkt_bytes(bytes: &[u8]) -> String {
    let trimmed = bytes.split(|&b| b == 0).next().unwrap_or(bytes);
    String::from_utf8_lossy(trimmed).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn carries_scale_offset_and_identifiers_from_source_header() {
        let mut builder = las::Builder::from((1, 4));
        builder.transforms = las::Vector {
            x: las::Transform {
                scale: 0.01,
                offset: 100.0,
            },
            y: las::Transform {
                scale: 0.01,
                offset: 200.0,
            },
            z: las::Transform {
                scale: 0.001,
                offset: 0.0,
            },
        };
        builder.file_source_id = 42;
        let header = builder.into_header().expect("valid header");

        let metadata = copc_write_metadata_from_source_header(&header);

        assert_eq!(metadata.file_source_id, 42);
        assert_eq!(metadata.scale, Some((0.01, 0.01, 0.001)));
        assert_eq!(metadata.offset, Some((100.0, 200.0, 0.0)));
    }

    #[test]
    fn header_without_crs_has_no_wkt_override() {
        let header = las::Builder::from((1, 4))
            .into_header()
            .expect("valid header");
        let metadata = copc_write_metadata_from_source_header(&header);
        assert!(metadata.wkt_crs.is_none());
    }
}
