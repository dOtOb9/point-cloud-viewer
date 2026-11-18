import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;

export function parseSamples(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) throw new Error("empty CSV");
  const header = lines[0].split(",").map((h) => h.trim());
  if (header.includes("") || new Set(header).size !== header.length) throw new Error(`bad header: ${lines[0]}`);
  return lines.slice(1).map((line, i) => {
    const cells = line.split(",").map((c) => c.trim());
    if (cells.length !== header.length) {
      throw new Error(`line ${i + 2}: ${cells.length} columns, expected ${header.length} (${header.join(",")}): "${line}"`);
    }
    const row = {};
    header.forEach((name, k) => {
      if (!PLAIN_NUMBER.test(cells[k])) throw new Error(`line ${i + 2}: "${cells[k]}" in column ${name} is not a plain number`);
      row[name] = Number(cells[k]);
    });
    return row;
  });
}

export function summarizeSamples(rows) {
  if (rows.length === 0) throw new Error("no sample rows");
  if (!("private_mib" in rows[0])) throw new Error("no private_mib column");
  const peakPrivateMib = Math.max(...rows.map((r) => r.private_mib));
  const minFreeGb = "free_gb" in rows[0] ? Math.min(...rows.map((r) => r.free_gb)) : null;
  return { samples: rows.length, peakPrivateMib, minFreeGb };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: node scripts/bench/summarize-samples.mjs <file.csv>");
    process.exit(2);
  }
  console.log(JSON.stringify(summarizeSamples(parseSamples(readFileSync(file, "utf8")))));
}
