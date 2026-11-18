use std::io::{BufWriter, Write};

use super::DtmError;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LandXmlUnit {
    Meter,
    Foot,
    UsSurveyFoot,
    #[default]
    Unknown,
}

#[derive(Debug, Clone, Copy)]
pub struct LandXmlOptions<'a> {
    pub name: &'a str,
    pub unit: LandXmlUnit,
    pub unix_seconds: i64,
}

fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            c => out.push(c),
        }
    }
    out
}

pub fn utc_date_time(unix_seconds: i64) -> (String, String) {
    let days = unix_seconds.div_euclid(86_400);
    let secs = unix_seconds.rem_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    (
        format!("{year:04}-{month:02}-{day:02}"),
        format!(
            "{:02}:{:02}:{:02}",
            secs / 3_600,
            secs % 3_600 / 60,
            secs % 60
        ),
    )
}

fn units_element(unit: LandXmlUnit) -> Option<&'static str> {
    match unit {
        LandXmlUnit::Meter => Some(concat!(
            "  <Units>\n    <Metric areaUnit=\"squareMeter\" linearUnit=\"meter\" volumeUnit=\"cubicMeter\" ",
            "temperatureUnit=\"celsius\" pressureUnit=\"milliBars\" diameterUnit=\"millimeter\" ",
            "angularUnit=\"decimal degrees\" directionUnit=\"decimal degrees\"/>\n  </Units>\n"
        )),
        LandXmlUnit::Foot => Some(concat!(
            "  <Units>\n    <Imperial areaUnit=\"squareFoot\" linearUnit=\"foot\" volumeUnit=\"cubicFeet\" ",
            "temperatureUnit=\"fahrenheit\" pressureUnit=\"inchHG\" diameterUnit=\"inch\" ",
            "angularUnit=\"decimal degrees\" directionUnit=\"decimal degrees\"/>\n  </Units>\n"
        )),
        LandXmlUnit::UsSurveyFoot => Some(concat!(
            "  <Units>\n    <Imperial areaUnit=\"squareFoot\" linearUnit=\"USSurveyFoot\" volumeUnit=\"cubicFeet\" ",
            "temperatureUnit=\"fahrenheit\" pressureUnit=\"inchHG\" diameterUnit=\"inch\" ",
            "angularUnit=\"decimal degrees\" directionUnit=\"decimal degrees\"/>\n  </Units>\n"
        )),
        LandXmlUnit::Unknown => None,
    }
}

pub(super) fn write<W: Write>(
    out: &mut W,
    options: &LandXmlOptions<'_>,
    epsg: Option<u32>,
    points: impl Iterator<Item = (f64, f64, f64)>,
    faces: impl Iterator<Item = [usize; 3]>,
) -> Result<(), DtmError> {
    let mut w = BufWriter::new(out);
    let (date, time) = utc_date_time(options.unix_seconds);
    writeln!(w, "<?xml version=\"1.0\" encoding=\"UTF-8\"?>")?;
    writeln!(
        w,
        "<LandXML xmlns=\"http://www.landxml.org/schema/LandXML-1.2\" version=\"1.2\" date=\"{date}\" time=\"{time}\" readOnly=\"false\" language=\"English\">"
    )?;
    if let Some(units) = units_element(options.unit) {
        w.write_all(units.as_bytes())?;
    }
    if let Some(code) = epsg {
        writeln!(w, "  <CoordinateSystem epsgCode=\"{code}\"/>")?;
    }
    writeln!(w, "  <Surfaces>")?;
    writeln!(w, "    <Surface name=\"{}\">", escape(options.name))?;
    writeln!(w, "      <Definition surfType=\"TIN\">")?;
    writeln!(w, "        <Pnts>")?;
    for (i, (x, y, z)) in points.enumerate() {
        writeln!(w, "<P id=\"{}\">{y:.4} {x:.4} {z:.4}</P>", i + 1)?;
    }
    writeln!(w, "        </Pnts>")?;
    writeln!(w, "        <Faces>")?;
    for [a, b, c] in faces {
        writeln!(w, "<F>{} {} {}</F>", a + 1, b + 1, c + 1)?;
    }
    writeln!(w, "        </Faces>")?;
    writeln!(w, "      </Definition>")?;
    writeln!(w, "    </Surface>")?;
    writeln!(w, "  </Surfaces>")?;
    writeln!(w, "</LandXML>")?;
    w.flush()?;
    Ok(())
}
