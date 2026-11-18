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

    let mut keys: Vec<_> = file.hierarchy().nodes().map(|n| n.key).collect();
    keys.sort_by_key(|k| (k.level, k.x, k.y, k.z));

    let out = File::create(output).map_err(|e| e.to_string())?;
    let mut writer = BufWriter::new(out);
    write_header(&mut writer, total_points, has_color).map_err(|e| e.to_string())?;

    let mut written: u64 = 0;
    for key in keys {
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
    writeln!(w, "VIEWPOINT 0 0 0 1 0 0 0")?;
    writeln!(w, "POINTS {total_points}")?;
    writeln!(w, "DATA binary")?;
    Ok(())
}

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
