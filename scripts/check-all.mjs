import { spawnSync } from "node:child_process";

const USAGE = `usage: node scripts/check-all.mjs   (npm run check:all)

Runs the checks of the frontend and rust jobs of .github/workflows/ci.yml that need no extra setup, every step even
when one fails, then lists OK / FAILED for each (the first failure alone would hide the rest).
wasm, e2e and tauri builds are left to CI.`;

if (process.argv.includes("--help")) {
  console.log(USAGE);
  process.exit(0);
}

function withUpperCaseDriveLetter(path) {
  return /^[a-z]:/.test(path) ? path[0].toUpperCase() + path.slice(1) : path;
}

const cwd = withUpperCaseDriveLetter(process.cwd());

const STEPS = [
  ["typecheck", "npm run typecheck"],
  ["lint", "npm run lint"],
  ["check:circular", "npm run check:circular"],
  ["check:docs", "npm run check:docs"],
  ["check:comments", "npm run check:comments"],
  ["check:wasm-paths", "npm run check:wasm-paths"],
  ["vitest", "npx vitest run"],
  ["cargo fmt (workspace)", "cargo fmt --all -- --check"],
  ["cargo clippy (workspace)", "cargo clippy --workspace --all-targets -- -D warnings"],
  ["cargo fmt (vendor/copc-writer)", "cargo fmt --manifest-path vendor/copc-writer/Cargo.toml -- --check"],
];

const results = [];
for (const [name, command] of STEPS) {
  console.log(`\n=== ${name}: ${command}`);
  const r = spawnSync(command, { cwd, shell: true, stdio: "inherit" });
  results.push([name, r.status === 0]);
}

console.log("\n=== check:all summary");
for (const [name, ok] of results) console.log(`${ok ? "OK    " : "FAILED"} ${name}`);
process.exit(results.every(([, ok]) => ok) ? 0 : 1);
