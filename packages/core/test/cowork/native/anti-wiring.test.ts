import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

// Anti-wiring pin for the native worker modules (N2 S1). They are SOURCE ONLY: nothing outside src/cowork/native/ imports them,
// no port they declare has an implementation in src/, and they reach no VM, no network and no secret store.
const packages = join(import.meta.dir, "..", "..", "..", "..");
const nativeDirectory = join(packages, "core", "src", "cowork", "native");
const MODULES = ["authority", "fd-channel", "fd-receiver-worker", "host", "power", "protocol", "recovery", "stop-proof"];
function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile() && /\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)).map(entry => join(entry.parentPath, entry.name));
}
const allSources = readdirSync(packages, { withFileTypes: true }).filter(entry => entry.isDirectory() && existsSync(join(packages, entry.name, "src"))).flatMap(entry => sourceFiles(join(packages, entry.name, "src")));
const nativeSources = sourceFiles(nativeDirectory);

test("the module set is exactly the reviewed one and has no barrel", () => {
  expect(nativeSources.map(file => basename(file, ".ts")).sort()).toEqual(MODULES);
  expect(existsSync(join(nativeDirectory, "index.ts"))).toBe(false);
  expect(existsSync(join(packages, "core", "src", "cowork", "index.ts"))).toBe(false);
  expect(readFileSync(join(packages, "core", "src", "index.ts"), "utf8")).not.toMatch(/cowork\/native|from "\.\/cowork/);
  expect(allSources.length).toBeGreaterThan(100);
});

test("no source file outside cowork/native imports, names or constructs anything from it", () => {
  const needles = ["cowork/native", "CoworkNativeHost", "CoworkNativeAuthority", "CoworkNativeRecovery", "CoworkNativePower", "CoworkNativeStopRegistry", "CoworkLauncherPort", "CoworkLauncherSession", "CoworkNativeImagePins",
    "CoworkNativeDurableReceiptPort", "CoworkNativeOwnerRecoverPort", "parseCoworkNativeLauncherLine", "parseCoworkNativeEnvelope", "parseCoworkNativeMuxFrame", "FdLineChannel", "FdReceiver", "spawnWithChannel", "COWORK_LIBKRUN_"];
  for (const file of allSources.filter(candidate => !nativeSources.includes(candidate))) {
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
