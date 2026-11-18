export type ConversionOutcomeDto =
  | { kind: "already_copc"; path: string }
  | { kind: "cached"; output_path: string }
  | { kind: "insufficient_space"; required_bytes: number; available_bytes: number }
  | { kind: "converting" };

export type ConversionOutcome =
  | { kind: "alreadyCopc"; path: string }
  | { kind: "cached"; outputPath: string }
  | { kind: "insufficientSpace"; requiredBytes: number; availableBytes: number }
  | { kind: "converting" }
  | { kind: "opfsUnavailable" }
  | {
      kind: "insufficientSpaceWeb";
      requiredBytes: number;
      quotaBytes: number;
      usageBytes: number;
      persisted: boolean;
      reclaimableBytes: number;
    };

export function toConversionOutcome(dto: ConversionOutcomeDto): ConversionOutcome {
  switch (dto.kind) {
    case "already_copc":
      return { kind: "alreadyCopc", path: dto.path };
    case "cached":
      return { kind: "cached", outputPath: dto.output_path };
    case "insufficient_space":
      return {
        kind: "insufficientSpace",
        requiredBytes: dto.required_bytes,
        availableBytes: dto.available_bytes,
      };
    case "converting":
      return { kind: "converting" };
  }
}

export type PreparingStepDto =
  | { step: "acquiring_lock" }
  | { step: "cleaning_stale_scratch" }
  | { step: "opening_scratch_files"; opened: number; total: number }
  | { step: "opening_output_file" }
  | { step: "reading_header" }
  | { step: "starting_decompress_workers"; started: number; total: number };

export type PreparingStep =
  | { step: "acquiringLock" }
  | { step: "cleaningStaleScratch" }
  | { step: "openingScratchFiles"; opened: number; total: number }
  | { step: "openingOutputFile" }
  | { step: "readingHeader" }
  | { step: "startingDecompressWorkers"; started: number; total: number };

function toPreparingStep(dto: PreparingStepDto): PreparingStep {
  switch (dto.step) {
    case "acquiring_lock":
      return { step: "acquiringLock" };
    case "cleaning_stale_scratch":
      return { step: "cleaningStaleScratch" };
    case "opening_scratch_files":
      return { step: "openingScratchFiles", opened: dto.opened, total: dto.total };
    case "opening_output_file":
      return { step: "openingOutputFile" };
    case "reading_header":
      return { step: "readingHeader" };
    case "starting_decompress_workers":
      return { step: "startingDecompressWorkers", started: dto.started, total: dto.total };
  }
}

export type ConversionProgressDto =
  | { phase: "preparing"; preparing: PreparingStepDto }
  | { phase: "reading"; points_read: number; total_points: number; elapsed_secs: number }
  | { phase: "post_processing"; elapsed_secs: number };

export interface ConversionStageBreakdownDto {
  source_read_and_decode_secs: number;
  spill_write_secs: number;
  lod_index_build_secs: number;
  node_compression_secs: number;
  header_and_hierarchy_write_secs: number;
  total_secs: number;
  opfs_io_secs: number | null;
  opfs_read_at_calls: number | null;
  opfs_cache_hits: number | null;
  opfs_cache_misses: number | null;
  opfs_bytes_read_from_opfs: number | null;
  opfs_read_secs: number | null;
  opfs_seq_read_calls: number | null;
  opfs_seq_read_secs: number | null;
  point_count: number;
  file_size_bytes: number;
  input_file_count: number;
}

export interface ConversionStageBreakdown {
  sourceReadAndDecodeSecs: number;
  spillWriteSecs: number;
  lodIndexBuildSecs: number;
  nodeCompressionSecs: number;
  headerAndHierarchyWriteSecs: number;
  totalSecs: number;
  opfsIoSecs: number | null;
  opfsReadAtCalls: number | null;
  opfsCacheHits: number | null;
  opfsCacheMisses: number | null;
  opfsBytesReadFromOpfs: number | null;
  opfsReadSecs: number | null;
  opfsSeqReadCalls: number | null;
  opfsSeqReadSecs: number | null;
  pointCount: number;
  fileSizeBytes: number;
  inputFileCount: number;
}

export function toConversionStageBreakdown(
  dto: ConversionStageBreakdownDto,
): ConversionStageBreakdown {
  return {
    sourceReadAndDecodeSecs: dto.source_read_and_decode_secs,
    spillWriteSecs: dto.spill_write_secs,
    lodIndexBuildSecs: dto.lod_index_build_secs,
    nodeCompressionSecs: dto.node_compression_secs,
    headerAndHierarchyWriteSecs: dto.header_and_hierarchy_write_secs,
    totalSecs: dto.total_secs,
    opfsIoSecs: dto.opfs_io_secs,
    opfsReadAtCalls: dto.opfs_read_at_calls,
    opfsCacheHits: dto.opfs_cache_hits,
    opfsCacheMisses: dto.opfs_cache_misses,
    opfsBytesReadFromOpfs: dto.opfs_bytes_read_from_opfs,
    opfsReadSecs: dto.opfs_read_secs,
    opfsSeqReadCalls: dto.opfs_seq_read_calls,
    opfsSeqReadSecs: dto.opfs_seq_read_secs,
    pointCount: dto.point_count,
    fileSizeBytes: dto.file_size_bytes,
    inputFileCount: dto.input_file_count,
  };
}

export type ConversionProgress =
  | { phase: "preparing"; preparing: PreparingStep }
  | { phase: "reading"; pointsRead: number; totalPoints: number; elapsedSecs: number }
  | { phase: "postProcessing"; elapsedSecs: number };

export function toConversionProgress(dto: ConversionProgressDto): ConversionProgress {
  if (dto.phase === "preparing") {
    return { phase: "preparing", preparing: toPreparingStep(dto.preparing) };
  }
  if (dto.phase === "reading") {
    return {
      phase: "reading",
      pointsRead: dto.points_read,
      totalPoints: dto.total_points,
      elapsedSecs: dto.elapsed_secs,
    };
  }
  return { phase: "postProcessing", elapsedSecs: dto.elapsed_secs };
}
