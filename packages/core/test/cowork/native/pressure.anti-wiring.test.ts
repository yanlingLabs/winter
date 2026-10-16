import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import * as ts from "typescript";

// N2 S6 anti-wiring pin. The four modules are host-side building blocks that nothing in src/ may import yet; S7 owns
// the wiring and will edit this pin when it does. The pin also holds the modules to their stated boundaries.
const packages = join(import.meta.dir, "..", "..", "..", "..");
const native = join(packages, "core", "src", "cowork", "native");
const modules = ["free-space", "pressure", "admission-probes", "resource-observer"].map(name => join(native, `${name}.ts`));
const sourceFiles = (directory: string): string[] => readdirSync(directory, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile() && /\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)).map(entry => join(entry.parentPath, entry.name));
const allSources = (): string[] => readdirSync(packages, { withFileTypes: true }).filter(entry => entry.isDirectory() && existsSync(join(packages, entry.name, "src"))).flatMap(entry => sourceFiles(join(packages, entry.name, "src")));
const parse = (file: string) => ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
const specifiers = (file: string): string[] => {
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) found.push(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) found.push(`<dynamic:${node.getText()}>`);
    ts.forEachChild(node, visit);
  };
  visit(parse(file)); return found.sort();
};
const typeOnly = (file: string, specifier: string): boolean => {
  const imports = parse(file).statements.filter((s): s is ts.ImportDeclaration => ts.isImportDeclaration(s) && (s.moduleSpecifier as ts.StringLiteral).text === specifier);
  return imports.length > 0 && imports.every(s => s.importClause?.isTypeOnly === true);
};
const membersOf = (file: string, name: string): string[] => {
  const declaration = parse(file).statements.find((s): s is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(s) && s.name.text === name)!;
  return declaration.members.map(member => (member.name as ts.Identifier).text);
};

test("anti-wiring: the four modules exist and no other src file names them, imports them or uses their exports", () => {
  for (const module of modules) expect(existsSync(module)).toBe(true);
  const sources = allSources();
  expect(sources.length).toBeGreaterThan(100); for (const module of modules) expect(sources).toContain(module);
  const needles = ["native/free-space", "native/pressure", "native/admission-probes", "native/resource-observer", "CoworkPressureGuard", "createCoworkAdmissionProbes", "createCoworkResourceObserver", "preflightImageAdmission", "assessFreeSpace",
    "createStatfsReader", "coordinationLedgerPath", "reverifyStickyExclusion", "WriterHaltPort", "createProductionHostAdapters", "COWORK_FREE_SPACE_RESERVE_BYTES", "COWORK_PRESSURE_", "RESOURCE_OBSERVATION_VALIDITY_MS", "parseIoPlatformUuid"];
  const banned: string[] = [];
  for (const file of sources.filter(candidate => !modules.includes(candidate))) {
    const text = readFileSync(file, "utf8");
    for (const needle of needles) if (text.includes(needle)) banned.push(`${file.slice(packages.length)}:${needle}`);
    // Siblings in cowork/native/ (another slice's files) must not import these by relative path either.
    if (file.startsWith(`${native}/`) && /from\s+["']\.\/(free-space|pressure|admission-probes|resource-observer)["']/.test(text)) banned.push(`${file.slice(packages.length)}:sibling-import`);
  }
  expect(banned).toEqual([]);
});
test("anti-wiring: no barrel exports the modules", () => {
  expect(existsSync(join(native, "index.ts"))).toBe(false);
  expect(existsSync(join(packages, "core", "src", "cowork", "index.ts"))).toBe(false);
  expect(readFileSync(join(packages, "core", "src", "index.ts"), "utf8")).not.toMatch(/cowork\/native|from "\.\/cowork/);
});
test("boundary: each module imports only what it is allowed to, and the shared types come in as type-only imports", () => {
  const [freeSpace, pressure, probes, observer] = modules as [string, string, string, string];
  expect(specifiers(freeSpace)).toEqual(["../volume-backup", "bun:ffi"]);
  expect(specifiers(pressure)).toEqual(["./free-space"]);
  expect(specifiers(probes)).toEqual(["../admission", "bun:ffi", "node:child_process", "node:path"]);
  expect(specifiers(observer)).toEqual(["../admission", "./admission-probes"]);
  expect(typeOnly(freeSpace, "../volume-backup")).toBe(true);   // never the runtime `timeMachineVolumeBackup`
  expect(typeOnly(probes, "../admission")).toBe(true);          // never the ledger itself
  expect(typeOnly(observer, "../admission")).toBe(true);
  expect(typeOnly(observer, "./admission-probes")).toBe(true);
});
test("boundary: no deletion, no exclusion application, no persistence, no VM or sandbox call, no process.env, no real home path", () => {
  const forbidden = ["excludeItem", "tmutil", "node:fs", "unlink", "rmSync", "rm(", "truncate", "writeFile", "writeSync", "appendFile", "rename", "mkdir", "chmod", "pmset", "hv_vm", "krun_", "sandbox_init", "launchctl", "SCM_RIGHTS",
    "process.env", "homedir", "Bun.", "fetch(", "CoworkError", "Application Support/Winter/Coordination/"];
  for (const module of modules) {
    const text = readFileSync(module, "utf8").split("\n").filter(line => !line.trim().startsWith("//") && !line.trim().startsWith("*") && !line.trim().startsWith("/**")).join("\n");
    for (const needle of forbidden) {
      // The single sanctioned spelling of the production directory is the default constant in admission-probes.ts.
      if (needle === "Application Support/Winter/Coordination/") continue;
      expect(`${basename(module)}:${needle}:${text.includes(needle)}`).toBe(`${basename(module)}:${needle}:false`);
    }
    if (basename(module) !== "admission-probes.ts") expect(`${basename(module)}:child_process:${text.includes("child_process")}`).toBe(`${basename(module)}:child_process:false`);
  }
  // The only process the probes can start is the fixed ioreg query.
  const probes = readFileSync(modules[2]!, "utf8");
  expect([...probes.matchAll(/spawnSync\(/g)]).toHaveLength(1); expect(probes).toContain('IOREG_PATH = "/usr/sbin/ioreg"');
});
test("boundary: the halt port has halt and nothing else, the admission view has one member, exclusion re-verification cannot enroll", () => {
  const [freeSpace, pressure] = modules as [string, string];
  expect(membersOf(pressure, "WriterHaltPort")).toEqual(["haltWriters"]);
  expect(membersOf(freeSpace, "PressureView")).toEqual(["admitsNewWork"]);
  expect(membersOf(freeSpace, "FilesystemSpaceReader")).toEqual(["read"]);
  const alias = parse(freeSpace).statements.find((s): s is ts.TypeAliasDeclaration => ts.isTypeAliasDeclaration(s) && s.name.text === "ExclusionVerifier")!;
  expect(alias.type.getText()).toBe('Pick<CoworkVolumeBackup, "verifyItemExcluded" | "verifyDescriptorExcluded">');
});
test("no new CoworkErrorCode: resource_blocked stays a structured result, and the hot types file is not mentioned by the modules' output", () => {
  const types = readFileSync(join(packages, "core", "src", "cowork", "types.ts"), "utf8");
  expect(types).not.toContain("resource_blocked");
  for (const module of modules) expect(readFileSync(module, "utf8")).not.toMatch(/from\s+["']\.\.\/types["']/);
  expect(readFileSync(modules[0]!, "utf8")).toContain('readonly outcome: "resource_blocked"');
});
