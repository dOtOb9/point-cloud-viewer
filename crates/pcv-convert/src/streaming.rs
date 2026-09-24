//! M4-3: 本番の変換経路。
//!
//! # 方針転換の経緯(コーディネーター指示、Android対応)
//!
//! 当初は`copc-writer`の一括関数`convert_las_to_copc_streaming_with_crs_wkt_override`
//! (パスを渡すだけの高水準API)を使う設計だったが、**所有者の方針変更で
//! Androidでも変換すること**になった。Androidのファイル選択は`content://` URIを
//! 返し、パスではなく`std::fs::File`(`tauri-plugin-fs`が`ContentResolver`経由で
//! 開いたもの。`src-tauri/src/copc_state.rs`の`open_uri_reader`と同じ経路)しか
//! 得られない。一括関数はパスしか受け付けないため、代わりに`copc-writer`が
//! 公開している低水準API`write_streaming_with_cancel(path, layout, points: I,
//! params, metadata, spill_dir, cancel)`を使う。これは点の`Iterator`を受け取る
//! ため、`R: Read + Seek`であれば`std::fs::File`(パスから開いても
//! `content://`から開いても最終的にこの型になる)を同じコードで扱える
//! (デスクトップ・Androidを1本の経路に統一する。コーディネーター指示どおり)。
//!
//! 副産物として、**点のイテレータを自前で回すため、読み込んだ点数を数えて
//! 進捗として報告できる**(`on_progress`引数)。`copc-writer`自身は進捗の
//! コールバックを持たない(ソースで確認済み)ため、これは外付けの計測になる。
//!
//! # キャンセルの実装方針(ソースを読んで確認した結果)
//!
//! `copc-writer` 0.9.0は`copc_core::CancelCheck`トレイトでキャンセルに
//! 対応している(`writer.rs`の随所――点のスパイル・LOD構築・チャンク圧縮の
//! 全フェーズ――で`cancel.check()?`を呼んでおり、点の処理では4096点ごとに
//! 確認される)。**そのため別プロセスは起動しない。** デスクトップ・Android
//! 共通で、同じプロセスの中の別スレッドで動かし、`Arc<AtomicBool>`を共有する
//! `AtomicCancel`をキャンセルフラグとして渡すだけでよい(Androidはアプリごとに
//! サンドボックスされ、自分自身を別プロセスとして起動するのは一般的な作法
//! ではないため、元よりこの方式がAndroidと相性がよい)。
//!
//! キャンセル時・失敗時の一時ファイル・書きかけ出力の後始末も`copc-writer`
//! 自身が面倒を見ることをソースで確認した。一時ファイル(スパイル・LOD index)は
//! `tempfile::NamedTempFile`で作られており(`spill.rs`/`lod.rs`)、`.persist()`を
//! 呼ばない限り`Drop`時に自動で削除される。出力ファイルも`writer.rs`の
//! `PendingOutput`が同じ仕組み(`.part`という一時名で書き、成功時だけ
//! `persist()`で本来の名前へリネームする)を使っている。したがって
//! `cancel.check()`が`Err`を返して呼び出しが通常のエラーで戻れば
//! (パニックではないので、スタック巻き戻しは常に起きる)、これらの一時
//! ファイルは全てRAIIで消える。このモジュールで追加の後始末コードは
//! 書いていない。
//!
//! # 進捗の粒度(コーディネーター指示)
//!
//! 「読み込み」段階(入力を全点読んでスパイルする段階)は、読んだ点数/
//! ヘッダーの申告点数で正確な割合を出せる。その後の段階(octree構築・
//! チャンク圧縮・書き出し)は`write_streaming_with_cancel`の呼び出しの中で
//! 一括して行われ、外から個別のフックを挟む口が無いため、割合は出さず
//! 「段階名」だけを示す(コーディネーター指示どおり「段階名だけ出す、で
//! よい」)。呼び出し側(`src-tauri`)は、`on_progress`が
//! `points_read == total_points`に達した時点を「読み込み完了」とみなし、
//! そこから`write_streaming_with_cancel`が返るまでの間を「後処理中(割合不明)」
//! として表示を切り替える。

use std::collections::VecDeque;
use std::io::{Read, Seek};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use copc_core::{CancelCheck, LasPointRecord, StreamingLayout};
use copc_writer::{write_streaming_with_cancel, CopcWriterParams};

use crate::write_metadata::copc_write_metadata_from_source_header;

/// 進捗の報告間隔(点数)。`copc-writer`内部のキャンセル確認間隔
/// (`CANCEL_POLL_STRIDE`=4096、非公開定数だが`writer.rs`のソースで確認済み)と
/// 同じ桁にして、進捗コールバック自体が読み込みのボトルネックにならない
/// 頻度に抑える。
const PROGRESS_REPORT_STRIDE: u64 = 4096;

/// 1回の`fill_points`で読むバッチサイズ。`copc-writer`が
/// `convert_las_to_copc_streaming_inner`内で使っている値(`LAS_POINT_BATCH_SIZE`、
/// 非公開定数だが`writer.rs`のソースで確認済み)と同じにする。全点を一度に
/// メモリへ読まないための値なので(out-of-coreの前提を崩さない)、桁を揃えた。
const READ_BATCH_SIZE: u64 = 64 * 1024;

/// キャンセル要求を`copc_core::CancelCheck`に橋渡しする。フラグは呼び出し元
/// (Tauriコマンド側)が持ち、キャンセルボタンが押されたら
/// `store(true, Ordering::Relaxed)`するだけでよい。
#[derive(Clone)]
pub struct AtomicCancel(pub Arc<AtomicBool>);

impl CancelCheck for AtomicCancel {
    fn check(&self) -> copc_core::Result<()> {
        if self.0.load(Ordering::Relaxed) {
            Err(copc_core::Error::Cancelled)
        } else {
            Ok(())
        }
    }
}

/// 「読み込み」段階の進捗。`total_points`はLASヘッダーの申告値
/// (`las::Header::number_of_points`)で、実データの点数と食い違うことは
/// 理論上ありうるが(壊れたヘッダー)、進捗表示の分母としては十分。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReadProgress {
    pub points_read: u64,
    pub total_points: u64,
}

/// `las::Reader`はバッチ単位(`fill_points`)でしか点を読めず、`Iterator`を
/// 直接は実装していない(`las`0.10の実際のAPI。当初`.points()`という
/// イテレータメソッドがあると誤って想定していたが、無かった)。
/// `write_streaming_with_cancel`が要求する`Iterator<Item=Result<LasPointRecord>>`を
/// 満たすため、バッチを読んでは`VecDeque`に貯めて1点ずつ払い出す
/// アダプタをここで組む。バッチサイズは`READ_BATCH_SIZE`(64Ki点)なので、
/// メモリに載るのは常に高々1バッチ分だけ(out-of-coreの前提を崩さない)。
struct BatchedLasPoints<F: FnMut(ReadProgress)> {
    reader: las::Reader,
    point_data: las::PointData,
    batch: VecDeque<las::Result<las::Point>>,
    points_read: u64,
    total_points: u64,
    on_progress: F,
    exhausted: bool,
}

impl<F: FnMut(ReadProgress)> Iterator for BatchedLasPoints<F> {
    type Item = copc_core::Result<LasPointRecord>;

    fn next(&mut self) -> Option<Self::Item> {
        loop {
            if let Some(result) = self.batch.pop_front() {
                self.points_read += 1;
                if self.points_read.is_multiple_of(PROGRESS_REPORT_STRIDE)
                    || self.points_read == self.total_points
                {
                    (self.on_progress)(ReadProgress {
                        points_read: self.points_read,
                        total_points: self.total_points,
                    });
                }
                return Some(
                    result
                        .map(|point| LasPointRecord::from_las_point(&point))
                        .map_err(|e| copc_core::Error::Las(e.to_string())),
                );
            }
            if self.exhausted {
                return None;
            }
            match self
                .reader
                .fill_points(READ_BATCH_SIZE, &mut self.point_data)
            {
                Ok(0) => {
                    self.exhausted = true;
                    return None;
                }
                Ok(_) => {
                    self.batch = self.point_data.points().collect();
                }
                Err(e) => {
                    self.exhausted = true;
                    return Some(Err(copc_core::Error::Las(e.to_string())));
                }
            }
        }
    }
}

/// `R: Read + Seek`な入力(パスから開いた`File`でも、Androidの`content://`から
/// 開いた`File`でも、最終的にはどちらも`std::fs::File`になる。
/// `src-tauri/src/copc_state.rs`の`open_uri_reader`参照)からCOPCへ変換する。
///
/// `on_progress`は読み込み段階の間、`PROGRESS_REPORT_STRIDE`点ごと(と最後の
/// 1回)呼ばれる。読み込み完了後(`points_read == total_points`の通知の後)は
/// 呼ばれなくなり、この関数が`Ok`/`Err`で返るまで後処理(octree構築・書き出し)が
/// 続く(呼び出し側で「段階名だけの表示」に切り替える。モジュールの
/// ドキュメント参照)。
///
/// `las::Reader::new`が`R: Send + Sync + 'static`を要求するため、この関数も
/// 同じ境界を引き継ぐ(呼び出し側はどのみち別スレッドで変換を回すので、
/// この制約が問題になることはない)。
pub fn convert<R, F>(
    source: R,
    output: &Path,
    spill_dir: &Path,
    params: &CopcWriterParams,
    cancel: &dyn CancelCheck,
    on_progress: F,
) -> copc_core::Result<()>
where
    R: Read + Seek + Send + Sync + 'static,
    F: FnMut(ReadProgress),
{
    let las_reader = las::Reader::new(source).map_err(|e| copc_core::Error::Las(e.to_string()))?;
    // `fill_points`は`&mut self`を要求するため、ヘッダーから要る情報は先に取り出す
    // (借用が重ならないようにする)。
    let layout = StreamingLayout::from_las_header(las_reader.header());
    let metadata = copc_write_metadata_from_source_header(las_reader.header());
    let total_points = las_reader.header().number_of_points();
    let point_data = las::PointDataBuilder::new()
        .for_header(las_reader.header())
        .build();

    let points = BatchedLasPoints {
        reader: las_reader,
        point_data,
        batch: VecDeque::new(),
        points_read: 0,
        total_points,
        on_progress,
        exhausted: false,
    };

    write_streaming_with_cancel(output, layout, points, params, &metadata, spill_dir, cancel)
}

/// パスから開く便利関数(デスクトップの通常経路。テストからも使う)。
/// Android(`content://`)は`convert`を直接、`tauri-plugin-fs`で開いた
/// `File`を渡して呼ぶ(`src-tauri`側の実装を参照)。
pub fn convert_path<F>(
    source: &Path,
    output: &Path,
    spill_dir: &Path,
    params: &CopcWriterParams,
    cancel: &dyn CancelCheck,
    on_progress: F,
) -> copc_core::Result<()>
where
    F: FnMut(ReadProgress),
{
    let file =
        std::fs::File::open(source).map_err(|e| copc_core::Error::io("open source LAS/LAZ", e))?;
    convert(
        std::io::BufReader::new(file),
        output,
        spill_dir,
        params,
        cancel,
        on_progress,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atomic_cancel_reports_ok_until_flagged() {
        let flag = Arc::new(AtomicBool::new(false));
        let cancel = AtomicCancel(flag.clone());
        assert!(cancel.check().is_ok());

        flag.store(true, Ordering::Relaxed);
        assert!(matches!(cancel.check(), Err(copc_core::Error::Cancelled)));
    }
}
