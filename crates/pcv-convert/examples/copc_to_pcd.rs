//! COPC → PCD(binary, 非圧縮)の書き出しツール。
//!
//! 所有者が「数億点規模のPCDで試したい」が手元に大きなPCDが無いため、既存のCOPC
//! (`data/sofi.copc.laz`、3.64億点)をPCDへ変換してテストデータを作るための
//! **例(example)**。本番の変換経路(`src/import/`)には含めない
//! (`TaskSheets/M4-import-and-conversion.md`のM4-9参照、指示どおり)。
//!
//! 同じ点をPCDへ書き出すので、このPCDを本番の経路(`pcv_convert::import::convert_path_to_copc`)
//! で改めてCOPCへ変換すれば、元のsofiと点数を突き合わせられる。
//!
//! # 座標の型: f64(double)を選んだ理由
//!
//! sofiはUTM規模の大きな座標(X・Yが50万〜400万のオーダー)を持つ。PCDのヘッダー
//! `VIEWPOINT`は単なるメタデータであり、本アプリの読み込み側
//! (`crates/pcv-convert/src/import/pcd.rs`)は一切参照しない(読み込み側は
//! x/y/zフィールドの値をそのままCOPCへ渡すだけで、VIEWPOINTを足し戻す処理は
//! 無い)。つまり「VIEWPOINTにオフセットを書いて、読み込み側で足し戻す」という
//! 設計は実際には機能しない。
//!
//! 「全点から共通のオフセットを引いてf32で書く」案も検討したが、そのオフセットを
//! どこかに(別ファイル・ファイル名の中などに)記録し、変換後に正しく足し戻す
//! 仕組みが別途必要になる。実装も検証も手間が増える割に、得られるものは
//! (桁を減らす以外)無い。**doubleでそのまま書けば、何も考えずに済む。**
//!
//! `pcd.rs`の`field_to_f64`は`Field::F64`を含む全数値型を素直にf64へ変換して
//! おり(同関数のmatch式参照)、doubleで書いても読み込み側に問題が無いことを
//! ソースで確認済み。コストはf32に対して1点あたり12バイト増えるだけ
//! (xyzで24B対12B)で、3.64億点でも増加分は高々4.4GB程度に収まり、実行前に
//! 確認するディスク空き容量に対して無視できる。**よってx/y/zはdoubleで書く。**
//!
//! intensityは元のLAS/COPCの型(u16)のまま`TYPE U, SIZE 2`で書く(値の変換・
//! 丸めが不要で、読み込み側`field_to_u16_clamped`もそのまま受け取れる)。
//! rgb(色を持つ入力の場合)は`0x00RRGGBB`の packed `u32`(`TYPE U, SIZE 4`)で
//! 書く。読み込み側`decode_packed_rgb`の`Field::U32`分岐がビット演算だけで
//! 復元できる(浮動小数点のビット再解釈のような変換は不要)。
//!
//! # メモリが点数に比例しないこと
//!
//! COPCのhierarchyをノード単位(`pcv_core::CopcFile::read_node`)で読み、
//! 読んだその場でPCDへ書き出す。1ノードの点数はCOPCの`max_points_per_node`
//! (既定10万点)が上限なので、オンメモリに載るのは常に高々その1ノード分
//! (数MB)だけであり、全体の点数が3.64億点でも1,000万点でも、ピークメモリは
//! 変わらない設計になっている。ノードキー自体は先に全てメモリへ集めるが、
//! ノード数は点数ではなくoctreeの分割数(`max_points_per_node`で決まる。
//! sofi規模でも高々数千個程度)に比例するだけなので、この部分は無視できる。
//!
//! PCDの`POINTS`ヘッダーは、COPCのヘッダーが申告する総点数
//! (`CopcFile::info().point_count`)から、1点も読まずに先に分かる値として書く。
//!
//! ```text
//! cargo run -p pcv-convert --release --example copc_to_pcd -- <入力.copc.laz> <出力.pcd>
//! ```

use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::Path;
use std::time::Instant;

use pcv_core::{CopcFile, NodeBuffer, HEADER_BYTES, POINT_STRIDE};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (Some(input), Some(output)) = (args.first(), args.get(1)) else {
        eprintln!("usage: copc_to_pcd <入力.copc.laz> <出力.pcd>");
        std::process::exit(2);
    };

    if let Err(err) = run(Path::new(input), Path::new(output)) {
        eprintln!("変換に失敗した: {err}");
        std::process::exit(1);
    }
}

fn run(input: &Path, output: &Path) -> Result<(), String> {
    let t0 = Instant::now();
    let mut file = CopcFile::open(input).map_err(|e| e.to_string())?;
    let has_color = file.info().has_color;
    let total_points = file.info().point_count;

    println!("入力          : {}", input.display());
    println!("出力          : {}", output.display());
    println!("点数(ヘッダー): {total_points}");
    println!("色を持つか    : {has_color}");

    // ノードキーを先に全て集める(ノード数は点数に比例しないので、ここで
    // メモリに載せても「メモリが点数に比例しない」という設計を損なわない。
    // モジュール冒頭コメント参照)。出力順を決定的にするためソートする
    // (PCDは無順序の点群として読まれるので、どの順でも結果は変わらない)。
    let mut keys: Vec<_> = file.hierarchy().nodes().map(|n| n.key).collect();
    keys.sort_by_key(|k| (k.level, k.x, k.y, k.z));

    let out = File::create(output).map_err(|e| e.to_string())?;
    let mut writer = BufWriter::new(out);
    write_header(&mut writer, total_points, has_color).map_err(|e| e.to_string())?;

    let mut written: u64 = 0;
    for key in keys {
        // 1ノード分(高々max_points_per_node点)だけがここでメモリに載る。
        let buf = file.read_node(key).map_err(|e| e.to_string())?;
        write_node_points(&mut writer, &buf, has_color).map_err(|e| e.to_string())?;
        written += u64::from(buf.point_count);
    }
    writer.flush().map_err(|e| e.to_string())?;

    let elapsed = t0.elapsed().as_secs_f64();
    let output_bytes = std::fs::metadata(output).map(|m| m.len()).unwrap_or(0);
    println!("書き出した点数: {written}");
    println!("出力サイズ    : {:.2} MB", output_bytes as f64 / 1e6);
    println!("所要時間      : {elapsed:.2} 秒");

    if written != total_points {
        return Err(format!(
            "書き出した点数({written})がヘッダーの申告点数({total_points})と一致しない"
        ));
    }
    Ok(())
}

fn write_header(w: &mut impl Write, total_points: u64, has_color: bool) -> std::io::Result<()> {
    writeln!(w, "# .PCD v0.7 - Point Cloud Data file format")?;
    writeln!(w, "VERSION 0.7")?;
    if has_color {
        writeln!(w, "FIELDS x y z intensity rgb")?;
        writeln!(w, "SIZE 8 8 8 2 4")?;
        writeln!(w, "TYPE F F F U U")?;
        writeln!(w, "COUNT 1 1 1 1 1")?;
    } else {
        writeln!(w, "FIELDS x y z intensity")?;
        writeln!(w, "SIZE 8 8 8 2")?;
        writeln!(w, "TYPE F F F U")?;
        writeln!(w, "COUNT 1 1 1 1")?;
    }
    writeln!(w, "WIDTH {total_points}")?;
    writeln!(w, "HEIGHT 1")?;
    // VIEWPOINTは既定値(無回転・原点)を書くだけで、読み込み側では使われない
    // (モジュール冒頭コメント参照)。PCDの仕様上は必須のヘッダー行。
    writeln!(w, "VIEWPOINT 0 0 0 1 0 0 0")?;
    writeln!(w, "POINTS {total_points}")?;
    writeln!(w, "DATA binary")?;
    Ok(())
}

/// `NodeBuffer`(M1-2の32B固定ヘッダー + 20B/点。`pcv_core::node_format`参照)を
/// 読み解き、世界座標(f64)に戻しながらPCDのbinaryレコードとして書く。
///
/// 相対座標(f32)をヘッダーの原点(f32に丸め済み)へ足し戻すだけで、
/// `node_format::encode_node`が行う計算をそのまま逆に辿っている
/// (`crates/pcv-core/src/copc.rs`の`copc_file_tests`モジュールにある
/// `point_color_at`ヘルパーと同じオフセット計算)。
fn write_node_points(w: &mut impl Write, buf: &NodeBuffer, has_color: bool) -> std::io::Result<()> {
    let origin_x = f32::from_le_bytes(buf.bytes[16..20].try_into().unwrap());
    let origin_y = f32::from_le_bytes(buf.bytes[20..24].try_into().unwrap());
    let origin_z = f32::from_le_bytes(buf.bytes[24..28].try_into().unwrap());

    let count = buf.point_count as usize;
    for i in 0..count {
        let offset = HEADER_BYTES + i * POINT_STRIDE;
        let rel_x = f32::from_le_bytes(buf.bytes[offset..offset + 4].try_into().unwrap());
        let rel_y = f32::from_le_bytes(buf.bytes[offset + 4..offset + 8].try_into().unwrap());
        let rel_z = f32::from_le_bytes(buf.bytes[offset + 8..offset + 12].try_into().unwrap());
        let r = buf.bytes[offset + 12];
        let g = buf.bytes[offset + 13];
        let b = buf.bytes[offset + 14];
        let intensity = u16::from_le_bytes(buf.bytes[offset + 16..offset + 18].try_into().unwrap());

        let x = f64::from(origin_x) + f64::from(rel_x);
        let y = f64::from(origin_y) + f64::from(rel_y);
        let z = f64::from(origin_z) + f64::from(rel_z);

        w.write_all(&x.to_le_bytes())?;
        w.write_all(&y.to_le_bytes())?;
        w.write_all(&z.to_le_bytes())?;
        w.write_all(&intensity.to_le_bytes())?;
        if has_color {
            let packed: u32 = (u32::from(r) << 16) | (u32::from(g) << 8) | u32::from(b);
            w.write_all(&packed.to_le_bytes())?;
        }
    }
    Ok(())
}
