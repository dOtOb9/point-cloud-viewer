// One command that runs the checks CI runs (so "done" means the same locally and in CI): `npm run check:all`.
// It runs every step even when one fails, then lists the results (the first failure alone hides the rest).
// On Windows the working directory is given with an upper-case drive letter: vitest fails every file when it is
// started from `c:\...` (AGENTS.md). The steps are the ones of the `frontend` and `rust` jobs in .github/workflows/ci.yml
// that need no extra setup; wasm / e2e / tauri builds are left to CI.
import { spawnSync } from "node:child_process";

let cwd = process.cwd();
if (/^[a-z]:/.test(cwd)) cwd = cwd[0].toUpperCase() + cwd.slice(1);

const STEPS = [
  ["typecheck", "npm run typecheck"],
  ["lint", "npm run lint"],
  ["check:circular", "npm run check:circular"],
  ["check:docs", "npm run check:docs"],
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
