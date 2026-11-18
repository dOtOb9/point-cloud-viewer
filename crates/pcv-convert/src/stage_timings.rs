use std::time::Duration;

use copc_writer::{IngestStageTimings, PostProcessStageTimings};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ConversionStageTimings {
    pub source_read_and_decode: Duration,
    pub spill_write: Duration,
    pub lod_index_build: Duration,
    pub node_compression: Duration,
    pub header_and_hierarchy_write: Duration,
}

impl ConversionStageTimings {
    pub fn from_parts(ingest: IngestStageTimings, post: PostProcessStageTimings) -> Self {
        Self {
            source_read_and_decode: ingest.source_read_and_decode,
            spill_write: ingest.spill_write,
            lod_index_build: post.lod_index_build,
            node_compression: post.node_compression,
            header_and_hierarchy_write: post.header_and_hierarchy_write,
        }
    }

    pub fn total(&self) -> Duration {
        self.source_read_and_decode
            + self.spill_write
            + self.lod_index_build
            + self.node_compression
            + self.header_and_hierarchy_write
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn from_parts_copies_each_field_independently() {
        let ingest = IngestStageTimings {
            source_read_and_decode: Duration::from_millis(10),
            spill_write: Duration::from_millis(20),
        };
        let post = PostProcessStageTimings {
            lod_index_build: Duration::from_millis(30),
            node_compression: Duration::from_millis(40),
            header_and_hierarchy_write: Duration::from_millis(5),
        };
        let combined = ConversionStageTimings::from_parts(ingest, post);
        assert_eq!(combined.source_read_and_decode, Duration::from_millis(10));
        assert_eq!(combined.spill_write, Duration::from_millis(20));
        assert_eq!(combined.lod_index_build, Duration::from_millis(30));
        assert_eq!(combined.node_compression, Duration::from_millis(40));
        assert_eq!(
            combined.header_and_hierarchy_write,
            Duration::from_millis(5)
        );
        assert_eq!(combined.total(), Duration::from_millis(105));
    }

    #[test]
    fn default_is_all_zero() {
        assert_eq!(ConversionStageTimings::default().total(), Duration::ZERO);
    }
}
