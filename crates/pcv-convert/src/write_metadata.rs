use copc_writer::CopcWriteMetadata;

use crate::crs_override::resolved_wkt_crs_for_header;

pub fn copc_write_metadata_from_source_header(header: &las::Header) -> CopcWriteMetadata {
    let transforms = header.transforms();
    let creation_date = header.date().map(|date| {
        let year = date.format("%Y").to_string().parse().unwrap_or(0);
        let day = date.format("%j").to_string().parse().unwrap_or(0);
        (day, year)
    });

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
