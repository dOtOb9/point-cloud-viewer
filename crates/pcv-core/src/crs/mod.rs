//! 座標参照系(CRS): 平面直角座標系19系とUTMの変換、およびLAS/LAZからのCRS判定。
//!
//! # 範囲(M4-5)
//!
//! - 平面直角座標系19系(JGD2000/JGD2011)とUTM(51N〜56N)の順変換・逆変換・相互変換
//! - LAS/LAZのCRS(GeoTIFFキーまたはWKTのVLR)を読み、対応範囲の系かどうかを判定する
//!
//! やらないこと(ADR-0008、M4-import-and-conversion.md M4-5参照):
//! - 旧日本測地系(Tokyo Datum)からの変換
//! - 鉛直座標系(ジオイド)
//! - JGD2000⇄JGD2011の座標補正(パラメータファイルが必要。ただし型として区別はする)
//! - 複数データの重ね合わせ表示(ビューアが1ファイルしか開けないため。ここでは
//!   「系の異なる点を緯度経度を経由して変換する」計算の口だけ用意する)
//!
//! # モジュール構成
//!
//! - `ellipsoid`: GRS80 / WGS84
//! - `transverse_mercator`: 横メルカトルの順変換・逆変換のエンジン本体(数式)
//! - `plane_rectangular`: 平面直角座標系19系のパラメータ表
//! - `utm`: UTM(51N〜56N)のパラメータ表
//! - このファイル: 上記をまとめる`Crs`列挙型、EPSGコードとの対応、
//!   LAS VLRからのCRS判定、精度検証用の統合テスト

pub mod ellipsoid;
pub mod plane_rectangular;
pub mod transverse_mercator;
pub mod utm;

pub use ellipsoid::{Ellipsoid, GRS80, WGS84};
pub use plane_rectangular::{JgdEpoch, PlaneRectangularCrs, PlaneRectangularZone};
pub use transverse_mercator::{ForwardResult, InverseResult};
pub use utm::{UtmCrs, UtmZone};

/// 本crateが認識できる座標参照系。
///
/// `Unknown`は「読み取れたが対応範囲外」と「読み取れなかった」の両方を表す。
/// ADR-0008により、対応範囲外のCRSは常に「不明」として扱い、計測や重ね合わせに
/// 使わせないこと、という方針に対応する。
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Crs {
    PlaneRectangular(PlaneRectangularCrs),
    Utm(UtmCrs),
    /// 対応範囲外、またはCRS情報自体が読み取れなかった。
    Unknown,
}

impl Crs {
    /// EPSGコードから`Crs`を判定する。
    ///
    /// - JGD2011 平面直角座標系: EPSG:6669(I系)〜6687(XIX系) = 6668 + 系番号。
    ///   出典: EPSG:6669 "JGD2011 / Japan Plane Rectangular CS I"、
    ///   EPSG:6677 "JGD2011 / Japan Plane Rectangular CS IX"
    ///   (<https://epsg.io/6669>, <https://epsg.io/6677>で実装時に確認)。
    /// - JGD2000 平面直角座標系: EPSG:2443(I系)〜2461(XIX系) = 2442 + 系番号。
    ///   出典: EPSG:2443 "JGD2000 / Japan Plane Rectangular CS I"
    ///   (<https://epsg.io/2443>で実装時に確認)。
    /// - UTM(WGS84, 北半球): EPSG:326xx = 32600 + 帯番号。対応範囲51〜56のみ。
    ///   ADR-0008に記載のとおり、この対応関係はEPSGレジストリで実装時に確認した
    ///   (ADR-0008自体の記述を鵜呑みにしない)。
    pub fn from_epsg(code: u32) -> Crs {
        const JGD2011_BASE: u32 = 6668;
        const JGD2000_BASE: u32 = 2442;
        const UTM_NORTH_BASE: u32 = 32600;

        if (JGD2011_BASE + 1..=JGD2011_BASE + 19).contains(&code) {
            let number = (code - JGD2011_BASE) as u8;
            if let Some(crs) = PlaneRectangularCrs::new(number, JgdEpoch::Jgd2011) {
                return Crs::PlaneRectangular(crs);
            }
        }
        if (JGD2000_BASE + 1..=JGD2000_BASE + 19).contains(&code) {
            let number = (code - JGD2000_BASE) as u8;
            if let Some(crs) = PlaneRectangularCrs::new(number, JgdEpoch::Jgd2000) {
                return Crs::PlaneRectangular(crs);
            }
        }
        if code > UTM_NORTH_BASE && code <= UTM_NORTH_BASE + 60 {
            let zone = (code - UTM_NORTH_BASE) as u8;
            if let Some(crs) = UtmCrs::new(zone) {
                return Crs::Utm(crs);
            }
        }
        Crs::Unknown
    }
}

/// LASヘッダーのVLR(GeoTIFFキー、またはWKT)からEPSGコードを取り出し、`Crs`に変換する。
///
/// `las::Header`から直接読む(`las`クレート0.10がGeoTIFF/WKTの解析を標準機能として
/// 持っているため、パーサを自前で書く必要はなかった。`las::Header::get_geotiff_crs()`と
/// `las::Header::get_wkt_crs_bytes()`を使う。どちらも`copc-reader`が依存する`las`と
/// 同じバージョンで、`copc-reader`自身はCOPC/LASzip関連VLR以外を読み捨てるため
/// (`vendor/copc-reader/src/lib.rs`の`should_store_vlr`参照)、CRSを読むには
/// `copc-reader`のAPIではなく`las`クレートでヘッダーを開き直す必要がある。
/// これが「`copc-reader`/`las`のどこでVLRを取れるか調べて決める」の結論である)。
pub fn detect_crs_from_las_header(header: &las::Header) -> Crs {
    if let Some(wkt) = header.get_wkt_crs_bytes() {
        if let Some(code) = epsg_from_wkt(wkt) {
            return Crs::from_epsg(code);
        }
        return Crs::Unknown;
    }
    match header.get_geotiff_crs() {
        Ok(Some(geotiff)) => {
            // ProjectedCRSGeoKey(3072)を優先する。地理座標系のみ(GeodeticCRSGeoKey
            // だけが設定されている)場合は、投影された平面座標系ではないため
            // 本crateの対応範囲外=Unknownとして扱う。
            match geotiff.get_projected_crs_geo_key_value() {
                Some(code) if (1..=32766).contains(&code) => Crs::from_epsg(code as u32),
                _ => Crs::Unknown,
            }
        }
        _ => Crs::Unknown,
    }
}

/// WKT文字列(バイト列)からEPSGコードを取り出す。
///
/// WKTは `...GEOGCS[...,AUTHORITY["EPSG","6668"]],...,AUTHORITY["EPSG","6677"]]`
/// のように、地理座標系(GEOGCS)のEPSGコードが先に、投影された座標系(PROJCS)自身の
/// EPSGコードが最後に現れる(PatchJGDの出力やQGIS等の実例で確認できる一般的な構造)。
/// そのため「最後に現れるAUTHORITY["EPSG","N"]」を採用する。
/// (`VERT_CS`/`VERTCRS`以降は鉛直座標系のEPSGコードなので、それより前の部分だけを見る。
/// これは`las-crs`クレート(0.1.1)の`get_wkt_epsg`と同じ考え方。ただし本crateは
/// `las-crs`クレートには依存せず、必要な部分だけを自前で書いた。理由:
/// `las-crs`は`las`0.9系に依存しており、`copc-reader`が使う`las`0.10系と衝突するため)。
fn epsg_from_wkt(bytes: &[u8]) -> Option<u32> {
    let wkt = String::from_utf8_lossy(bytes);
    let horizontal = wkt.split("VERT").next().unwrap_or(&wkt);
    horizontal
        .rmatch_indices("AUTHORITY[\"EPSG\",\"")
        .next()
        .and_then(|(start, matched)| {
            let after = &horizontal[start + matched.len()..];
            let digits: String = after.chars().take_while(|c| c.is_ascii_digit()).collect();
            digits.parse::<u32>().ok()
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_close_m(actual: f64, expected: f64, tol_m: f64, what: &str) {
        let diff = (actual - expected).abs();
        assert!(
            diff <= tol_m,
            "{what}: actual={actual}, expected={expected}, diff={diff}m (tol={tol_m}m)"
        );
    }

    // ------------------------------------------------------------------
    // 1. 平面直角座標系: 国土地理院「測量計算サイト」APIの実測値によるmmオーダー検証
    // ------------------------------------------------------------------
    //
    // 出典: 国土地理院 測量計算サイト 測量計算API
    //   API仕様: https://vldb.gsi.go.jp/sokuchi/surveycalc/api_help.html
    //   緯度経度→平面直角座標: https://vldb.gsi.go.jp/sokuchi/surveycalc/surveycalc/bl2xy.pl
    //   平面直角座標→緯度経度: https://vldb.gsi.go.jp/sokuchi/surveycalc/surveycalc/xy2bl.pl
    //
    // 以下の入出力値は、2026-09-24に下記のURLを実際に取得して得たもの(国土地理院の
    // サーバ自身が計算した結果であり、本実装で計算した値ではない)。他の資料と違い
    // 「静的に公開された数値例」ではなく都度計算されるAPIだが、パラメータ(refFrame=2は
    // 世界測地系、zoneは系番号)を指定すれば誰でも同じ結果を再現・検証できるため、
    // 出典の明確な公開資料として扱う。再現手順:
    //   curl -sL "https://vldb.gsi.go.jp/sokuchi/surveycalc/surveycalc/bl2xy.pl?outputType=json&refFrame=2&zone=<系番号>&latitude=<緯度>&longitude=<経度>"
    // レスポンスのpublicX/publicYは小数点以下4桁(0.1mm)まで含まれる。
    //
    // 縮尺係数m0=0.9999の平面直角座標系はJGD2000/JGD2011で楕円体・原点定義が同一
    // (このファイルの`plane_rectangular`モジュールのコメント参照)なので、
    // このテストはJGD2011のデータとして扱うが、JGD2000でも同じ数式が適用される
    // ことに変わりはない。

    #[test]
    fn gsi_api_ix_system_tokyo_station_area() {
        // curl -sL ".../bl2xy.pl?outputType=json&refFrame=2&zone=9&latitude=35.681236&longitude=139.767125"
        // => {"publicX":"-35363.2377","publicY":"-5992.9196","gridConv":"0.038616667","scaleFactor":"0.99990044"}
        let crs = PlaneRectangularCrs::new(9, JgdEpoch::Jgd2011).unwrap();
        let r = crs.project(35.681236_f64.to_radians(), 139.767125_f64.to_radians());
        assert_close_m(r.x, -35363.2377, 0.0005, "IX系 X");
        assert_close_m(r.y, -5992.9196, 0.0005, "IX系 Y");
        let grid_conv_deg = r.meridian_convergence_rad.to_degrees();
        // gridConvはAPIの応答が小数点以下9桁で打ち切られているため、度単位で
        // 2e-6度(≈0.2mm相当の弧)までの差は丸め由来として許容する。
        assert_close_m(grid_conv_deg, 0.038616667, 2e-6, "IX系 子午線収差角[度]");
        assert_close_m(r.scale_factor, 0.99990044, 1e-7, "IX系 縮尺係数");
    }

    #[test]
    fn gsi_api_i_system_kyushu() {
        // curl -sL ".../bl2xy.pl?outputType=json&refFrame=2&zone=1&latitude=33.1595&longitude=129.7233"
        // => {"publicX":"17709.9187","publicY":"20828.4124","gridConv":"-0.122138889","scaleFactor":"0.99990535"}
        let crs = PlaneRectangularCrs::new(1, JgdEpoch::Jgd2011).unwrap();
        let r = crs.project(33.1595_f64.to_radians(), 129.7233_f64.to_radians());
        assert_close_m(r.x, 17709.9187, 0.0005, "I系 X");
        assert_close_m(r.y, 20828.4124, 0.0005, "I系 Y");
        assert_close_m(
            r.meridian_convergence_rad.to_degrees(),
            -0.122138889,
            2e-6,
            "I系 子午線収差角[度]",
        );
        assert_close_m(r.scale_factor, 0.99990535, 1e-7, "I系 縮尺係数");
    }

    #[test]
    fn gsi_api_xix_system_remote_island() {
        // 系番号19(南鳥島周辺)は現実の市街地が無いため、原点近傍の任意点で検証する。
        // curl -sL ".../bl2xy.pl?outputType=json&refFrame=2&zone=19&latitude=26.5&longitude=154.5"
        // => {"publicX":"55487.4167","publicY":"49840.4455","gridConv":"-0.223102778","scaleFactor":"0.99993066"}
        let crs = PlaneRectangularCrs::new(19, JgdEpoch::Jgd2011).unwrap();
        let r = crs.project(26.5_f64.to_radians(), 154.5_f64.to_radians());
        assert_close_m(r.x, 55487.4167, 0.0005, "XIX系 X");
        assert_close_m(r.y, 49840.4455, 0.0005, "XIX系 Y");
    }

    #[test]
    fn gsi_api_ix_system_far_from_origin_edge_of_zone() {
        // 「系の端(原点から離れた位置)でも精度が保たれるか」の確認。
        // IX系原点(139°50'E)から東へ約1.45度(緯度36度で約130km)離れた地点。
        // curl -sL ".../bl2xy.pl?outputType=json&refFrame=2&zone=9&latitude=36.0&longitude=141.3"
        // => {"publicX":"994.9177","publicY":"132231.3547","gridConv":"-0.862211111","scaleFactor":"1.00011539"}
        let crs = PlaneRectangularCrs::new(9, JgdEpoch::Jgd2011).unwrap();
        let r = crs.project(36.0_f64.to_radians(), 141.3_f64.to_radians());
        assert_close_m(r.x, 994.9177, 0.0005, "IX系端 X");
        assert_close_m(r.y, 132231.3547, 0.0005, "IX系端 Y");
    }

    #[test]
    fn gsi_api_vii_system_inverse() {
        // 逆変換(平面直角座標→緯度経度)を、順変換の結果を使い回すのではなく
        // 独立にAPIへ問い合わせて検証する。
        // curl -sL ".../xy2bl.pl?outputType=json&refFrame=2&zone=7&publicX=50000.000&publicY=-20000.000"
        // => {"latitude":"36.45043645","longitude":"136.94355016","gridConv":"0.132561111111111","scaleFactor":"0.99990493"}
        let crs = PlaneRectangularCrs::new(7, JgdEpoch::Jgd2011).unwrap();
        let r = crs.unproject(50000.000, -20000.000);
        let lat_deg = r.lat_rad.to_degrees();
        let lon_deg = r.lon_rad.to_degrees();
        // 緯度経度は度単位小数点以下8桁で与えられている(赤道上で約1.1mm相当)。
        // 1e-8度 ≈ 1.1mmなので、許容誤差を2e-8度(≈2mm)に取る。
        assert_close_m(lat_deg, 36.45043645, 2e-8, "VII系逆変換 緯度[度]");
        assert_close_m(lon_deg, 136.94355016, 2e-8, "VII系逆変換 経度[度]");
        assert_close_m(
            r.meridian_convergence_rad.to_degrees(),
            0.132561111111111,
            2e-6,
            "VII系逆変換 子午線収差角[度]",
        );
        assert_close_m(r.scale_factor, 0.99990493, 1e-7, "VII系逆変換 縮尺係数");
    }

    // ------------------------------------------------------------------
    // 2. 往復テスト(順変換→逆変換で戻ることの確認。出典付きテストとは別物)
    // ------------------------------------------------------------------

    #[test]
    fn round_trip_multiple_zones_and_positions() {
        let cases: &[(u8, f64, f64)] = &[
            (9, 35.681236, 139.767125),
            (1, 33.1595, 129.7233),
            (19, 26.5, 154.5),
            (9, 36.0, 141.3),
            (13, 43.0, 144.5),
        ];
        for &(zone, lat_deg, lon_deg) in cases {
            let crs = PlaneRectangularCrs::new(zone, JgdEpoch::Jgd2011).unwrap();
            let lat = lat_deg.to_radians();
            let lon = lon_deg.to_radians();
            let f = crs.project(lat, lon);
            let inv = crs.unproject(f.x, f.y);
            let lat_diff_m = (inv.lat_rad - lat) * 6_378_137.0;
            let lon_diff_m = (inv.lon_rad - lon) * 6_378_137.0 * lat.cos();
            assert!(
                lat_diff_m.abs() < 1e-6,
                "zone {zone} lat diff {lat_diff_m} m"
            );
            assert!(
                lon_diff_m.abs() < 1e-6,
                "zone {zone} lon diff {lon_diff_m} m"
            );
        }
    }

    // ------------------------------------------------------------------
    // 3. 横メルカトルの一般式そのものの検証(GRS80/平面直角座標系に限らない)
    // ------------------------------------------------------------------
    //
    // 出典: Karney, C.F.F. (2011), "Transverse Mercator with an accuracy of a
    // few nanometers", Journal of Geodesy 85:475-485の検証用データセット
    // `TMcoords.dat`(GeographicLibプロジェクトが公開)。
    //   配布元: https://sourceforge.net/projects/geographiclib/files/testdata/TMcoords.dat.gz
    //   フォーマット(配布元の説明): 緯度[度] 経度(中央子午線からの差)[度]
    //     easting[m] northing[m] 子午線収差角[度] 縮尺係数
    //     楕円体はWGS84、中央子午線は0度、縮尺係数は0.9996(UTM相当)、
    //     false easting/northingは0。
    //
    // 平面直角座標系19系はいずれも中央子午線から±130km程度の範囲でしか使わないため、
    // GSI APIによる検証(上記1)だけでは「UTMのように中央子午線から数百km離れた場所」
    // での精度は確認できない。このテストは中央子午線から離れた場合(Δλが数度)の
    // 横メルカトル変換式そのものの正しさを、GRS80とは別の楕円体(WGS84)・
    // 別の経度差で、独立した文献の検証用データセットに対して確認するためのものである。
    //
    // 取得手順(再現用。ファイルは2.4GB超のため、先頭2,000,001バイトだけを部分取得し、
    // gzip解凍できた範囲内から該当行を取り出した):
    //   curl -s -r 0-2000000 \
    //     "https://sourceforge.net/projects/geographiclib/files/testdata/TMcoords.dat.gz/download" \
    //     | gzip -dc 2>/dev/null | sed -n '1124p;1063p'
    // (2026-09-24に取得。壊れていないことは、行の値が
    //  「easting ≈ k0 * N(lat) * cos(lat) * Δλ[rad]」という横メルカトルの1次近似式と
    //  桁・符号ともに整合することを目視で確認している。)

    #[test]
    fn karney_2011_tmcoords_small_delta_lambda() {
        // TMcoords.dat 1124行目:
        // 41.883357469578 .582386968573 48319.9780433339987 4636989.6238090794305 .388818555910566651 .99962872983010804012
        let ellipsoid = Ellipsoid {
            semi_major_axis: 6_378_137.0,
            inverse_flattening: 298.257_223_563,
        };
        let params = transverse_mercator::TransverseMercatorParams {
            ellipsoid,
            origin_lat_rad: 0.0,
            origin_lon_rad: 0.0,
            scale_factor: 0.9996,
            false_easting: 0.0,
            false_northing: 0.0,
        };
        let lat = 41.883357469578_f64.to_radians();
        let lon = 0.582386968573_f64.to_radians();
        let r = transverse_mercator::forward(&params, lat, lon);
        // このデータセットではx=northing, y=eastingがそれぞれ河瀬式のx,yと対応する。
        // clippy::excessive_precisionにより、f64が実際に表現できる桁数(元データの
        // 小数点以下17桁のうち、f64のビット表現上意味を持つ範囲)に丸めた
        // リテラルを使う。元データそのものは直上のコメントを参照。
        assert_close_m(r.y, 48_319.978_043_334, 1e-6, "Karney easting");
        assert_close_m(r.x, 4_636_989.623_809_08, 1e-6, "Karney northing");
    }

    #[test]
    fn karney_2011_tmcoords_larger_delta_lambda() {
        // TMcoords.dat 1063行目(中央子午線から約2.52度、UTM帯の半幅3度に近い):
        // 29.524235381756 2.523399708599 244569.524213355782 3268723.7586167129286 1.244128757596883122 1.00033810318827897654
        let ellipsoid = Ellipsoid {
            semi_major_axis: 6_378_137.0,
            inverse_flattening: 298.257_223_563,
        };
        let params = transverse_mercator::TransverseMercatorParams {
            ellipsoid,
            origin_lat_rad: 0.0,
            origin_lon_rad: 0.0,
            scale_factor: 0.9996,
            false_easting: 0.0,
            false_northing: 0.0,
        };
        let lat = 29.524235381756_f64.to_radians();
        let lon = 2.523399708599_f64.to_radians();
        let r = transverse_mercator::forward(&params, lat, lon);
        assert_close_m(r.y, 244_569.524_213_355_8, 1e-6, "Karney easting (wide)");
        assert_close_m(r.x, 3_268_723.758_616_713, 1e-6, "Karney northing (wide)");
    }

    // ------------------------------------------------------------------
    // 4. 系の間の変換(緯度経度を経由。平面直角IX系 → UTM 54N)
    // ------------------------------------------------------------------

    #[test]
    fn cross_zone_conversion_via_lat_lon() {
        let ix = PlaneRectangularCrs::new(9, JgdEpoch::Jgd2011).unwrap();
        let lat = 35.681236_f64.to_radians();
        let lon = 139.767125_f64.to_radians();
        let plane = ix.project(lat, lon);

        // 平面直角座標→緯度経度→UTM 54N、という経路。
        let back = ix.unproject(plane.x, plane.y);
        let utm54 = UtmCrs::new(54).unwrap();
        let utm = utm54.project(back.lat_rad, back.lon_rad);

        // UTM 54Nの中央子午線は東経141度。東経139.767125度は西側なので
        // easting(y)は500000mより小さくなるはず、という符号の妥当性を確認する。
        assert!(utm.y < 500_000.0);
        // 北緯35.68度付近のnorthingはおよそ3,950,000m前後になる(緯度1度がおよそ
        // 110.9kmであることからの概算)。極端な値になっていないことの粗いチェック。
        assert!((3_900_000.0..4_000_000.0).contains(&utm.x));
    }

    // ------------------------------------------------------------------
    // 5. EPSGコード判定
    // ------------------------------------------------------------------

    #[test]
    fn epsg_maps_to_expected_crs() {
        match Crs::from_epsg(6677) {
            Crs::PlaneRectangular(crs) => {
                assert_eq!(crs.zone.number, 9);
                assert_eq!(crs.epoch, JgdEpoch::Jgd2011);
            }
            other => panic!("unexpected {other:?}"),
        }
        match Crs::from_epsg(2451) {
            Crs::PlaneRectangular(crs) => {
                assert_eq!(crs.zone.number, 9);
                assert_eq!(crs.epoch, JgdEpoch::Jgd2000);
            }
            other => panic!("unexpected {other:?}"),
        }
        match Crs::from_epsg(32654) {
            Crs::Utm(crs) => assert_eq!(crs.zone.number, 54),
            other => panic!("unexpected {other:?}"),
        }
        // 対応範囲外の帯(例: 60N)や無関係なコードはUnknown。
        assert!(matches!(Crs::from_epsg(32660), Crs::Unknown));
        assert!(matches!(Crs::from_epsg(4326), Crs::Unknown));
    }

    // ------------------------------------------------------------------
    // 6. LASヘッダーからのCRS判定(テスト内でVLRを組み立てる)
    // ------------------------------------------------------------------

    fn header_with_geotiff_projected_crs(epsg: u16) -> las::Header {
        let mut builder = las::Builder::from((1, 4));
        let mut main_vlr_data = Vec::new();
        // GeoKeyDirectoryTag: KeyDirectoryVersion=1, KeyRevision=1, MinorRevision=1,
        // NumberOfKeys=1
        main_vlr_data.extend_from_slice(&1u16.to_le_bytes());
        main_vlr_data.extend_from_slice(&1u16.to_le_bytes());
        main_vlr_data.extend_from_slice(&1u16.to_le_bytes());
        main_vlr_data.extend_from_slice(&1u16.to_le_bytes());
        // 1個のキー: ProjectedCRSGeoKey(3072), location=0(値そのもの), count=1, value=epsg
        main_vlr_data.extend_from_slice(&3072u16.to_le_bytes());
        main_vlr_data.extend_from_slice(&0u16.to_le_bytes());
        main_vlr_data.extend_from_slice(&1u16.to_le_bytes());
        main_vlr_data.extend_from_slice(&epsg.to_le_bytes());

        let vlr = las::Vlr {
            user_id: "LASF_Projection".to_string(),
            record_id: 34735,
            description: String::new(),
            data: main_vlr_data,
        };
        builder.vlrs.push(vlr);
        builder.into_header().expect("valid header")
    }

    fn header_with_wkt_crs(wkt: &str) -> las::Header {
        let builder = las::Builder::from((1, 4));
        let mut header = builder.into_header().expect("valid header");
        // set_wkt_crsはLAS1.4以上が必要(このテストのbuilderはLAS1.4)。
        header
            .set_wkt_crs(wkt.as_bytes().to_vec())
            .expect("set wkt");
        header
    }

    #[test]
    fn detect_crs_from_geotiff_projected_key_jgd2011_ix() {
        let header = header_with_geotiff_projected_crs(6677);
        match detect_crs_from_las_header(&header) {
            Crs::PlaneRectangular(crs) => {
                assert_eq!(crs.zone.number, 9);
                assert_eq!(crs.epoch, JgdEpoch::Jgd2011);
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn detect_crs_from_geotiff_unsupported_epsg_is_unknown() {
        // 対応範囲外のEPSGコード(例: 適当な海外の座標系)は「不明」として扱う。
        let header = header_with_geotiff_projected_crs(3857);
        assert!(matches!(detect_crs_from_las_header(&header), Crs::Unknown));
    }

    #[test]
    fn detect_crs_from_wkt_utm54n() {
        // 簡略化したWKT(実際のWKTはもっと長いが、AUTHORITY部分だけが判定に効く)。
        let wkt = "PROJCS[\"WGS 84 / UTM zone 54N\",GEOGCS[\"WGS 84\",AUTHORITY[\"EPSG\",\"4326\"]],AUTHORITY[\"EPSG\",\"32654\"]]";
        let header = header_with_wkt_crs(wkt);
        match detect_crs_from_las_header(&header) {
            Crs::Utm(crs) => assert_eq!(crs.zone.number, 54),
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn detect_crs_from_wkt_ignores_vertical_authority() {
        // WKTに鉛直座標系(VERT_CS)が付いている場合、水平成分のAUTHORITYだけを見る。
        let wkt = "PROJCS[\"JGD2011 / Japan Plane Rectangular CS IX\",AUTHORITY[\"EPSG\",\"6677\"]],VERT_CS[\"JGD2011 height\",AUTHORITY[\"EPSG\",\"6695\"]]";
        let header = header_with_wkt_crs(wkt);
        match detect_crs_from_las_header(&header) {
            Crs::PlaneRectangular(crs) => assert_eq!(crs.zone.number, 9),
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn detect_crs_missing_returns_unknown() {
        let builder = las::Builder::from((1, 4));
        let header = builder.into_header().expect("valid header");
        assert!(matches!(detect_crs_from_las_header(&header), Crs::Unknown));
    }
}
