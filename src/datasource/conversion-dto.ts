// M4-3: `src-tauri/src/conversion.rs`が返すJSON(serdeデフォルトのsnake_case、
// enumは`#[serde(tag = "kind"/"phase", rename_all = "snake_case")]`)と、
// TypeScript側camelCaseの型を相互変換する。`copc-dto.ts`と同じ方針
// (フィールド名はRust側のまま受け取り、ここでまとめて変換する)。

/** `ConversionOutcome`(Rust)のJSON表現。 */
export type ConversionOutcomeDto =
  | { kind: "already_copc"; path: string }
  | { kind: "cached"; output_path: string }
  | { kind: "insufficient_space"; required_bytes: number; available_bytes: number }
  | { kind: "converting" };

export type ConversionOutcome =
  | { kind: "alreadyCopc"; path: string }
  | { kind: "cached"; outputPath: string }
  | { kind: "insufficientSpace"; requiredBytes: number; availableBytes: number }
  | { kind: "converting" };

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

/** `ConversionProgressEvent`(Rust)のJSON表現。 */
export type ConversionProgressDto =
  | { phase: "reading"; points_read: number; total_points: number; elapsed_secs: number }
  | { phase: "post_processing"; elapsed_secs: number };

export type ConversionProgress =
  | { phase: "reading"; pointsRead: number; totalPoints: number; elapsedSecs: number }
  | { phase: "postProcessing"; elapsedSecs: number };

export function toConversionProgress(dto: ConversionProgressDto): ConversionProgress {
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
