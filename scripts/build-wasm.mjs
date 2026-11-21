import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const USAGE = `usage: node scripts/build-wasm.mjs   (npm run build:wasm)

Builds crates/pcv-wasm for wasm32-unknown-unknown in release and runs wasm-bindgen into src/wasm/pcv-wasm.
The absolute paths of this checkout, CARGO_HOME and the rustc sysroot are remapped (--remap-path-prefix),
so the wasm holds no path of the machine that built it.
The remap flags go after the flags already in CARGO_ENCODED_RUSTFLAGS or RUSTFLAGS.
Honors CARGO_TARGET_DIR and CARGO_HOME.`;

const RUSTFLAGS_SEPARATOR = "\x1f";

export const REMAPPED_ROOTS = ["pcv", "cargo", "rustc-sysroot"];
const [REMAPPED_REPO, REMAPPED_CARGO_HOME, REMAPPED_SYSROOT] = REMAPPED_ROOTS.map((root) => `/${root}`);

function spellingsOfWindowsPath(path) {
  const spellings = [];
  for (const drive of [path[0].toUpperCase(), path[0].toLowerCase()]) {
    const rest = path.slice(1);
    spellings.push(drive + rest.replaceAll("/", "\\"), drive + rest.replaceAll("\\", "/"));
  }
  return spellings;
}

function spellingsOf(path) {
  return /^[A-Za-z]:/.test(path) ? spellingsOfWindowsPath(path) : [path];
}

export function remapPathPrefixFlags(remaps) {
  const flags = [];
  for (const { from, to } of remaps) {
    for (const spelled of spellingsOf(from)) flags.push(`--remap-path-prefix=${spelled}=${to}`);
  }
  return flags;
}

export function encodedRustflagsWith(flags, env) {
  const given =
    env.CARGO_ENCODED_RUSTFLAGS !== undefined && env.CARGO_ENCODED_RUSTFLAGS !== ""
      ? env.CARGO_ENCODED_RUSTFLAGS.split(RUSTFLAGS_SEPARATOR)
      : (env.RUSTFLAGS ?? "").split(/\s+/).filter((flag) => flag !== "");
  return [...given, ...flags].join(RUSTFLAGS_SEPARATOR);
}

function rustcSysroot() {
  return execFileSync("rustc", ["--print", "sysroot"], { encoding: "utf8" }).trim();
}

function main() {
  if (process.argv.includes("--help")) {
    console.log(USAGE);
    return;
  }
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const cargoHome = process.env.CARGO_HOME ?? join(homedir(), ".cargo");
  const manifest = join(repoRoot, "crates", "pcv-wasm", "Cargo.toml");
  const targetDir = process.env.CARGO_TARGET_DIR ?? join(repoRoot, "crates", "pcv-wasm", "target");
  const flags = remapPathPrefixFlags([
    { from: repoRoot, to: REMAPPED_REPO },
    { from: cargoHome, to: REMAPPED_CARGO_HOME },
    { from: rustcSysroot(), to: REMAPPED_SYSROOT },
  ]);
  const env = { ...process.env, CARGO_ENCODED_RUSTFLAGS: encodedRustflagsWith(flags, process.env) };
  delete env.RUSTFLAGS;
  execFileSync(
    "cargo",
    ["build", "--manifest-path", manifest, "--target", "wasm32-unknown-unknown", "--release"],
    { cwd: repoRoot, env, stdio: "inherit" },
  );
  execFileSync(
    "wasm-bindgen",
    [
      "--target",
      "web",
      "--out-dir",
      join(repoRoot, "src", "wasm", "pcv-wasm"),
      "--out-name",
      "pcv_wasm",
      join(targetDir, "wasm32-unknown-unknown", "release", "pcv_wasm.wasm"),
    ],
    { cwd: repoRoot, stdio: "inherit" },
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
