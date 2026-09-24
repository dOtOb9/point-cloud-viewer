//! COPCファイルの書き出し。
//!
//! # なぜ自分でバイト列を組み立てるのか
//!
//! `copc-core`/`copc-reader`と同じ`roteiro-gis/copc-rust`の姉妹クレートに
//! `copc-writer`があり、`convert_las_to_copc_streaming`という高水準関数まで
//! 公開している。だが、それは使わない。`copc-writer`はout-of-core(スピル
//! ファイルを介した外部ソート)を内部で行っており、それを呼ぶと測れるのは
//! 「素朴な実装のコスト」ではなく「既に最適化されたクレートの性能」になって
//! しまう。M4-1が知りたいのは前者なので、octree分割(`octree.rs`)と
//! ファイル組み立て(このファイル)は自分で書く。
//!
//! ただしCOPCのバイナリ構造そのもの(hierarchy entryの32バイトレイアウト・
//! COPC infoの160バイトレイアウト)は`pcv-core`の読み込み側(ADR-0003)と
//! 同じ`copc-core`の型を再利用する。書式の定義を2箇所に持つと食い違いの
//! リスクがあるうえ、この部分は「素朴なアルゴリズム」ではなく単なる
//! バイト列のシリアライズなので、既存の(読み込み側で検証済みの)実装を
//! 使うことに素朴さを損なう問題はない。
//!
//! # ファイルレイアウト
//!
//! ```text
//! [0..375)                  LASヘッダ(1.4)
//! [375..)                   VLR: COPC info(仕様上、最初のVLRである必須) → LASzip(可変長チャンク)
//! offset_to_point_data から: i64 チャンクテーブルオフセット(lazクレートが管理)
//!                            → ノードごとに1 LAZチャンク(finish_current_chunkで区切る)
//!                            → LAZのチャンクテーブル(lazクレートが`done()`で書く。
//!                              COPCとしての読み出しはhierarchyのoffset/byte_sizeを
//!                              直接使うため参照しないが、単体のLAZとしても正しい
//!                              ファイルにするために残す)
//! start_of_first_evlr から:  EVLR: COPC hierarchy(1ページのみ。ページ分割はしない。
//!                              後述)
//! ```
//!
//! # 簡略化した点(素朴さゆえの割り切り。結果に明記する)
//!
//! - **hierarchyは常に1ページ**: COPCはhierarchyを複数ページに分割できるが
//!   (ADR-0003追記のsofi.copc.lazはこれで問題を起こした)、このスパイクでの
//!   ノード数(数百〜数千)なら1ページに収まる。複数ページへの分割ロジックは
//!   実装しない
//! - **CRS(座標参照系)VLRを持ち出さない**: 入力のGeoTIFF/WKT VLRはコピーしない。
//!   M4-1は変換コストの実測が目的でCRSの検証は範囲外(M4-5で扱う)
//! - **GPS時刻・リターン情報・スキャン角度は運ばない**: `point.rs`のコメント参照

use std::fs::File;
use std::io::{BufWriter, Seek, SeekFrom, Write};
use std::path::Path;

use byteorder::{LittleEndian, WriteBytesExt};
use copc_core::{CopcInfo, Entry, HierarchyPage};
use las::{Color, Transform, Vector};

use crate::octree::Node;
use crate::point::SourceCloud;

const LAS_HEADER_BYTES: u64 = 375;
const VLR_HEADER_BYTES: u64 = 54;
const EVLR_HEADER_BYTES: u64 = 60;
const COPC_INFO_VLR_BODY_BYTES: u64 = 160;
const COPC_USER_ID: &str = "copc";
const COPC_INFO_RECORD_ID: u16 = 1;
const COPC_HIERARCHY_RECORD_ID: u16 = 1000;

#[derive(Debug, thiserror::Error)]
pub enum WriteError {
    #[error("入出力エラー: {0}")]
    Io(#[from] std::io::Error),
    #[error("点データのシリアライズに失敗した: {0}")]
    Las(#[from] las::Error),
    #[error("LAZ圧縮に失敗した: {0}")]
    Laz(#[from] laz::LasZipError),
    #[error("COPCバイナリ構造の組み立てに失敗した: {0}")]
    CopcCore(#[from] copc_core::Error),
}

pub struct WriteStats {
    pub node_count: usize,
    pub total_points: u64,
    pub output_bytes: u64,
}

/// 変換結果を`out_path`へ書く。`nodes`は`octree::build`の出力
/// (`(VoxelKey, インデックス列)`の一覧)。
pub fn write(
    out_path: &Path,
    source: &SourceCloud,
    nodes: &[Node],
    center: (f64, f64, f64),
    halfsize: f64,
) -> Result<WriteStats, WriteError> {
    let point_format_id: u8 = if source.has_color { 7 } else { 6 };
    let format = las::point::Format::new(point_format_id)?;
    let point_record_length = format.len();

    let transforms = Vector {
        x: Transform {
            scale: source.scale.0,
            offset: source.offset.0,
        },
        y: Transform {
            scale: source.scale.1,
            offset: source.offset.1,
        },
        z: Transform {
            scale: source.scale.2,
            offset: source.offset.2,
        },
    };

    let laz_vlr = laz::LazVlrBuilder::default()
        .with_point_format(point_format_id, 0)?
        .with_variable_chunk_size()
        .build();
    let mut laz_vlr_bytes = Vec::new();
    laz_vlr.write_to(&mut laz_vlr_bytes)?;

    let laz_vlr_total_bytes = VLR_HEADER_BYTES + laz_vlr_bytes.len() as u64;
    let copc_info_vlr_total_bytes = VLR_HEADER_BYTES + COPC_INFO_VLR_BODY_BYTES;
    let offset_to_point_data = LAS_HEADER_BYTES + copc_info_vlr_total_bytes + laz_vlr_total_bytes;
    // COPC infoVLRはCOPC仕様で「ファイル中の最初のVLR」であることが必須
    // (offset 375から始まる)。LASzip VLRより先に書く。
    let copc_info_body_offset = LAS_HEADER_BYTES + VLR_HEADER_BYTES;

    let total_points: u64 = nodes.iter().map(|n| n.indices.len() as u64).sum();

    let file = File::create(out_path)?;
    let mut writer = BufWriter::with_capacity(1 << 20, file);

    // ---- ヘッダ+VLR: root_hier_offset/sizeとstart_of_first_evlrはまだ分から
    // ないので0で仮置きし、点データを書き終えたあとに頭へ戻って書き直す ----
    let header = HeaderFields {
        point_format_id,
        point_record_length,
        offset_to_point_data: u32::try_from(offset_to_point_data)
            .expect("ヘッダ+VLRは32bitに収まる小ささ"),
        scale: source.scale,
        offset: source.offset,
        bounds_min: source.bounds_min,
        bounds_max: source.bounds_max,
        total_point_count: total_points,
        start_of_first_evlr: 0,
    };
    header.write(&mut writer)?;

    write_vlr_header(
        &mut writer,
        COPC_USER_ID,
        COPC_INFO_RECORD_ID,
        COPC_INFO_VLR_BODY_BYTES as u16,
        "https://copc.io",
    )?;
    writer.write_all(&[0u8; COPC_INFO_VLR_BODY_BYTES as usize])?;

    write_vlr_header(
        &mut writer,
        laz::LazVlr::USER_ID,
        laz::LazVlr::RECORD_ID,
        laz_vlr_bytes.len() as u16,
        laz::LazVlr::DESCRIPTION,
    )?;
    writer.write_all(&laz_vlr_bytes)?;

    debug_assert_eq!(writer.stream_position()?, offset_to_point_data);

    // ---- 点データ: ノードごとに1LAZチャンク ----
    let mut compressor = laz::LasZipCompressor::new(writer, laz_vlr)?;
    // 最初の`compress_one`が自動でチャンクテーブルへのオフセット(8バイト)を
    // 先頭に予約してしまう前に、ここで明示的に予約しておく。そうしないと
    // 最初のノード(root)のEntry.offsetがこの8バイト分だけずれてしまう
    // (実際にこれで根ノードのread_nodeがEOFになる不具合を踏んだ)。
    compressor.reserve_offset_to_chunk_table()?;
    let mut entries = Vec::with_capacity(nodes.len());
    let mut point_buf = Vec::with_capacity(point_record_length as usize);
    for node in nodes {
        let chunk_offset = compressor.get_mut().stream_position()?;
        for &idx in &node.indices {
            let p = source.points[idx as usize];
            let las_point = las::Point {
                x: p.x,
                y: p.y,
                z: p.z,
                intensity: p.intensity,
                return_number: 1,
                number_of_returns: 1,
                color: source
                    .has_color
                    .then(|| Color::new(p.color[0], p.color[1], p.color[2])),
                ..classification_point(p.classification)
            };
            let raw_point = las_point.into_raw(&transforms)?;
            point_buf.clear();
            raw_point.write_to(&mut point_buf, &format)?;
            compressor.compress_one(&point_buf)?;
        }
        compressor.finish_current_chunk()?;
        let chunk_end = compressor.get_mut().stream_position()?;
        entries.push(Entry {
            key: node.key,
            offset: chunk_offset,
            byte_size: i32::try_from(chunk_end - chunk_offset)
                .expect("1ノード分のLAZチャンクはi32に収まる"),
            point_count: i32::try_from(node.indices.len()).expect("1ノードの点数はi32に収まる"),
        });
    }
    compressor.done()?;
    let mut writer = compressor.into_inner();

    // ---- hierarchy EVLR(1ページのみ) ----
    let start_of_first_evlr = writer.stream_position()?;
    let hierarchy_bytes = HierarchyPage::new(entries).write_le_bytes()?;
    write_evlr_header(
        &mut writer,
        COPC_USER_ID,
        COPC_HIERARCHY_RECORD_ID,
        hierarchy_bytes.len() as u64,
        "https://copc.io",
    )?;
    writer.write_all(&hierarchy_bytes)?;
    let output_bytes = writer.stream_position()?;

    // ---- ヘッダとCOPC infoを実際の値で書き直す ----
    writer.seek(SeekFrom::Start(0))?;
    let header = HeaderFields {
        start_of_first_evlr,
        ..header
    };
    header.write(&mut writer)?;

    // 平均点間隔の粗い見積り: ルート立方体の体積を総点数で割った1点あたりの
    // 体積の立方根。厳密な最近傍距離ではないが、有限の正値であればよい
    // (`CopcInfo::validate`の要求はそれだけ)。
    let volume = (halfsize * 2.0).powi(3);
    let spacing = (volume / total_points.max(1) as f64)
        .cbrt()
        .max(f64::MIN_POSITIVE);

    let copc_info = CopcInfo {
        center,
        halfsize,
        spacing,
        root_hier_offset: start_of_first_evlr + EVLR_HEADER_BYTES,
        root_hier_size: hierarchy_bytes.len() as u64,
        gpstime_min: 0.0,
        gpstime_max: 0.0,
    };
    writer.seek(SeekFrom::Start(copc_info_body_offset))?;
    writer.write_all(&copc_info.write_le_bytes()?)?;

    writer.flush()?;

    Ok(WriteStats {
        node_count: nodes.len(),
        total_points,
        output_bytes,
    })
}

/// 分類コード12(重複点)は`las::point::Classification::new`が拒否するため
/// (LAS 1.4の拡張フォーマットでは重複はフラグ1本で表す規則になっている。
/// `las`クレートのドキュメント参照)、その場合だけ`Unclassified`+
/// `is_overlap`に読み替える。それ以外は元のコードをそのまま使う。
fn classification_point(code: u8) -> las::Point {
    if code == 12 {
        las::Point {
            classification: las::point::Classification::Unclassified,
            is_overlap: true,
            ..Default::default()
        }
    } else {
        las::Point {
            // 元データが不正なコードを持っていた場合はここでエラーにせず
            // Unclassifiedへ落とす(スパイクなので変換全体を止めない)。
            classification: las::point::Classification::new(code)
                .unwrap_or(las::point::Classification::Unclassified),
            ..Default::default()
        }
    }
}

struct HeaderFields {
    point_format_id: u8,
    point_record_length: u16,
    offset_to_point_data: u32,
    scale: (f64, f64, f64),
    offset: (f64, f64, f64),
    bounds_min: (f64, f64, f64),
    bounds_max: (f64, f64, f64),
    total_point_count: u64,
    start_of_first_evlr: u64,
}

impl HeaderFields {
    /// LAS 1.4ヘッダ(375バイト固定)を書く。フィールド順・サイズはLAS 1.4仕様書のとおり。
    fn write<W: Write>(&self, w: &mut W) -> std::io::Result<()> {
        w.write_all(b"LASF")?;
        w.write_u16::<LittleEndian>(0)?; // file source id
                                         // global encoding: bit4(WKT)を立てる。`pcv-core`の読み込み側(copc.rs)が
                                         // COPC(点フォーマット6-10)にこのビットを必須としている。CRSそのもの
                                         // (WKT VLRの中身)は持ち出さない(上のモジュールコメント参照)ので、
                                         // ビットの意味とVLRの実在が食い違う状態だが、M4-1の検証(pcv-coreで
                                         // 開けるか)はこのビットのチェックだけを見ており、CRSの妥当性は
                                         // M4-5の範囲。
        w.write_u16::<LittleEndian>(0x10)?;
        w.write_all(&[0u8; 16])?; // project id (GUID)。未使用
        w.write_u8(1)?; // version major
        w.write_u8(4)?; // version minor
        w.write_all(&pad_ascii("pcv-convert (M4-1 spike)", 32))?;
        w.write_all(&pad_ascii("pcv-convert 0.1", 32))?;
        let (day, year) = creation_day_and_year();
        w.write_u16::<LittleEndian>(day)?;
        w.write_u16::<LittleEndian>(year)?;
        w.write_u16::<LittleEndian>(LAS_HEADER_BYTES as u16)?; // header size
        w.write_u32::<LittleEndian>(self.offset_to_point_data)?;
        w.write_u32::<LittleEndian>(2)?; // number of VLRs: LASzip + COPC info
                                         // 最上位ビット(0x80)はLAZ圧縮フラグ。点データは実際に圧縮しているので立てる。
        w.write_u8(self.point_format_id | 0x80)?;
        w.write_u16::<LittleEndian>(self.point_record_length)?;
        // legacy point count/returns: 1.4では0固定でよい(拡張フィールド側に本数を持つ)。
        w.write_u32::<LittleEndian>(0)?;
        for _ in 0..5 {
            w.write_u32::<LittleEndian>(0)?;
        }
        w.write_f64::<LittleEndian>(self.scale.0)?;
        w.write_f64::<LittleEndian>(self.scale.1)?;
        w.write_f64::<LittleEndian>(self.scale.2)?;
        w.write_f64::<LittleEndian>(self.offset.0)?;
        w.write_f64::<LittleEndian>(self.offset.1)?;
        w.write_f64::<LittleEndian>(self.offset.2)?;
        w.write_f64::<LittleEndian>(self.bounds_max.0)?;
        w.write_f64::<LittleEndian>(self.bounds_min.0)?;
        w.write_f64::<LittleEndian>(self.bounds_max.1)?;
        w.write_f64::<LittleEndian>(self.bounds_min.1)?;
        w.write_f64::<LittleEndian>(self.bounds_max.2)?;
        w.write_f64::<LittleEndian>(self.bounds_min.2)?;
        w.write_u64::<LittleEndian>(0)?; // start of waveform data packet record。未使用
        w.write_u64::<LittleEndian>(self.start_of_first_evlr)?;
        w.write_u32::<LittleEndian>(1)?; // number of EVLRs: hierarchy 1本
        w.write_u64::<LittleEndian>(self.total_point_count)?;
        for _ in 0..15 {
            w.write_u64::<LittleEndian>(0)?; // number of points by return。運ばない(point.rs参照)
        }
        Ok(())
    }
}

fn write_vlr_header<W: Write>(
    w: &mut W,
    user_id: &str,
    record_id: u16,
    body_size: u16,
    description: &str,
) -> std::io::Result<()> {
    w.write_u16::<LittleEndian>(0)?; // reserved
    w.write_all(&pad_ascii(user_id, 16))?;
    w.write_u16::<LittleEndian>(record_id)?;
    w.write_u16::<LittleEndian>(body_size)?;
    w.write_all(&pad_ascii(description, 32))?;
    Ok(())
}

fn write_evlr_header<W: Write>(
    w: &mut W,
    user_id: &str,
    record_id: u16,
    body_size: u64,
    description: &str,
) -> std::io::Result<()> {
    w.write_u16::<LittleEndian>(0)?; // reserved
    w.write_all(&pad_ascii(user_id, 16))?;
    w.write_u16::<LittleEndian>(record_id)?;
    w.write_u64::<LittleEndian>(body_size)?;
    w.write_all(&pad_ascii(description, 32))?;
    Ok(())
}

/// ASCII文字列を`len`バイトへゼロ埋め/切り詰めする(LASのVLR/EVLRヘッダの固定長
/// 文字列フィールド用)。ここで使う文字列はすべてこのモジュール内の定数か
/// `laz`クレートが返すASCII定数なので、非ASCIIの心配はしていない。
fn pad_ascii(value: &str, len: usize) -> Vec<u8> {
    let mut out = value.as_bytes()[..value.len().min(len)].to_vec();
    out.resize(len, 0);
    out
}

/// UNIXエポックからの経過日数を単純に積み上げてグレゴリオ暦の年・年内通日を
/// 求める(外部の日付クレートを増やさないための最小実装。LASヘッダの
/// 生成日はどのツールで読んでも影響しないメタデータなので、これで十分)。
fn creation_day_and_year() -> (u16, u16) {
    let days_since_epoch = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() / 86_400)
        .unwrap_or(0);

    let mut year = 1970u16;
    let mut remaining = days_since_epoch;
    loop {
        let days_in_year = if is_leap_year(year) { 366 } else { 365 };
        if remaining < days_in_year {
            break;
        }
        remaining -= days_in_year;
        year += 1;
    }
    (u16::try_from(remaining + 1).unwrap_or(1), year)
}

fn is_leap_year(year: u16) -> bool {
    (year.is_multiple_of(4) && !year.is_multiple_of(100)) || year.is_multiple_of(400)
}
