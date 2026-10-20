import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import * as ts from "typescript";

// Anti-wiring pin for the native worker modules (N2 S1). They are SOURCE ONLY: nothing outside src/cowork/native/ imports them,
// no port they declare has an implementation in src/, and they reach no VM, no network and no secret store.
const packages = join(import.meta.dir, "..", "..", "..", "..");
const repositoryRoot = join(packages, "..");
const nativeDirectory = join(packages, "core", "src", "cowork", "native");
const MODULES = ["authority", "fd-channel", "fd-receiver-worker", "host", "power", "protocol", "receipt-mac", "recovery", "stop-proof"];
function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile() && /\.(ts|tsx|js|mjs|cjs|mts|cts)$/.test(entry.name) && !entry.parentPath.split(sep).includes("node_modules")).map(entry => join(entry.parentPath, entry.name));
}
const allSources = readdirSync(packages, { withFileTypes: true }).filter(entry => entry.isDirectory() && existsSync(join(packages, entry.name, "src"))).flatMap(entry => sourceFiles(join(packages, entry.name, "src")));
// The pressure slice (free-space admission, probes, observer) lives in the same directory and carries its own anti-wiring pin; it is listed so the set stays exact.
const OTHER_SLICES = ["admission-probes", "free-space", "pressure", "resource-observer"];
const everyNativeSource = sourceFiles(nativeDirectory);
const nativeSources = everyNativeSource.filter(file => !OTHER_SLICES.includes(basename(file, ".ts")));
// N2 S7: the ONE module outside cowork/native/ that may import it. It is lazy and inert; the daemon is its only importer. Both facts are pinned below.
const WIRING = join(packages, "core", "src", "cowork", "native-wiring.ts");
// N2 S7B part 1: the production environment builder (src/cowork/host-env/*) is the second module family that may import cowork/native. It is built only through
// the activation seam (src/cowork/native-activation.ts), which the daemon calls lazily and which answers `undefined` until the owner flips it; both are pinned below.
const HOST_ENV_DIRECTORY = join(packages, "core", "src", "cowork", "host-env") + sep;
const ACTIVATION = join(packages, "core", "src", "cowork", "native-activation.ts");
const isHostEnv = (file: string): boolean => file.startsWith(HOST_ENV_DIRECTORY);
const scriptSources = existsSync(join(repositoryRoot, "scripts")) ? sourceFiles(join(repositoryRoot, "scripts")) : [];

/** Every module specifier a source text names: static imports and re-exports (any form, multi-line included), bare `import "x"`, `import("x")`,
 * `require("x")` and the `new URL("x", import.meta.url)` of a Worker or an asset. Comments are stripped first, strings in them do not count. */
export function specifiersOf(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\/|(^|[^:\\])\/\/[^\n]*/g, "$1");
  const found: string[] = [];
  for (const pattern of [/\b(?:import|export)\b[^"'`;]*?\bfrom\s*["'`]([^"'`]+)["'`]/g, /\bimport\s*["'`]([^"'`]+)["'`]/g, /\bimport\s*\(\s*["'`]([^"'`]+)["'`]/g, /\brequire\s*\(\s*["'`]([^"'`]+)["'`]/g, /new\s+URL\(\s*["'`]([^"'`]+)["'`]\s*,\s*import\.meta\.url/g])
    for (const match of code.matchAll(pattern)) found.push(match[1]!);
  return found;
}
/** True when `specifier`, written in `file`, reaches anything under src/cowork/native/ (relative, absolute, or through a package path). */
export function reachesNative(file: string, specifier: string): boolean {
  if (/cowork\/native(\/|$)/.test(specifier) && !specifier.startsWith(".")) return true;
  if (!specifier.startsWith(".") && !specifier.startsWith("/")) return false;
  const target = specifier.startsWith("/") ? resolve(specifier) : resolve(dirname(file), specifier);
  return target === nativeDirectory || target.startsWith(`${nativeDirectory}${sep}`);
}


/** Every module a source names, by AST (not by regex): `import x from`, bare `import "x"`, `export ... from`, `import type`, `import x = require()`, `require("x")` and `import("x")`.
 * A dynamic or require call whose argument is not a string literal is reported as `<dynamic:...>` and is never allowed. */
export function astSpecifiers(source: string, file = "x.ts"): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) found.push(node.moduleSpecifier.text);
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteralLike(node.moduleReference.expression)) found.push(node.moduleReference.expression.text);
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      const argument = node.arguments[0];
      found.push(argument && ts.isStringLiteralLike(argument) ? argument.text : `<dynamic:${node.getText()}>`);
    }
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true));
  return found;
}

test("the module set is exactly the reviewed one and has no barrel", () => {
  expect(everyNativeSource.map(file => basename(file, ".ts")).sort()).toEqual([...MODULES, ...OTHER_SLICES].sort());
  expect(existsSync(join(nativeDirectory, "index.ts"))).toBe(false);
  expect(existsSync(join(packages, "core", "src", "cowork", "index.ts"))).toBe(false);
  expect(readFileSync(join(packages, "core", "src", "index.ts"), "utf8")).not.toMatch(/cowork\/native|from "\.\/cowork/);
  expect(allSources.length).toBeGreaterThan(100);
});

test("no source file outside cowork/native imports, names or constructs anything from it", () => {
  const needles = ["cowork/native", "CoworkNativeHost", "CoworkNativeAuthority", "CoworkNativeRecovery", "CoworkNativePower", "CoworkNativeStopRegistry", "CoworkLauncherPort", "CoworkLauncherSession", "CoworkNativeImagePins",
    "CoworkNativeDurableReceiptPort", "CoworkNativeOwnerRecoverPort", "parseCoworkNativeLauncherLine", "parseCoworkNativeEnvelope", "parseCoworkNativeMuxFrame", "FdLineChannel", "FdReceiver", "spawnWithChannel", "COWORK_LIBKRUN_"];
  for (const file of allSources.filter(candidate => !everyNativeSource.includes(candidate) && candidate !== WIRING && !isHostEnv(candidate))) {
    const text = readFileSync(file, "utf8").split("cowork/native-wiring").join("").split("cowork/native-activation").join("");
    for (const needle of needles) expect(`${basename(file)}:${needle}:${text.includes(needle)}`).toBe(`${basename(file)}:${needle}:false`);
  }
});

test("none of the ports they declare is implemented anywhere in src/", () => {
  const ports = ["CoworkLauncherPort", "CoworkLauncherSession", "CoworkNativeImagePins", "CoworkNativeDurableReceiptPort", "CoworkNativeOwnerRecoverPort", "CoworkNativeRecoverGuards", "CoworkNativeHostBoot", "CoworkNativeLink"];
  // The production environment (host-env/) is where the launcher port, the receipt store and the journal are implemented; the wiring binds the image pins. Both are exempt for their own ports only.
  for (const file of allSources.filter(candidate => !isHostEnv(candidate) && candidate !== WIRING)) {
    const text = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
    for (const port of ports) {
      expect(`${basename(file)}:${port}:${new RegExp(`implements[^{]*\\b${port}\\b|:\\s*${port}\\s*=\\s*\\{|class\\s+\\w+[^{]*\\b${port}\\b|as\\s+${port}\\b`).test(text)}`).toBe(`${basename(file)}:${port}:false`);
    }
  }
});

test("the native modules import only the reviewed neighbours and reach no daemon, IPC, service, network or secret store", () => {
  const allowed = new Set(["node:crypto", "bun:ffi", "../admission", "../repository", "../types", "../volumes", "../volume-filesystem", "../durable-transaction", "../../runtime-state/db"]);
  for (const file of nativeSources) {
    const text = readFileSync(file, "utf8");
    for (const target of astSpecifiers(text, file)) {
      expect(`${basename(file)}:${target}:${allowed.has(target) || (target.startsWith("./") && MODULES.includes(target.slice(2)))}`).toBe(`${basename(file)}:${target}:true`);
    }
    for (const forbidden of ["Bun.connect(", "Bun.listen(", "node:net", "node:http", "fetch(", "Bun.secrets", "process.env", "Keychain", "Hypervisor", "hv_vm_", "krun_start_enter", "sandbox_init", "pmset", "codesign", "child_process"])
      expect(`${basename(file)}:${forbidden}:${text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "").includes(forbidden)}`).toBe(`${basename(file)}:${forbidden}:false`);
  }
});

test("bun:ffi and libSystem are confined to fd-channel.ts; only the reviewed symbols are bound", () => {
  for (const file of nativeSources) {
    const code = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
    expect(`${basename(file)}:${/dlopen\(/.test(code)}`).toBe(`${basename(file)}:${basename(file) === "fd-channel.ts"}`);
  }
  const code = readFileSync(join(nativeDirectory, "fd-channel.ts"), "utf8");
  expect([...code.matchAll(/dlopen\("([^"]+)"/g)].map(match => match[1])).toEqual(["/usr/lib/libSystem.B.dylib"]);
  const block = code.slice(code.indexOf("dlopen("), code.indexOf("const errno ="));
  expect([...block.matchAll(/^\s{4}(\w+): \{ args/gm)].map(match => match[1]).sort()).toEqual(["__error", "close", "dup", "fcntl", "poll", "recvmsg", "sendmsg", "setsockopt", "shutdown", "socketpair"]);
});

test("the database is written in exactly one place and the existing repository is not edited by it", () => {
  const writers = nativeSources.filter(file => /\b(INSERT|UPDATE|DELETE)\b/.test(readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "")));
  expect(writers.map(file => basename(file))).toEqual(["power.ts"]);
  expect(readFileSync(join(nativeDirectory, "power.ts"), "utf8").match(/UPDATE cowork_workspaces SET power=/g)).toHaveLength(1);
});

test("no module under cowork/native reads anything at import time", () => {
  for (const file of nativeSources) {
    const code = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
    expect(`${basename(file)}:${/^(?:await |new Database|readFileSync|openSync|Bun\.spawn)/m.test(code)}`).toBe(`${basename(file)}:false`);
  }
});

test("no file anywhere (every package's src, and scripts/) imports from cowork/native, however the specifier is written", () => {
  const offenders: string[] = [];
  for (const file of [...allSources, ...scriptSources].filter(candidate => !everyNativeSource.includes(candidate) && candidate !== WIRING && !isHostEnv(candidate)))
    for (const specifier of specifiersOf(readFileSync(file, "utf8"))) if (reachesNative(file, specifier)) offenders.push(`${relative(repositoryRoot, file)} -> ${specifier}`);
  expect(offenders).toEqual([]);
  expect(scriptSources.length).toBeGreaterThan(5);
  expect(allSources.length).toBeGreaterThan(100);
});

/** Every string a source can spell as a compile-time constant: literals, templates and `+` chains of them, folded (`"native-" + "wiring"`, `` `native-${"wiring"}` ``).
 * LIMIT: a name built at run time (a variable, a call) cannot be folded; the collapsed-text needle in `namesTheWiring` is the second net (it ignores quotes, `+`, `$`, braces and
 * whitespace, so split spellings that survive as text are caught, comments included), and neither net is a defence against deliberate evasion. */
export function foldedStrings(source: string): string[] {
  const found: string[] = [];
  const fold = (node: ts.Node): string | undefined => {
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isParenthesizedExpression(node)) return fold(node.expression);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) { const left = fold(node.left), right = fold(node.right); return left !== undefined && right !== undefined ? left + right : undefined; }
    if (ts.isTemplateExpression(node)) {
      let text = node.head.text;
      for (const span of node.templateSpans) { const inner = fold(span.expression); if (inner === undefined) return undefined; text += inner + span.literal.text; }
      return text;
    }
    return undefined;
  };
  const visit = (node: ts.Node): void => { const value = fold(node); if (value !== undefined) found.push(value); ts.forEachChild(node, visit); };
  visit(ts.createSourceFile("x.ts", source, ts.ScriptTarget.Latest, true));
  return found;
}
export function namesTheWiring(source: string): boolean {
  return foldedStrings(source).some(value => value.includes("native-wiring")) || source.replace(/[\s"'`+${}]/g, "").includes("native-wiring");
}

test("N2 S7: the wiring is the only importer of cowork/native, the daemon is the only importer of the wiring, and the wiring is lazy and reaches no process, socket, setting or environment", () => {
  const wiringText = readFileSync(WIRING, "utf8"), code = wiringText.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
  expect(astSpecifiers(wiringText, WIRING).filter(target => target.startsWith("./native/")).sort()).toEqual(["./native/authority", "./native/host", "./native/power", "./native/protocol", "./native/receipt-mac", "./native/recovery", "./native/stop-proof"]);
  const importers = [...allSources, ...scriptSources].filter(file => file !== WIRING && namesTheWiring(readFileSync(file, "utf8"))).map(file => relative(repositoryRoot, file).split(sep).join("/")).sort();
  // the daemon imports the wiring; the host-env environment and the activation seam import only its TYPES
  expect(importers).toEqual(["packages/core/src/cowork/host-env/environment.ts", "packages/core/src/cowork/native-activation.ts", "packages/core/src/daemon.ts"]);
  for (const file of [join(HOST_ENV_DIRECTORY, "environment.ts"), ACTIVATION]) {
    const typeOnlyImports = ts.createSourceFile("x.ts", readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true).statements.filter((statement): statement is ts.ImportDeclaration => ts.isImportDeclaration(statement) && /native-wiring/.test((statement.moduleSpecifier as ts.StringLiteral).text));
    expect(typeOnlyImports.length > 0 && typeOnlyImports.every(statement => statement.importClause?.isTypeOnly === true)).toBe(true);
  }
  for (const forbidden of ["Bun.spawn", "child_process", "Bun.connect(", "Bun.listen(", "node:net", "process.env", "Bun.secrets", "Keychain", "readFileSync", "writeFileSync", "mkdirSync", "setInterval", "dlopen(", "krun_", "Hypervisor", "sandbox_init", "pmset"])
    expect(`${forbidden}:${code.includes(forbidden)}`).toBe(`${forbidden}:false`);
  // Nothing is built or scheduled at import time or at construction: the host appears only inside the private `host()` builder.
  expect(code.match(/new CoworkNativeHost\(/g)).toHaveLength(1);
  expect(code.indexOf("new CoworkNativeHost(")).toBeGreaterThan(code.indexOf("private host()"));
  expect(code.indexOf("constructor(private readonly options")).toBeLessThan(code.indexOf("private host()"));
  // the constructor only wraps the secret slot in the key store object (no read, no write, no host)
  expect(code.includes("constructor(private readonly options: CoworkNativeWiringOptions) { this.keys = options.secrets ? new CoworkNativeReceiptKeyStore(options.secrets) : undefined; }")).toBe(true);
});

test("the specifier scanner sees every form of import, and resolves it relative to the file that wrote it", () => {
  const cowork = join(packages, "core", "src", "cowork", "x.ts"), other = join(packages, "core", "src", "agent", "y.ts"), script = join(repositoryRoot, "scripts", "z.ts");
  const forms: [string, string, string][] = [
    ['import { a } from "./native/host";', cowork, "static"], ['import type { A } from "./native/protocol";', cowork, "type-only"], ['export * from "./native/protocol";', cowork, "star re-export"],
    ['export { a } from "./native/authority.js";', cowork, "named re-export with extension"], ['import("./native/recovery");', cowork, "dynamic"], ['const m = await import(`./native/power`);', cowork, "dynamic template"],
    ['const m = require("./native/stop-proof");', cowork, "require"], ['import "./native/fd-channel";', cowork, "side effect"], ['import {\n  a,\n  b,\n} from "./native/host";', cowork, "multi-line"],
    ['import x from "../cowork/native/host";', cowork, "up and back down"], ['import x from "../cowork/native/host";', other, "from a sibling directory"], ['import x from "../../core/src/cowork/native/host";', script.replace("scripts", "scripts"), "from scripts via a path that climbs"],
    ['const w = new Worker(new URL("./native/fd-receiver-worker.ts", import.meta.url));', cowork, "worker url"], ['import x from "@yanlinglabs/winter-core/src/cowork/native/host";', other, "package path"],
  ];
  // The scripts case needs a real climb: scripts/ is a sibling of packages/.
  forms[11] = ['import x from "../packages/core/src/cowork/native/host";', script, "from scripts via a path that climbs"];
  for (const [text, file, name] of forms) {
    const hits = specifiersOf(text).filter(specifier => reachesNative(file, specifier));
    expect(`${name}:${hits.length}`).toBe(`${name}:1`);
  }
  for (const [text, file] of [['import x from "./volumes";', cowork], ['import x from "../native-thing/x";', cowork], ['// import x from "./native/host";', cowork], ['/* import("./native/host") */', cowork], ['import x from "bun:ffi";', cowork]] as const)
    expect(specifiersOf(text).filter(specifier => reachesNative(file, specifier))).toEqual([]);
  // a sibling named like the directory is not the directory
  expect(reachesNative(cowork, "./native-adapter/host")).toBe(false);
});

test("the neighbour scanner sees bare imports, export-from, dynamic import() and require(), and refuses what the old regex missed", () => {
  expect(astSpecifiers('import "node:net";')).toEqual(["node:net"]);
  expect(astSpecifiers('export { a } from "../daemon";\nexport * from "./index";')).toEqual(["../daemon", "./index"]);
  expect(astSpecifiers('const m = await import("../ipc/server");')).toEqual(["../ipc/server"]);
  expect(astSpecifiers('const m = require("node:http"); import x = require("node:net");')).toEqual(["node:http", "node:net"]);
  expect(astSpecifiers("const m = await import(name);")).toEqual(["<dynamic:import(name)>"]);
  expect(astSpecifiers('import type { T } from "../types"; import { b,\n c } from "./protocol";')).toEqual(["../types", "./protocol"]);
  // None of the planted forms is an allowed neighbour.
  const allowedFixture = new Set(["node:crypto", "bun:ffi", "../admission"]);
  for (const planted of ['import "node:net";', 'export { a } from "../daemon";', 'await import("../ipc/server");', "await import(name);"]) expect(astSpecifiers(planted).every(target => allowedFixture.has(target))).toBe(false);
});

/** Every identifier, property name, string literal and template-literal part (head, middle, tail) in a source that spells `name` (an AST scan, so a comment does not count and a quoted spelling does).
 * LIMIT: this guards against ACCIDENTAL spelling, not deliberate evasion. Concatenation (`"unsafeTest" + "Timeouts"`) and computed keys built at run time are not detected. */
export function spellsToken(source: string, name: string): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if ((ts.isIdentifier(node) || ts.isStringLiteralLike(node) || ts.isPrivateIdentifier(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) && node.text.includes(name)) found = true;
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile("x.ts", source, ts.ScriptTarget.Latest, true));
  return found;
}
test("the test-only `unsafeTestTimeouts` switch is spelled nowhere under packages/*/src except cowork/native/host.ts", () => {
  const holders = allSources.filter(file => spellsToken(readFileSync(file, "utf8"), "unsafeTestTimeouts")).map(file => relative(packages, file).split(sep).join("/"));
  expect(holders).toEqual(["core/src/cowork/native/host.ts"]);
  // The scanner itself: it sees an identifier, a property key, a quoted spelling and a template-free string, and ignores a comment.
  for (const planted of ["const unsafeTestTimeouts = true;", "x({ unsafeTestTimeouts: true });", 'x({ "unsafeTestTimeouts": true });', 'const k = "unsafeTestTimeouts";', "const k = `unsafeTestTimeouts${x}`;", "const k = `${x}unsafeTestTimeouts`;", "const k = `${x}unsafeTestTimeouts${y}`;", "const k = `unsafeTestTimeouts`;"]) expect(spellsToken(planted, "unsafeTestTimeouts")).toBe(true);
  // The documented limit: a deliberate evasion is not seen.
  expect(spellsToken('const k = "unsafeTest" + "Timeouts";', "unsafeTestTimeouts")).toBe(false);
  expect(spellsToken("// unsafeTestTimeouts is mentioned only here\nconst a = 1;", "unsafeTestTimeouts")).toBe(false);
});

/** True when an identifier, property name, string literal or template part IS exactly `name` (not merely contains it). */
export function spellsExactly(source: string, name: string): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if ((ts.isIdentifier(node) || ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) && node.text === name) found = true;
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile("x.ts", source, ts.ScriptTarget.Latest, true));
  return found;
}
test("N2 S7: `coworkNative` (the injection option) is spelled only by daemon.ts, in every package's src and in scripts/", () => {
  const holders = [...allSources, ...scriptSources].filter(file => spellsExactly(readFileSync(file, "utf8"), "coworkNative")).map(file => relative(repositoryRoot, file).split(sep).join("/"));
  expect(holders).toEqual(["packages/core/src/daemon.ts"]);
  expect(scriptSources.length).toBeGreaterThan(5);
  // the scanner sees the option as a property, a quoted key, a shorthand and a destructured name, and ignores comments and longer names
  for (const planted of ["start({ coworkNative: {} });", 'start({ "coworkNative": {} });', "const coworkNative = 1;", "const { coworkNative } = opts;", "opts.coworkNative;"]) expect(spellsExactly(planted, "coworkNative")).toBe(true);
  for (const clean of ["// coworkNative", "const coworkNativeHostStopWaitMs = 1;", "const createCoworkNativeWiring = 2;"]) expect(spellsExactly(clean, "coworkNative")).toBe(false);
});

test("the importer scanner folds concatenations and templates, and keeps a collapsed-text needle for what it cannot fold", () => {
  for (const planted of ['import x from "./native-wiring";', 'await import("./native-" + "wiring");', 'await import(`./native-${"wiring"}`);', 'const n = ("native" + "-") + "wiring"; require(n);', 'import x from "./cowork/native-wiring.ts";'])
    expect(namesTheWiring(planted)).toBe(true);
  // not foldable (a run-time value), yet the text still gives it away once quotes and plus signs are ignored
  expect(namesTheWiring('const p = "native-" + prefix + "wir" + "ing"; import(p);')).toBe(false); // the documented limit: a run-time part defeats both nets
  expect(namesTheWiring("const q = `${a}native-wiring`;")).toBe(true);
  expect(namesTheWiring('import x from "./native-adapter";')).toBe(false);
});

test("N2 S7B part 1: the production environment is built only through the activation seam, and the seam is off", async () => {
  // 1. only the seam imports the environment builder; only the daemon imports the seam
  const hostEnvImporters = [...allSources, ...scriptSources].filter(file => !isHostEnv(file) && specifiersOf(readFileSync(file, "utf8")).some(specifier => /(^|\/)host-env(\/|$)/.test(specifier))).map(file => relative(repositoryRoot, file).split(sep).join("/"));
  expect(hostEnvImporters).toEqual(["packages/core/src/cowork/native-activation.ts"]);
  const activationImporters = [...allSources, ...scriptSources].filter(file => file !== ACTIVATION && specifiersOf(readFileSync(file, "utf8")).some(specifier => /(^|\/)native-activation(\.ts|\.js)?$/.test(specifier))).map(file => relative(repositoryRoot, file).split(sep).join("/"));
  expect(activationImporters).toEqual(["packages/core/src/daemon.ts"]);
  // 2. the daemon calls the seam lazily (a thunk), so nothing about the environment is read while it is off
  expect(readFileSync(join(packages, "core", "src", "daemon.ts"), "utf8")).toContain("coworkNativeProductionEnvironment(() => ({");
  // 3. the seam answers undefined, with the thunk never called
  const { coworkNativeProductionEnvironment } = await import("../../../src/cowork/native-activation");
  let called = 0;
  expect(coworkNativeProductionEnvironment(() => { called += 1; throw new Error("must not be read"); })).toBeUndefined();
  expect(called).toBe(0);
  expect(readFileSync(ACTIVATION, "utf8")).toContain("const COWORK_NATIVE_ENVIRONMENT_ACTIVATED: boolean = false;");
  // 4. the builder reads no environment variable and no real home directory by itself, and reaches no network, secret store, VM or sandbox
  for (const file of sourceFiles(HOST_ENV_DIRECTORY.slice(0, -1))) {
    const code = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
    for (const forbidden of ["process.env", "homedir", "Bun.connect(", "Bun.listen(", "node:net", "node:http", "fetch(", "Bun.secrets", "Keychain", "child_process", "Bun.spawn(", "krun_", "Hypervisor", "sandbox_init", "pmset", "codesign"])
      expect(`${basename(file)}:${forbidden}:${code.includes(forbidden)}`).toBe(`${basename(file)}:${forbidden}:false`);
  }
});
