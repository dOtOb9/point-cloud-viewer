//! 複数のLAS/LAZタイルを1つのCOPCへまとめる。
//!
//! 元は開発者向けCLI(`examples/merge_las_to_copc.rs`)専用のコードだった
//! (`TaskSheets/TOOL-merge-las-to-copc.md`参照)。**M4-14で、デスクトップ/
//! Android(`src-tauri/src/conversion.rs`の`start_multi_las_conversion`)からも
//! 呼ぶようにした。** `pcv-convert`は元々Tauriに依存しない(wasmには載せない)
//! devツール用クレートという位置づけだったが、`src-tauri`は通常のRust依存として
//! `pcv-convert`を使えるため、規約1(`pcv-core`のwasm制約)には抵触しない
//! (`TaskSheets/M4-import-and-conversion.md`のM4-14参照)。CLI(`examples/
//! merge_las_to_copc.rs`)は変更しておらず、引き続き使える。
//!
//! # 設計: なぜ新しいoctree/writerを書かないか
//!
//! `vendor/copc-writer`の低水準API`write_streaming_with_cancel_and_timings`
//! (`crates/pcv-convert/src/streaming.rs`が単一ファイル変換で使っているのと
//! 同じ関数)は、点の`Iterator<Item = copc_core::Result<LasPointRecord>>`を
//! 受け取るだけで、octree分割・LAZ圧縮・COPC hierarchyの組み立てを全部
//! 行う。**複数ファイルをまとめることは、「複数ファイルを順に読んで1本の
//! イテレータにする」だけで実現できる**(`MultiFileLasPoints`)。
//! 新しいoctree・writerのコードは書いていない。
//!
//! `vendor/copc-writer/src/spill.rs`の`SpillWriter::push`を読んで確認した
//! とおり、バウンディングボックスも点数も、プッシュされた点から**その場で**
//! 蓄積される(`SpillWriter::bounds`・`SpillWriter::count`)。つまり
//! 「全点の2回目のパス」は無い。事前にLASヘッダーから集める値(下記の
//! `header_summaries`)は、レイアウトの一致確認と進捗表示の分母(申告点数の
//! 合計)のためだけに使い、書き出しの入力には使わない。
//!
//! # 複数ファイルの前提(所有者の指示どおり)
//!
//! - 全ファイルが同じ`StreamingLayout`(point format・色/GPS/NIR/waveformの
//!   有無・extra bytesの構成)であること。LAZの1チャンク=COPCの1ノードという
//!   対応上、`copc-writer`は1回の書き出しで1つのレイアウトしか扱えない
//!   (`SpillWriter::create`が`layout`を1つだけ受け取る)。違うレイアウトの
//!   ファイルが混じっていたら、`MergeError::LayoutMismatch`で止める。
//! - scale/offsetは一致していなくてもよい。`LasPointRecord::x/y/z`は
//!   `las`クレートが元ファイルのscale/offsetを適用した**実世界座標(f64)**
//!   なので、出力のscale/offsetが元と違っても量子化し直されるだけで、
//!   座標の正しさには影響しない(`vendor/copc-writer/src/spill.rs`の
//!   `push`・`vendor/copc-writer/src/writer.rs`の`quantize_xyz`呼び出しで
//!   確認した)。出力のCRS/scale/offsetは先頭ファイルのヘッダーから組み立てる
//!   (`copc_write_metadata_from_source_header`をそのまま再利用する)。
//!   `merging_with_different_scale_and_offset_keeps_real_world_coordinates`
//!   (本ファイル末尾のテスト)で実際に確認した(M4-14、以前は設計上の見込みに
//!   留まっていた)。
//! - CRSは一致していること。`pcv_core::crs::detect_crs_from_las_header`で
//!   各ファイルのCRSを判定し、先頭ファイルと異なればエラーにする(M4-14で追加。
//!   以前は「出力CRSは先頭ファイルのものを使い、以降は無視する(警告も出さない)」
//!   という弱点があったが、アプリから呼ぶようになった以上、所有者が気付かない
//!   まま違う場所の点群が混ざるのは避けたい)。両方が`Crs::Unknown`
//!   (CRS情報が無い、または対応範囲外)の場合は「一致」として扱う
//!   (無いものを比べて違うと言うのは利用者を混乱させるだけなので)。

use std::collections::VecDeque;
use std::io;
use std::path::{Path, PathBuf};

use copc_core::{CancelCheck, LasPointRecord, StreamingLayout};
use copc_writer::{write_streaming_with_cancel_and_timings, CopcWriteMetadata, CopcWriterParams};
use pcv_core::crs::{detect_crs_from_las_header, Crs};

use crate::stage_timings::ConversionStageTimings;
use crate::streaming::{ReadProgress, PROGRESS_REPORT_STRIDE};
use crate::write_metadata::copc_write_metadata_from_source_header;

#[derive(Debug, thiserror::Error)]
pub enum MergeError {
    #[error("入力ファイルが1つも見つからない: {0}")]
    NoInputFiles(String),
    #[error("ディレクトリを読み取れなかった: {0}")]
    ReadDir(#[source] io::Error),
    #[error("globパターンが不正: {0}")]
    GlobPattern(#[source] glob::PatternError),
    #[error("globの列挙中にエラー: {0}")]
    GlobIter(#[source] glob::GlobError),
    #[error("{path}: LASヘッダーを開けなかった: {source}")]
    OpenHeader {
        path: PathBuf,
        #[source]
        source: las::Error,
    },
    #[error(
        "{path}: 点のレイアウトが先頭ファイル({first})と異なる({got:?} != {expected:?})。\
         このツールは全入力が同じpoint format/属性構成であることを前提にしている"
    )]
    LayoutMismatch {
        path: PathBuf,
        first: PathBuf,
        got: Box<StreamingLayout>,
        expected: Box<StreamingLayout>,
    },
    /// M4-14: CRSが先頭ファイルと異なる入力が混ざっている。`Crs`の`Debug`表示
    /// (`{:?}`)で出す。所有者が座標系の名前(平面直角座標系の系番号・UTMの
    /// ゾーン等)を読み取れる形になっている(`pcv_core::crs`の各構造体の
    /// フィールド名がそのまま出る)。
    #[error(
        "{path}: CRSが先頭ファイル({first})と異なる({got:?} != {expected:?})。\
         このツールは全入力が同じ座標系であることを前提にしている"
    )]
    CrsMismatch {
        path: PathBuf,
        first: PathBuf,
        // `Crs`は128バイトあり(`clippy::result_large_err`)、`LayoutMismatch`の
        // `StreamingLayout`と同じ理由でBoxに入れる。
        got: Box<Crs>,
        expected: Box<Crs>,
    },
    #[error("COPC書き出しに失敗した: {0}")]
    Write(#[source] copc_core::Error),
}

/// 入力の指定方法。ディレクトリ(配下の`*.las`/`*.laz`を集める)か、
/// globパターン(`glob`クレートにそのまま渡す)。
pub enum InputSpec<'a> {
    Directory(&'a Path),
    Glob(&'a str),
}

/// `input`文字列から`InputSpec`を判定する。実在するディレクトリならそれを
/// 走査し、そうでなければglobパターンとして扱う(`*`を含むかどうかではなく
/// 「ディレクトリとして存在するか」で振り分ける。存在するディレクトリに
/// `*`を含む名前が付いていることは実運用上まず無いため、この判定で十分)。
pub fn input_spec(input: &str) -> InputSpec<'_> {
    let path = Path::new(input);
    if path.is_dir() {
        InputSpec::Directory(path)
    } else {
        InputSpec::Glob(input)
    }
}

/// 入力パスの一覧を集める。ファイル名の昇順(= `sort()`)で、タイル順が
/// 安定するようにする(出力の点の並び順が実行ごとに変わらないように)。
pub fn collect_input_paths(input: &str) -> Result<Vec<PathBuf>, MergeError> {
    let mut paths: Vec<PathBuf> = match input_spec(input) {
        InputSpec::Directory(dir) => {
            let mut found = Vec::new();
            for entry in std::fs::read_dir(dir).map_err(MergeError::ReadDir)? {
                let entry = entry.map_err(MergeError::ReadDir)?;
                let path = entry.path();
                let is_las_or_laz =
                    path.extension()
                        .and_then(|ext| ext.to_str())
                        .is_some_and(|ext| {
                            ext.eq_ignore_ascii_case("las") || ext.eq_ignore_ascii_case("laz")
                        });
                if is_las_or_laz {
                    found.push(path);
                }
            }
            found
        }
        InputSpec::Glob(pattern) => {
            let mut found = Vec::new();
            for entry in glob::glob(pattern).map_err(MergeError::GlobPattern)? {
                found.push(entry.map_err(MergeError::GlobIter)?);
            }
            found
        }
    };
    paths.sort();
    if paths.is_empty() {
        return Err(MergeError::NoInputFiles(input.to_string()));
    }
    Ok(paths)
}

/// 入力ファイル群のヘッダーだけを読んで集めた要約。
///
/// **全点の読み込みではない**(`las::Reader::from_path`はヘッダー+VLRだけを
/// 読み、点データは`fill_points`を呼ぶまで読まれない。`las`クレートのAPIの
/// 性質上、全点読み込みとは別のI/Oパスなので「2回目のフルパス」には
/// ならない)。レイアウトの一致確認と、進捗表示の分母(申告点数の合計)にだけ使う。
pub struct HeaderSummary {
    pub layout: StreamingLayout,
    pub declared_points_total: u64,
    pub metadata: CopcWriteMetadata,
    /// M4-14: 先頭ファイルから判定したCRS。以降の全ファイルがこれと一致する
    /// ことを`summarize_headers`が確認済み。
    pub crs: Crs,
}

/// 全入力ファイルのヘッダーを読み、レイアウト・CRSの一致を確認する。
/// 出力のメタデータ(CRS・scale/offset等)は先頭ファイルのヘッダーから
/// 組み立てる(モジュールのドキュメント参照)。
pub fn summarize_headers(paths: &[PathBuf]) -> Result<HeaderSummary, MergeError> {
    let mut layout: Option<StreamingLayout> = None;
    let mut crs: Option<Crs> = None;
    let mut declared_points_total: u64 = 0u64;
    let mut metadata: Option<CopcWriteMetadata> = None;

    for path in paths {
        let reader = las::Reader::from_path(path).map_err(|source| MergeError::OpenHeader {
            path: path.clone(),
            source,
        })?;
        let header = reader.header();
        let this_layout = StreamingLayout::from_las_header(header);
        let this_crs = detect_crs_from_las_header(header);
        match &layout {
            None => {
                layout = Some(this_layout);
                crs = Some(this_crs);
                metadata = Some(copc_write_metadata_from_source_header(header));
            }
            Some(expected_layout) => {
                if expected_layout != &this_layout {
                    return Err(MergeError::LayoutMismatch {
                        path: path.clone(),
                        first: paths[0].clone(),
                        got: Box::new(this_layout),
                        expected: Box::new(expected_layout.clone()),
                    });
                }
                // M4-14: `Crs::Unknown`どうしは「一致」になる(`Crs`の
                // `PartialEq`はデータを持たないバリアント同士を等しいとみなす)
                // ため、両方CRSが分からない入力の組み合わせを誤って拒否しない。
                let expected_crs = crs.expect("layoutがSomeならcrsもSome");
                if expected_crs != this_crs {
                    return Err(MergeError::CrsMismatch {
                        path: path.clone(),
                        first: paths[0].clone(),
                        got: Box::new(this_crs),
                        expected: Box::new(expected_crs),
                    });
                }
            }
        }
        declared_points_total += header.number_of_points();
    }

    // `paths`は呼び出し側(`collect_input_paths`)が空でないことを保証している。
    let layout = layout.expect("paths は空でない前提");
    let crs = crs.expect("paths は空でない前提");
    let metadata = metadata.expect("paths は空でない前提");
    Ok(HeaderSummary {
        layout,
        declared_points_total,
        metadata,
        crs,
    })
}

/// 1回の`fill_points`で読むバッチサイズ。`streaming.rs`の
/// `BatchedLasPoints`(単一ファイル版)と同じ値・同じ理由
/// (LAZ並列展開`laz-parallel`フィーチャの効きをよくする。詳細は
/// `streaming.rs`冒頭のM4-7のコメント参照)。
const READ_BATCH_SIZE: u64 = 1024 * 1024;

struct CurrentFile {
    reader: las::Reader,
    point_data: las::PointData,
    batch: VecDeque<las::Result<las::Point>>,
    exhausted: bool,
}

/// 複数のLAS/LAZファイルを順番に読み、1本の`LasPointRecord`イテレータとして
/// 差し出す。**常に高々1ファイル分のリーダー+1バッチ(最大`READ_BATCH_SIZE`点)
/// だけをメモリに持つ**(前のファイルは読み終わったら`current`を入れ替えて
/// 捨てる)。ファイル数・総点数に比例してメモリが増えないことがこの構造の
/// 要(`TaskSheets/ADR-0006-conversion-strategy.md`が守る「メモリは点数に
/// 比例しない」という不変条件の、複数ファイル版での守り方)。
///
/// `streaming.rs`の`BatchedLasPoints`(単一ファイル版)と中身はほぼ同じだが、
/// 複数ファイルをまたぐ分岐(`open_next`)が増える分だけ別の型にしてある。
/// `BatchedLasPoints`はプログレス通知のクロージャを型パラメータに持つため、
/// ファイルごとに別のクロージャを作ると型が揃わずイテレータを素直に
/// chainできない(`Box<dyn Iterator<...>>`で包むよりは、この程度の重複は
/// 読みやすさを優先して許容した)。
/// `on_progress`を呼ばない(CLIの逐次print以外に進捗表示を持たない)場合の
/// 既定値。関数ポインタ型`fn(ReadProgress)`は`FnMut`を実装するため、
/// 型パラメータ`F`の既定としてそのまま使える(クロージャの無名型は型名を
/// 書けないのでデフォルト型には使えない)。
fn no_op_progress(_: ReadProgress) {}

pub struct MultiFileLasPoints<F: FnMut(ReadProgress) = fn(ReadProgress)> {
    pending: VecDeque<PathBuf>,
    current: Option<CurrentFile>,
    files_total: usize,
    files_opened: usize,
    points_read: u64,
    declared_points_total: u64,
    /// M4-14: `streaming.rs`の`BatchedLasPoints`と同じ理由でここに持つ
    /// (Tauriコマンドが読み込み進捗をUIへ流すため)。既定(`new`経由)は
    /// `no_op_progress`で何もしない。
    on_progress: F,
}

impl MultiFileLasPoints<fn(ReadProgress)> {
    pub fn new(paths: Vec<PathBuf>, declared_points_total: u64) -> Self {
        Self::with_progress(paths, declared_points_total, no_op_progress)
    }
}

impl<F: FnMut(ReadProgress)> MultiFileLasPoints<F> {
    /// M4-14: 進捗コールバック付きで構築する(Tauriコマンドが使う)。
    /// `on_progress`は`streaming.rs`の`BatchedLasPoints`と同じ頻度
    /// (`PROGRESS_REPORT_STRIDE`点ごと、と最後の1回)で呼ばれる。
    pub fn with_progress(paths: Vec<PathBuf>, declared_points_total: u64, on_progress: F) -> Self {
        Self {
            files_total: paths.len(),
            pending: paths.into(),
            current: None,
            files_opened: 0,
            points_read: 0,
            declared_points_total,
            on_progress,
        }
    }

    /// 次のファイルを開く。`pending`が空なら`None`(=入力終わり)。
    fn open_next(&mut self) -> Option<copc_core::Result<()>> {
        let path = self.pending.pop_front()?;
        match las::Reader::from_path(&path) {
            Ok(reader) => {
                self.files_opened += 1;
                println!(
                    "  読み込み中 ({}/{}): {}",
                    self.files_opened,
                    self.files_total,
                    path.display()
                );
                let point_data = las::PointDataBuilder::new()
                    .for_header(reader.header())
                    .build();
                self.current = Some(CurrentFile {
                    reader,
                    point_data,
                    batch: VecDeque::new(),
                    exhausted: false,
                });
                Some(Ok(()))
            }
            Err(e) => Some(Err(copc_core::Error::Las(format!(
                "{}: {e}",
                path.display()
            )))),
        }
    }

    pub fn points_read(&self) -> u64 {
        self.points_read
    }

    pub fn declared_points_total(&self) -> u64 {
        self.declared_points_total
    }
}

impl<F: FnMut(ReadProgress)> Iterator for MultiFileLasPoints<F> {
    type Item = copc_core::Result<LasPointRecord>;

    fn next(&mut self) -> Option<Self::Item> {
        loop {
            if self.current.is_none() {
                match self.open_next() {
                    None => return None,
                    Some(Err(e)) => return Some(Err(e)),
                    Some(Ok(())) => {}
                }
            }
            let current = self.current.as_mut().expect("直前にSome(Ok(()))を確認した");
            if let Some(result) = current.batch.pop_front() {
                self.points_read += 1;
                // M4-14: `streaming.rs`の`BatchedLasPoints`と同じ頻度で
                // 進捗を報告する(単一ファイル経路と見せ方を揃える)。
                if self.points_read.is_multiple_of(PROGRESS_REPORT_STRIDE)
                    || self.points_read == self.declared_points_total
                {
                    (self.on_progress)(ReadProgress {
                        points_read: self.points_read,
                        total_points: self.declared_points_total,
                    });
                }
                return Some(
                    result
                        .map(|point| LasPointRecord::from_las_point(&point))
                        .map_err(|e| copc_core::Error::Las(e.to_string())),
                );
            }
            if current.exhausted {
                self.current = None;
                continue;
            }
            match current
                .reader
                .fill_points(READ_BATCH_SIZE, &mut current.point_data)
            {
                Ok(0) => current.exhausted = true,
                Ok(_) => current.batch = current.point_data.points().collect(),
                Err(e) => {
                    current.exhausted = true;
                    return Some(Err(copc_core::Error::Las(e.to_string())));
                }
            }
        }
    }
}

/// M4-14: ヘッダー確認(`summarize_headers`)から書き出しまでを1本にまとめた、
/// `src-tauri/src/conversion.rs`の`start_multi_las_conversion`が呼ぶ入口。
///
/// `streaming.rs`の`convert_and_timings`(単一ファイル版)と同じ形(進捗
/// コールバック・`CancelCheck`・`ConversionStageTimings`の埋め方)にしてある。
/// 返り値の`HeaderSummary`は、呼び出し側が点数・CRS等をイベント(完了通知)に
/// 使うためにそのまま返す(書き出しに使った`layout`は`write_streaming_with_
/// cancel_and_timings`へ渡す際に`clone()`しているので、ここで失われない)。
pub fn merge_paths_and_timings<F>(
    paths: Vec<PathBuf>,
    output: &Path,
    spill_dir: &Path,
    params: &CopcWriterParams,
    cancel: &(dyn CancelCheck + Sync),
    on_progress: F,
    timings: &mut ConversionStageTimings,
) -> Result<HeaderSummary, MergeError>
where
    F: FnMut(ReadProgress),
{
    let summary = summarize_headers(&paths)?;
    let points =
        MultiFileLasPoints::with_progress(paths, summary.declared_points_total, on_progress);

    let mut ingest = copc_writer::IngestStageTimings::default();
    let mut post = copc_writer::PostProcessStageTimings::default();
    write_streaming_with_cancel_and_timings(
        output,
        summary.layout.clone(),
        points,
        params,
        &summary.metadata,
        spill_dir,
        cancel,
        Some(&mut ingest),
        Some(&mut post),
    )
    .map_err(MergeError::Write)?;
    *timings = ConversionStageTimings::from_parts(ingest, post);
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;

    use copc_core::NeverCancel;
    use copc_writer::{write_streaming_with_cancel_and_timings, CopcWriterParams};
    use pcv_core::CopcFile;

    /// `(x, y, z)`を1点だけ持つ、色あり(PDRF3)のLASファイルを作る。
    /// 複数タイルの最小再現(所有者の実データは1ファイル6.2M点だが、
    /// テストでは構造の正しさだけ見るので数点で十分)。
    fn write_single_point_las(path: &Path, x: f64, y: f64, z: f64, color: [u16; 3]) {
        let mut builder = las::Builder::from((1, 2));
        builder.point_format = las::point::Format::new(3).expect("PDRF3は存在する");
        builder.transforms = las::Vector {
            x: las::Transform {
                scale: 0.001,
                offset: 0.0,
            },
            y: las::Transform {
                scale: 0.001,
                offset: 0.0,
            },
            z: las::Transform {
                scale: 0.001,
                offset: 0.0,
            },
        };
        let header = builder.into_header().expect("valid header");
        let file = std::fs::File::create(path).expect("create las");
        let mut writer =
            las::Writer::new(std::io::BufWriter::new(file), header).expect("las writer");
        let point = las::Point {
            x,
            y,
            z,
            gps_time: Some(0.0),
            color: Some(las::Color {
                red: color[0],
                green: color[1],
                blue: color[2],
            }),
            ..Default::default()
        };
        writer.write_point(point).expect("write point");
        writer.close().expect("close las writer");
    }

    /// 複数点を持つLASファイルを作る(点数の検算用)。
    fn write_multi_point_las(path: &Path, points: &[(f64, f64, f64)]) {
        let mut builder = las::Builder::from((1, 2));
        builder.point_format = las::point::Format::new(3).expect("PDRF3は存在する");
        builder.transforms = las::Vector {
            x: las::Transform {
                scale: 0.001,
                offset: 0.0,
            },
            y: las::Transform {
                scale: 0.001,
                offset: 0.0,
            },
            z: las::Transform {
                scale: 0.001,
                offset: 0.0,
            },
        };
        let header = builder.into_header().expect("valid header");
        let file = std::fs::File::create(path).expect("create las");
        let mut writer =
            las::Writer::new(std::io::BufWriter::new(file), header).expect("las writer");
        for &(x, y, z) in points {
            let point = las::Point {
                x,
                y,
                z,
                gps_time: Some(0.0),
                color: Some(las::Color {
                    red: 1000,
                    green: 2000,
                    blue: 3000,
                }),
                ..Default::default()
            };
            writer.write_point(point).expect("write point");
        }
        writer.close().expect("close las writer");
    }

    #[test]
    fn collect_input_paths_sorts_and_filters_by_extension() {
        let dir = tempfile::tempdir().expect("tempdir");
        for name in ["b.las", "a.las", "c.laz", "ignore.txt"] {
            std::fs::File::create(dir.path().join(name)).expect("create");
        }
        let paths = collect_input_paths(dir.path().to_str().expect("utf8 path")).expect("collect");
        let names: Vec<_> = paths
            .iter()
            .map(|p| p.file_name().unwrap().to_str().unwrap().to_string())
            .collect();
        assert_eq!(names, vec!["a.las", "b.las", "c.laz"]);
    }

    #[test]
    fn collect_input_paths_errors_when_nothing_matches() {
        let dir = tempfile::tempdir().expect("tempdir");
        let err = collect_input_paths(dir.path().to_str().expect("utf8 path"));
        assert!(matches!(err, Err(MergeError::NoInputFiles(_))));
    }

    /// 受け入れ条件: 2〜3個の小さな合成LASをマージして、COPCヘッダーの
    /// 総点数・バウンディングボックスが正しく、全入力の点が存在することを
    /// 確かめる。
    #[test]
    fn merging_three_small_files_yields_correct_count_bounds_and_points() {
        let dir = tempfile::tempdir().expect("tempdir");

        // 3つの隣接タイルを模す。それぞれ1点だけ、バウンディングボックスの
        // 角になる座標を置く(マージ後のbounds検算をしやすくするため)。
        write_single_point_las(&dir.path().join("tile-0.las"), 0.0, 0.0, 0.0, [100, 0, 0]);
        write_single_point_las(&dir.path().join("tile-1.las"), 400.0, 0.0, 1.0, [0, 200, 0]);
        write_single_point_las(&dir.path().join("tile-2.las"), 0.0, 300.0, 2.0, [0, 0, 300]);

        let paths = collect_input_paths(dir.path().to_str().expect("utf8 path")).expect("collect");
        assert_eq!(paths.len(), 3);

        let summary = summarize_headers(&paths).expect("summarize");
        assert_eq!(summary.declared_points_total, 3);

        let output = dir.path().join("merged.copc.laz");
        let spill_dir = tempfile::tempdir().expect("spill tempdir");
        let points = MultiFileLasPoints::new(paths, summary.declared_points_total);
        let params = CopcWriterParams::new(100_000);
        write_streaming_with_cancel_and_timings(
            &output,
            summary.layout,
            points,
            &params,
            &summary.metadata,
            spill_dir.path(),
            &NeverCancel,
            None,
            None,
        )
        .expect("write merged copc");

        let mut file = CopcFile::open(&output).expect("open merged copc");
        assert_eq!(file.info().point_count, 3);

        // バウンディングボックス = 3点の座標の和集合。
        let min = file.info().min;
        let max = file.info().max;
        assert_eq!(min, [0.0, 0.0, 0.0]);
        assert_eq!(max, [400.0, 300.0, 2.0]);

        // hierarchyの点数合計も3であること(verify.rsと同じ確認)。
        let hierarchy_sum: u64 = file
            .hierarchy()
            .nodes()
            .map(|n| u64::from(n.point_count))
            .sum();
        assert_eq!(hierarchy_sum, 3);

        // 3入力すべての点が、実際に`read_node`で読めるノードの中に存在する
        // こと(`examples/verify.rs`と同じ確認方法)。
        let mut keys: Vec<_> = file
            .hierarchy()
            .nodes()
            .map(|n| (n.key, n.point_count))
            .collect();
        keys.sort_by_key(|(key, _)| (key.level, key.x, key.y, key.z));
        let mut read_points_total = 0u32;
        for (key, declared_count) in &keys {
            let buffer = file.read_node(*key).expect("read_node");
            assert_eq!(buffer.point_count, *declared_count);
            read_points_total += buffer.point_count;
        }
        assert_eq!(read_points_total, 3);
    }

    #[test]
    fn merging_rejects_mismatched_layouts() {
        let dir = tempfile::tempdir().expect("tempdir");
        write_single_point_las(&dir.path().join("a.las"), 0.0, 0.0, 0.0, [1, 1, 1]);

        // 色無し(PDRF0)のファイルを混ぜる。
        let mut builder = las::Builder::from((1, 2));
        builder.point_format = las::point::Format::new(0).expect("PDRF0は存在する");
        let header = builder.into_header().expect("valid header");
        let file = std::fs::File::create(dir.path().join("b.las")).expect("create las");
        let mut writer = las::Writer::new(std::io::BufWriter::new(file), header).expect("writer");
        writer
            .write_point(las::Point::default())
            .expect("write point");
        writer.close().expect("close");

        let paths = collect_input_paths(dir.path().to_str().expect("utf8 path")).expect("collect");
        let err = summarize_headers(&paths);
        assert!(matches!(err, Err(MergeError::LayoutMismatch { .. })));
    }

    #[test]
    fn multi_file_points_iterator_yields_points_from_every_input_in_order() {
        let dir = tempfile::tempdir().expect("tempdir");
        write_multi_point_las(
            &dir.path().join("a.las"),
            &[(0.0, 0.0, 0.0), (1.0, 1.0, 1.0)],
        );
        write_multi_point_las(&dir.path().join("b.las"), &[(2.0, 2.0, 2.0)]);

        let paths = collect_input_paths(dir.path().to_str().expect("utf8 path")).expect("collect");
        let mut iter = MultiFileLasPoints::new(paths, 3);
        let mut xs = Vec::new();
        for item in &mut iter {
            xs.push(item.expect("point").x);
        }
        assert_eq!(xs, vec![0.0, 1.0, 2.0]);
        assert_eq!(iter.points_read(), 3);
    }

    /// `crs_override.rs`のテストヘルパーと同じ組み立て方(GeoKeyDirectoryTagの
    /// バイナリレイアウトはGeoTIFF仕様どおり)で、ProjectedCRSGeoKeyだけを
    /// 持つ1点のLASファイルを作る。
    fn write_single_point_las_with_geotiff_crs(path: &Path, epsg: u16) {
        let mut builder = las::Builder::from((1, 2));
        builder.point_format = las::point::Format::new(3).expect("PDRF3は存在する");
        let mut data = Vec::new();
        data.extend_from_slice(&1u16.to_le_bytes()); // KeyDirectoryVersion
        data.extend_from_slice(&1u16.to_le_bytes()); // KeyRevision
        data.extend_from_slice(&1u16.to_le_bytes()); // MinorRevision
        data.extend_from_slice(&1u16.to_le_bytes()); // NumberOfKeys
        data.extend_from_slice(&3072u16.to_le_bytes()); // ProjectedCRSGeoKey
        data.extend_from_slice(&0u16.to_le_bytes()); // location=0(値そのもの)
        data.extend_from_slice(&1u16.to_le_bytes()); // count=1
        data.extend_from_slice(&epsg.to_le_bytes());
        builder.vlrs.push(las::Vlr {
            user_id: "LASF_Projection".to_string(),
            record_id: 34735,
            description: String::new(),
            data,
        });
        let header = builder.into_header().expect("valid header");
        let file = std::fs::File::create(path).expect("create las");
        let mut writer =
            las::Writer::new(std::io::BufWriter::new(file), header).expect("las writer");
        writer
            .write_point(las::Point {
                gps_time: Some(0.0), // PDRF3はGPS時刻が必須
                color: Some(las::Color {
                    red: 1,
                    green: 1,
                    blue: 1,
                }),
                ..Default::default()
            })
            .expect("write point");
        writer.close().expect("close las writer");
    }

    /// 受け入れ条件: CRSが異なる入力は、名前付きの明確なエラーで拒否する。
    /// `summarize_headers`単体で確認する(書き出しまで進めると実害が出る前に
    /// 検出できることを示す)。
    #[test]
    fn merging_rejects_mismatched_crs() {
        let dir = tempfile::tempdir().expect("tempdir");
        // a: JGD2011 平面直角座標系IX系(EPSG:6677)。
        write_single_point_las_with_geotiff_crs(&dir.path().join("a.las"), 6677);
        // b: UTM54N(EPSG:32654)。aとは異なる座標系。
        write_single_point_las_with_geotiff_crs(&dir.path().join("b.las"), 32654);

        let paths = collect_input_paths(dir.path().to_str().expect("utf8 path")).expect("collect");
        match summarize_headers(&paths) {
            Err(MergeError::CrsMismatch { path, .. }) => {
                assert_eq!(path.file_name().unwrap(), "b.las");
            }
            Err(e) => panic!("CrsMismatchを期待したが別のエラー: {e}"),
            Ok(_) => panic!("CrsMismatchを期待したがOkだった"),
        }
    }

    /// 受け入れ条件: CRS情報を持たない入力どうしは(両方「不明」なので)拒否
    /// されない。実データで「一部のタイルだけCRSのVLRを持たない」ことが
    /// 起こりうるため、過剰に厳しくしないことを確認する。
    #[test]
    fn merging_allows_inputs_without_any_crs_information() {
        let dir = tempfile::tempdir().expect("tempdir");
        write_single_point_las(&dir.path().join("a.las"), 0.0, 0.0, 0.0, [1, 1, 1]);
        write_single_point_las(&dir.path().join("b.las"), 1.0, 1.0, 1.0, [2, 2, 2]);

        let paths = collect_input_paths(dir.path().to_str().expect("utf8 path")).expect("collect");
        let summary = summarize_headers(&paths).expect("CRSが無い入力どうしは一致するはず");
        assert_eq!(summary.crs, Crs::Unknown);
    }

    /// `(x, y, z)`を1点だけ持つLASファイルを、指定したscale/offsetで作る
    /// (`write_single_point_las`は常にscale=0.001・offset=0なので、異なる
    /// scale/offsetの入力を混ぜるテスト専用にこちらを用意した)。
    fn write_single_point_las_with_transform(
        path: &Path,
        x: f64,
        y: f64,
        z: f64,
        scale: f64,
        offset: f64,
    ) {
        let mut builder = las::Builder::from((1, 2));
        builder.point_format = las::point::Format::new(3).expect("PDRF3は存在する");
        builder.transforms = las::Vector {
            x: las::Transform { scale, offset },
            y: las::Transform { scale, offset },
            z: las::Transform {
                scale: 0.001,
                offset: 0.0,
            },
        };
        let header = builder.into_header().expect("valid header");
        let file = std::fs::File::create(path).expect("create las");
        let mut writer =
            las::Writer::new(std::io::BufWriter::new(file), header).expect("las writer");
        writer
            .write_point(las::Point {
                x,
                y,
                z,
                gps_time: Some(0.0), // PDRF3はGPS時刻が必須
                color: Some(las::Color {
                    red: 10,
                    green: 20,
                    blue: 30,
                }),
                ..Default::default()
            })
            .expect("write point");
        writer.close().expect("close las writer");
    }

    /// 受け入れ条件: scale/offsetが異なる入力を混ぜても、実世界座標が
    /// 正しくマージされること(モジュールドキュメント「scale/offsetは
    /// 入力ファイル間で一致していなくてよい」の設計を、実際に書き出して
    /// 確認する。以前は設計上の見込みに留まっていた=未検証)。
    ///
    /// - tile-a: scale=0.001・offset=0(先頭ファイル。出力のscale/offsetは
    ///   これから決まる、`copc_write_metadata_from_source_header`参照)
    /// - tile-b: scale=0.01・offset=100000(全く異なるscale/offset)。
    ///   実世界座標は、tile-bの**自分の**scale(0.01)で誤差無く表現できる
    ///   値(123.46・-50.0。小数2桁)を選んだ。las::Writerは書き込み時に
    ///   ヘッダーのscale/offsetで量子化するため、tile-bのscale(0.01)で
    ///   表現できない値(例: 123.456)を指定すると、tile-b.las自体に書き込まれる
    ///   時点で既に丸められてしまい、「scale/offsetが違う入力を跨いで
    ///   座標が正しいこと」とは別の問題(丸め)を混ぜてしまうため。
    #[test]
    fn merging_with_different_scale_and_offset_keeps_real_world_coordinates() {
        let dir = tempfile::tempdir().expect("tempdir");
        write_single_point_las_with_transform(
            &dir.path().join("tile-a.las"),
            0.0,
            0.0,
            0.0,
            0.001,
            0.0,
        );
        write_single_point_las_with_transform(
            &dir.path().join("tile-b.las"),
            123.46,
            -50.0,
            1.0,
            0.01,
            100_000.0,
        );

        let paths = collect_input_paths(dir.path().to_str().expect("utf8 path")).expect("collect");
        let summary = summarize_headers(&paths).expect("summarize");

        let output = dir.path().join("merged.copc.laz");
        let spill_dir = tempfile::tempdir().expect("spill tempdir");
        let points = MultiFileLasPoints::new(paths, summary.declared_points_total);
        let params = CopcWriterParams::new(100_000);
        write_streaming_with_cancel_and_timings(
            &output,
            summary.layout,
            points,
            &params,
            &summary.metadata,
            spill_dir.path(),
            &copc_core::NeverCancel,
            None,
            None,
        )
        .expect("write merged copc");

        let file = pcv_core::CopcFile::open(&output).expect("open merged copc");
        assert_eq!(file.info().point_count, 2);
        // tile-bの実世界座標(123.46, -50.0, 1.0)が、tile-aのscale/offset
        // (出力のscale/offset、0.001)で量子化し直されても復元されること。
        // 出力scaleの量子化ステップ(0.001)よりずっと小さい許容誤差
        // (1e-6)で比較する(浮動小数演算の丸め誤差はあるが、scale/offsetの
        // 取り違え(例: offsetの100000がそのまま残る等)なら誤差は0.001を
        // はるかに超えるので、この許容幅でも取り違えは確実に検出できる)。
        let close =
            |a: [f64; 3], b: [f64; 3]| a.iter().zip(b.iter()).all(|(x, y)| (x - y).abs() < 1e-6);
        assert!(
            close(file.info().min, [0.0, -50.0, 0.0]),
            "min={:?}",
            file.info().min
        );
        assert!(
            close(file.info().max, [123.46, 0.0, 1.0]),
            "max={:?}",
            file.info().max
        );

        // hierarchyの点数合計もbounds同様2であること(`NodeBuffer`はノード
        // ローカル相対座標のバイナリ形式(`node_format.rs`)にエンコードされて
        // いるため、ここでは個々の点のXYZまでは解きなおさない。bounds
        // (min/max)が入力2点の実世界座標そのものと一致していることで、
        // 量子化のやり直しが正しく行われたことは確認できている)。
        let hierarchy_sum: u64 = file
            .hierarchy()
            .nodes()
            .map(|n| u64::from(n.point_count))
            .sum();
        assert_eq!(hierarchy_sum, 2);
    }

    /// 受け入れ条件: Tauriコマンドが使う進捗コールバックが、ファイルをまたいで
    /// 正しく呼ばれること(`with_progress`)。
    #[test]
    fn merge_paths_and_timings_reports_progress_and_correct_metadata() {
        let dir = tempfile::tempdir().expect("tempdir");
        write_multi_point_las(
            &dir.path().join("a.las"),
            &[(0.0, 0.0, 0.0), (1.0, 1.0, 1.0)],
        );
        write_multi_point_las(&dir.path().join("b.las"), &[(2.0, 2.0, 2.0)]);
        let paths = collect_input_paths(dir.path().to_str().expect("utf8 path")).expect("collect");

        let output = dir.path().join("merged.copc.laz");
        let spill_dir = tempfile::tempdir().expect("spill tempdir");
        let mut last_progress: Option<ReadProgress> = None;
        let mut timings = ConversionStageTimings::default();
        let summary = merge_paths_and_timings(
            paths,
            &output,
            spill_dir.path(),
            &CopcWriterParams::new(100_000),
            &copc_core::NeverCancel,
            |p| last_progress = Some(p),
            &mut timings,
        )
        .expect("merge_paths_and_timings");

        assert_eq!(summary.declared_points_total, 3);
        let last = last_progress.expect("on_progressが最低1回は呼ばれるはず");
        assert_eq!(last.points_read, 3);
        assert_eq!(last.total_points, 3);

        let file = pcv_core::CopcFile::open(&output).expect("open merged copc");
        assert_eq!(file.info().point_count, 3);
    }
}
