// Lists code under src/ that nothing calls (R10, TaskSheets/R10-remove-unused-code.md).
// Usage: node scripts/find-unused-ts.cjs <repository root>
//
// Uses the TypeScript language service's "find all references" on:
// - exported functions, classes, interfaces, types and constants,
// - members of exported interfaces in src/state (the hooks' types),
// - public methods and properties of exported classes.
// UNUSED    = no reference at all. TEST-ONLY = referenced only from *.test.ts files.
// For a hook member, the Pick list in viewer-types.ts, the assembly in useCopcViewer.ts and the hook's own file do not count,
// so a member passed between hooks inside useCopcViewer.ts can show up as UNUSED: check those by hand.
// Limits: a call made through a string (scripts/igpu-bench/bench.mjs calls renderer getters by name, e2e page.evaluate)
// is invisible to it. grep e2e/, scripts/ and docs/ before deleting anything it lists.
// It also misses a call through a structurally matching type: `NodeCache.get` is reported but `node-selection.ts` calls it
// through the `NodeSelectionCache` interface (R10). Run `npx tsc --noEmit` after each deletion.
const fs = require("fs");
const path = require("path");
const root = path.resolve(process.argv[2] || ".");
const ts = require(path.join(root, "node_modules/typescript"));
const norm = (p) => p.split(path.sep).join("/");

const configPath = ts.findConfigFile(root, ts.sys.fileExists, "tsconfig.app.json") || ts.findConfigFile(root, ts.sys.fileExists, "tsconfig.json");
const cfg = ts.getParsedCommandLineOfConfigFile(configPath, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: (d) => console.error(d) });
const files = cfg.fileNames.map(norm);
const host = {
  getScriptFileNames: () => files,
  getScriptVersion: () => "1",
  getScriptSnapshot: (f) => (fs.existsSync(f) ? ts.ScriptSnapshot.fromString(fs.readFileSync(f, "utf8")) : undefined),
  getCurrentDirectory: () => root,
  getCompilationSettings: () => cfg.options,
  getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
  fileExists: ts.sys.fileExists,
  readFile: ts.sys.readFile,
  readDirectory: ts.sys.readDirectory,
  directoryExists: ts.sys.directoryExists,
  getDirectories: ts.sys.getDirectories,
};
const ls = ts.createLanguageService(host);
const isTest = (f) => /\.test\.tsx?$/.test(f) || f.includes("/e2e/");
const targets = files.filter((f) => f.includes("/src/") && !isTest(f) && !f.includes("/src/wasm/") && !f.endsWith(".d.ts"));

function refsOf(file, pos) {
  const groups = ls.findReferences(file, pos) || [];
  const out = [];
  for (const g of groups) for (const r of g.references) if (!r.isDefinition) out.push(norm(r.fileName));
  return out;
}
function report(file, name, pos, kind) {
  let refs = refsOf(file, pos);
  // A hook member is "used" only if something other than its own hook (the return statement), the Pick list in
  // viewer-types.ts and the assembly in useCopcViewer.ts reads it.
  if (kind === "member") refs = refs.filter((r) => r !== file && !r.endsWith("/src/state/viewer-types.ts") && !r.endsWith("/src/state/useCopcViewer.ts"));
  const nonTest = refs.filter((r) => !isTest(r));
  const rel = path.relative(root, file).split(path.sep).join("/");
  const line = ts.getLineAndCharacterOfPosition(ls.getProgram().getSourceFile(file), pos).line + 1;
  if (refs.length === 0) console.log(`UNUSED      ${kind} ${rel}:${line} ${name}`);
  else if (nonTest.length === 0) console.log(`TEST-ONLY   ${kind} ${rel}:${line} ${name}`);
}

for (const file of targets) {
  const sf = ls.getProgram().getSourceFile(file);
  if (!sf) continue;
  sf.forEachChild((node) => {
    const exported = ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export;
    if (!exported) return;
    if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)) {
      if (node.name) report(file, node.name.text, node.name.getStart(sf), "export");
    }
    if (ts.isVariableStatement(node)) {
      for (const d of node.declarationList.declarations) if (ts.isIdentifier(d.name)) report(file, d.name.text, d.name.getStart(sf), "export");
    }
    // Members of exported interfaces in src/state (the hook return types) and public class methods in src/datasource, src/renderer.
    if (ts.isInterfaceDeclaration(node) && file.includes("/src/state/")) {
      for (const m of node.members) if (m.name && ts.isIdentifier(m.name)) report(file, `${node.name.text}.${m.name.text}`, m.name.getStart(sf), "member");
    }
    if (ts.isClassDeclaration(node)) {
      for (const m of node.members) {
        if (!(ts.isMethodDeclaration(m) || ts.isPropertyDeclaration(m)) || !m.name || !ts.isIdentifier(m.name)) continue;
        if (ts.getCombinedModifierFlags(m) & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) continue;
        report(file, `${node.name ? node.name.text : "?"}.${m.name.text}`, m.name.getStart(sf), "method");
      }
    }
  });
}
