import { readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { REMAPPED_ROOTS } from "./build-wasm.mjs";

const USAGE = `usage: node scripts/check-wasm-paths.mjs [wasm...]   (npm run check:wasm-paths)

Fails when a wasm (default: the committed src/wasm/pcv-wasm/pcv_wasm_bg.wasm) holds an absolute path of the machine
that built it: a drive path (C:\\... or C:/..., not the tail of http://), a home folder (/home/<name>, /Users/<name>),
a .cargo / .rustup folder, or a folder named after the user running the check (/<name>/ or \\<name>\\).
Build the wasm with npm run build:wasm (scripts/build-wasm.mjs), which remaps those paths.`;

const PATH_CHARACTER = String.raw`[^\x00-\x1f"'\s]`;
const PATH_TAIL = PATH_CHARACTER + "{0,60}";

const BUILD_MACHINE_PATHS = [
  new RegExp(String.raw`(?<![A-Za-z])[A-Za-z]:[\\/]` + PATH_TAIL, "g"),
  new RegExp(String.raw`/(?:home|Users)/` + PATH_TAIL, "g"),
  new RegExp(String.raw`\.(?:cargo|rustup)(?![A-Za-z0-9_-])` + PATH_TAIL, "g"),
];

const MIN_USER_NAME_LENGTH = 3;

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isRemappedRoot(userName) {
  return REMAPPED_ROOTS.some((root) => root.toLowerCase() === userName.toLowerCase());
}

function userFolderPatterns(userName) {
  if (userName.length < MIN_USER_NAME_LENGTH || isRemappedRoot(userName)) return [];
  const folder = String.raw`[\\/]` + escapeRegExp(userName) + String.raw`[\\/]`;
  return [new RegExp(PATH_CHARACTER + "{0,30}" + folder + PATH_TAIL, "gi")];
}

export function findBuildMachinePaths(bytes, userName = "") {
  const text = Buffer.from(bytes).toString("latin1");
  const found = new Set();
  for (const pattern of [...BUILD_MACHINE_PATHS, ...userFolderPatterns(userName)]) {
    for (const match of text.matchAll(pattern)) found.add(match[0]);
  }
  return [...found];
}

function main() {
  if (process.argv.includes("--help")) {
    console.log(USAGE);
    return;
  }
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const given = process.argv.slice(2);
  const files = given.length > 0 ? given : [join(repoRoot, "src", "wasm", "pcv-wasm", "pcv_wasm_bg.wasm")];
  let failed = false;
  for (const file of files) {
    const paths = findBuildMachinePaths(readFileSync(file), userInfo().username);
    if (paths.length === 0) {
      console.log(`OK ${file}: no absolute path of the build machine`);
      continue;
    }
    failed = true;
    console.error(`${file}: ${paths.length} absolute path(s) of the build machine. Rebuild with npm run build:wasm.`);
    for (const path of paths) console.error(`  ${path}`);
  }
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
