//! M4-3: 元のLASヘッダーから`copc_writer::CopcWriteMetadata`を組み立てる。
//!
//! # なぜ自分で組み立てるか
//!
//! `streaming.rs`のドキュメントに書いたとおり、Android対応のため
//! `copc-writer`の低水準API`write_streaming_with_cancel`を使う方針に変えた。
//! この関数は`copc_writer::CopcWriteMetadata`(公開されている簡易な構造体)を
//! 要求する。一括関数`convert_las_to_copc_streaming_with_crs_wkt_override`が
//! 内部で使う`OutputLasMetadata`(非公開)は、これに加えて元ファイルの
//! 任意のVLR/EVLRのパススルーや、synthetic return numbersのglobal encoding
//! ビットまで面倒を見るが、`CopcWriteMetadata`にはその口が無い。
//!
//! **したがって、任意のVLR/EVLRのパススルーは行われない。** 実害の判断:
//! 本アプリの着色モード(`ARCHITECTURE.md`の現在の状態表、M2-2)が使う属性は
//! xyz・強度・分類・RGBの4つだけで、`crates/pcv-convert/src/point.rs`の
//! コメントが記す方針(GPS時刻以外の詳細な取得情報は運ばない)とも一致するため、
//! 許容できると判断した。CRS(WKT)だけは`crs_override`モジュールで個別に
//! 手当てする(位置情報は計測用途に直結するため、他の属性と同列に扱わない)。

use copc_writer::CopcWriteMetadata;

use crate::crs_override::resolved_wkt_crs_for_header;

/// 元のLASヘッダーから、変換に必要な最小限のメタデータを引き継ぐ。
pub fn copc_write_metadata_from_source_header(header: &las::Header) -> CopcWriteMetadata {
    let transforms = header.transforms();
    let creation_date = header.date().map(|date| {
        // `OutputLasMetadata::from_las_header`(copc-writerの非公開実装)と
        // 同じ形式(day_of_year, year)に変換する。
        let year = date.format("%Y").to_string().parse().unwrap_or(0);
        let day = date.format("%j").to_string().parse().unwrap_or(0);
        (day, year)
    });

    // `CopcWriteMetadata`は`#[non_exhaustive]`のため、クレート外からは構造体
    // リテラル(`..Default::default()`込みでも)を書けない。`default()`を作って
    // フィールドを個別に代入する。
    let mut metadata = CopcWriteMetadata::default();
    metadata.wkt_crs = resolved_wkt_crs_for_header(header);
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
