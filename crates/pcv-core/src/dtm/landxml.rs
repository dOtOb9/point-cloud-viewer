//! LandXML 1.2 writer for a TIN surface (G1-T15).
//!
//! Only the standard elements are written: `Units`, `CoordinateSystem` (EPSG code, when known) and one
//! `Surface` with `Definition surfType="TIN"` holding `Pnts` and `Faces`. J-LandXML specific elements are not
//! written (the specification was not read; plan 9.3).
//!
//! # Coordinate order
//!
//! A LandXML point `<P>` is **northing easting elevation** ("N E Z", i.e. Y X Z), not X Y Z. This writer follows that
//! convention; the test `landxml_points_are_north_east_elevation` checks it.
//!
//! # Face order
//!
//! `spade` returns the three vertices of a face counter-clockwise, and LandXML wants the corners of a face in
//! counter-clockwise order seen from above, so they are written as they come. Point ids start at 1.
//!
//! # Streaming
//!
//! The points and faces are written one by one to the writer. The text is never built in memory as a whole.

use std::io::{BufWriter, Write};

use super::DtmError;

/// The unit of the file's horizontal coordinates, for the `Units` element.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LandXmlUnit {
    Meter,
    Foot,
    UsSurveyFoot,
    /// The CRS did not say: no `Units` element is written.
    #[default]
    Unknown,
}

/// What the header of the file says.
#[derive(Debug, Clone, Copy)]
pub struct LandXmlOptions<'a> {
    /// Name of the `Surface` element.
    pub name: &'a str,
    pub unit: LandXmlUnit,
    /// The time of writing in seconds since 1970-01-01 UTC. The caller reads the clock (this crate is also built for
    /// wasm32, where `SystemTime::now` panics).
    pub unix_seconds: i64,
}

/// Escapes the five XML special characters.
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

/// `(date "YYYY-MM-DD", time "HH:MM:SS")` of a UNIX time in UTC. Days to a calendar date by the
/// well-known "civil from days" algorithm (H. Hinnant).
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

/// Writes the document. `points` are `(x, y, z)` in the order of their ids; `faces` index into `points` (0-based).
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
        // Northing, easting, elevation (see the module documentation).
        writeln!(w, "          <P id=\"{}\">{y:.4} {x:.4} {z:.4}</P>", i + 1)?;
    }
    writeln!(w, "        </Pnts>")?;
    writeln!(w, "        <Faces>")?;
    for [a, b, c] in faces {
        writeln!(w, "          <F>{} {} {}</F>", a + 1, b + 1, c + 1)?;
    }
    writeln!(w, "        </Faces>")?;
    writeln!(w, "      </Definition>")?;
    writeln!(w, "    </Surface>")?;
    writeln!(w, "  </Surfaces>")?;
    writeln!(w, "</LandXML>")?;
    w.flush()?;
    Ok(())
}
