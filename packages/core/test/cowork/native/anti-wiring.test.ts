import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

// Anti-wiring pin for the native worker modules (N2 S1). They are SOURCE ONLY: nothing outside src/cowork/native/ imports them,
// no port they declare has an implementation in src/, and they reach no VM, no network and no secret store.
const packages = join(import.meta.dir, "..", "..", "..", "..");
const repositoryRoot = join(packages, "..");
const nativeDirectory = join(packages, "core", "src", "cowork", "native");
const MODULES = ["authority", "fd-channel", "fd-receiver-worker", "host", "power", "protocol", "recovery", "stop-proof"];
function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile() && /\.(ts|tsx|js|mjs|cjs|mts|cts)$/.test(entry.name) && !entry.parentPath.split(sep).includes("node_modules")).map(entry => join(entry.parentPath, entry.name));
}
const allSources = readdirSync(packages, { withFileTypes: true }).filter(entry => entry.isDirectory() && existsSync(join(packages, entry.name, "src"))).flatMap(entry => sourceFiles(join(packages, entry.name, "src")));
// The pressure slice (free-space admission, probes, observer) lives in the same directory and carries its own anti-wiring pin; it is listed so the set stays exact.
const OTHER_SLICES = ["admission-probes", "free-space", "pressure", "resource-observer"];
const everyNativeSource = sourceFiles(nativeDirectory);
const nativeSources = everyNativeSource.filter(file => !OTHER_SLICES.includes(basename(file, ".ts")));
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
  for (const file of allSources.filter(candidate => !everyNativeSource.includes(candidate))) {
    const text = readFileSync(file, "utf8");
    for (const needle of needles) expect(`${basename(file)}:${needle}:${text.includes(needle)}`).toBe(`${basename(file)}:${needle}:false`);
  }
});

test("none of the ports they declare is implemented anywhere in src/", () => {
  const ports = ["CoworkLauncherPort", "CoworkLauncherSession", "CoworkNativeImagePins", "CoworkNativeDurableReceiptPort", "CoworkNativeOwnerRecoverPort", "CoworkNativeRecoverGuards", "CoworkNativeHostBoot", "CoworkNativeLink"];
  for (const file of allSources) {
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
    for (const match of text.matchAll(/(?:^|\n)\s*import[^;]*?from "([^"]+)"/g)) {
      const target = match[1]!;
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
  for (const file of [...allSources, ...scriptSources].filter(candidate => !everyNativeSource.includes(candidate)))
    for (const specifier of specifiersOf(readFileSync(file, "utf8"))) if (reachesNative(file, specifier)) offenders.push(`${relative(repositoryRoot, file)} -> ${specifier}`);
  expect(offenders).toEqual([]);
  expect(scriptSources.length).toBeGreaterThan(5);
  expect(allSources.length).toBeGreaterThan(100);
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
