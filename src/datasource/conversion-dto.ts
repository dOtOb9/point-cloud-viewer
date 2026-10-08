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

// M4-6b: "opfsUnavailable"はWeb版だけの追加(Rust側のConversionOutcomeには無い)。
// OPFSが使えないブラウザ(FileSystemSyncAccessHandle未対応の旧Safari等)で
// 生LAS/LAZを開こうとしたときに返す。`WebSource.startConversion`だけが
// この値を作る(`toConversionOutcome`のDTO変換は通らない、Web側で直接組み立てる値)。
//
// M4-6追記: "insufficientSpaceWeb"も同じくWeb版だけの追加。デスクトップ版の
// "insufficientSpace"(`requiredBytes`/`availableBytes`のみ、`available`はOSの
// 実際の空きディスク容量)とは中身が違う。Web版はOPFSの`quota`/`usage`
// (ブラウザが割り当てた上限と、その中の使用中の量。ディスクの実際の空きとは別物)
// を分けて持ち、さらに永続化の状態・OPFS内の消せる量(キャッシュ+一時ファイル)も
// 持つ(受け入れ条件「必要・空き・上限・使用中を分けて出す」「空ける方法を示す」)。
// `useCopcViewer.ts`が`opfs.describeInsufficientSpaceWeb`で文言化する。
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

/**
 * M4-11(`TaskSheets/M4-import-and-conversion.md`): Web版の「準備」段階の
 * 各ステップ。所有者の実機(スマホ)で変換が「準備しています…」のまま止まり
 * タブが落ちる不具合の調査のため、準備の各ステップを画面に出せるようにする
 * (次に落ちたとき、どこで止まったか所有者が報告できるようにするのが目的)。
 * デスクトップ・Android(Rust側`src-tauri/src/conversion.rs`)はこの段階を
 * 送らない(準備が軽いため)。Web版(`src/datasource/copc.worker.ts`)だけが
 * 送る、Web版だけの拡張。
 */
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

/** `ConversionProgressEvent`(Rust)のJSON表現。`preparing`はWeb版だけが送る
 *  (上記`PreparingStepDto`参照)。 */
export type ConversionProgressDto =
  | { phase: "preparing"; preparing: PreparingStepDto }
  | { phase: "reading"; points_read: number; total_points: number; elapsed_secs: number }
  | { phase: "post_processing"; elapsed_secs: number };

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
