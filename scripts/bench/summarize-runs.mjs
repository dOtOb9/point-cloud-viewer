import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseSamples, summarizeSamples } from "./summarize-samples.mjs";
import { fileURLToPath } from "node:url";

export const FIELDS = [
  "t_addLayer_s", "t_first_node_read_s", "first_node_read_ms", "t_first_node_loaded_s", "first_node_handle_ms",
  "t_first_draw_s", "t_settled_s", "settled_points", "wall_since_select_s", "peak_private_mib",
];

export function summarizeRuns(runs) {
  const groups = new Map();
  for (const { name, json } of runs) {
    const scenario = name.replace(/-\d+$/, "");
    if (!groups.has(scenario)) groups.set(scenario, []);
    groups.get(scenario).push(json);
  }
  const out = {};
  for (const [scenario, list] of groups) {
    out[scenario] = {};
    for (const field of FIELDS) {
      const values = list.map((j) => j[field]).filter((v) => typeof v === "number");
      if (values.length > 0) out[scenario][field] = [Math.min(...values), Math.max(...values), values.length];
    }
    out[scenario].outcomes = [...new Set(list.map((j) => j.outcome))];
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dir = process.argv[2];
  if (!dir) { console.error("usage: node scripts/bench/summarize-runs.mjs <dir>"); process.exit(2); }
  const runs = readdirSync(dir)
    .filter((f) => /^web-.*\.json$/.test(f))
    .map((f) => {
      const json = JSON.parse(readFileSync(join(dir, f), "utf8"));
      const csv = join(dir, f.replace(/\.json$/, ".mem.csv"));
      if (existsSync(csv)) json.peak_private_mib = summarizeSamples(parseSamples(readFileSync(csv, "utf8"))).peakPrivateMib;
      return { name: f.replace(/^web-/, "").replace(/\.json$/, ""), json };
    });
  console.log(JSON.stringify(summarizeRuns(runs), null, 2));
}
