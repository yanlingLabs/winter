// ComputerV2 Phase 4 — Winter Headless's components kept across helper runs (`browser/headless/components.ts`):
// only what Chromium installed as a component, cloned in before a run and taken back after it; never a run's own data.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  componentPaths, harvestHeadlessComponents, headlessComponentsDir, HEADLESS_COMPONENTS_MAX_BYTES, isComponentDir, seedHeadlessComponents,
} from "../../src/computer-use/browser/headless/components";

function dir(): string { return mkdtempSync(join(tmpdir(), "winter-headless-components-")); }
function component(root: string, name: string, version: string, extra: Record<string, string> = {}): void {
  mkdirSync(join(root, name, version), { recursive: true });
  writeFileSync(join(root, name, version, "manifest.json"), JSON.stringify({ name, version }));
  for (const [file, text] of Object.entries(extra)) writeFileSync(join(root, name, version, file), text);
}

describe("Winter Headless's kept components", () => {
  test("the store is <home>/cache/headless-components", () => {
    expect(headlessComponentsDir("/h")).toBe("/h/cache/headless-components");
  });

  test("a component is a folder holding a version folder with a manifest — nothing else is", () => {
    const root = dir();
    component(root, "CertificateRevocation", "10831", { "crl-set": "x" });
    mkdirSync(join(root, "Default"), { recursive: true });
    writeFileSync(join(root, "Default", "Cookies"), "c");
    mkdirSync(join(root, "Safe Browsing", "1.0"), { recursive: true }); // no manifest
    mkdirSync(join(root, "Odd", "not-a-version"), { recursive: true });
    writeFileSync(join(root, "Odd", "not-a-version", "manifest.json"), "{}");
    symlinkSync(join(root, "CertificateRevocation"), join(root, "Linked"));
    expect(isComponentDir(join(root, "CertificateRevocation"))).toBe(true);
    for (const n of ["Default", "Safe Browsing", "Odd", "Linked", "Missing"]) expect(isComponentDir(join(root, n))).toBe(false);
  });

  test("components one level down are found too (Subresource Filter's rules), never inside a profile's folder", () => {
    const root = dir();
    component(root, "PKIMetadata", "1798");
    component(join(root, "Subresource Filter"), "Unindexed Rules", "9.72.0");
    mkdirSync(join(root, "Subresource Filter", "Indexed Rules"), { recursive: true });
    component(join(root, "Default"), "Extensions", "1.0"); // a profile's own: never
    component(join(root, "Profile 1"), "Thing", "2");
    expect(componentPaths(root)).toEqual(["PKIMetadata", join("Subresource Filter", "Unindexed Rules")]);
    const store = join(dir(), "store"); const next = dir();
    expect(harvestHeadlessComponents(root, store).sort()).toEqual(["PKIMetadata", join("Subresource Filter", "Unindexed Rules")]);
    expect(seedHeadlessComponents(store, next).sort()).toEqual(["PKIMetadata", join("Subresource Filter", "Unindexed Rules")]);
    expect(existsSync(join(next, "Subresource Filter", "Unindexed Rules", "9.72.0", "manifest.json"))).toBe(true);
    expect(existsSync(join(next, "Default"))).toBe(false);
  });

  test("after a run: its components are kept, a run's own data never is, and no link is followed", () => {
    const run = dir(); const store = join(dir(), "store");
    component(run, "PKIMetadata", "1798", { "crs.pb": "roots" });
    component(run, "CertificateRevocation", "10831", { "crl-set": "revoked" });
    symlinkSync("/etc/hosts", join(run, "PKIMetadata", "1798", "a-link"));
    mkdirSync(join(run, "Default"), { recursive: true });
    writeFileSync(join(run, "Default", "Cookies"), "a session's cookies");
    writeFileSync(join(run, "Local State"), "{}");
    expect(harvestHeadlessComponents(run, store).sort()).toEqual(["CertificateRevocation", "PKIMetadata"]);
    expect(readdirSync(store).sort()).toEqual(["CertificateRevocation", "PKIMetadata"]);
    expect(readFileSync(join(store, "PKIMetadata", "1798", "crs.pb"), "utf8")).toBe("roots");
    expect(existsSync(join(store, "PKIMetadata", "1798", "a-link"))).toBe(false);
  });

  test("before a run: the kept components are cloned into its fresh cache root; a half-staged copy is not", () => {
    const store = dir(); const run = dir();
    component(store, "PKIMetadata", "1798", { "crs.pb": "roots" });
    component(store, ".PKIMetadata.dead", "1", {});
    mkdirSync(join(store, "Stray"), { recursive: true });
    expect(seedHeadlessComponents(store, run)).toEqual(["PKIMetadata"]);
    expect(readdirSync(run)).toEqual(["PKIMetadata"]);
    expect(readFileSync(join(run, "PKIMetadata", "1798", "crs.pb"), "utf8")).toBe("roots");
    expect(seedHeadlessComponents(join(store, "absent"), run)).toEqual([]);
  });

  test("a newer run's copy replaces the kept one whole, and a crash's half-staged copy is cleared", () => {
    const store = join(dir(), "store");
    const first = dir();
    component(first, "PKIMetadata", "1797", { "crs.pb": "old" });
    harvestHeadlessComponents(first, store);
    mkdirSync(join(store, ".PKIMetadata.half"), { recursive: true });
    const second = dir();
    component(second, "PKIMetadata", "1798", { "crs.pb": "new" });
    harvestHeadlessComponents(second, store);
    expect(readdirSync(join(store, "PKIMetadata"))).toEqual(["1798"]);
    expect(readFileSync(join(store, "PKIMetadata", "1798", "crs.pb"), "utf8")).toBe("new");
    expect(readdirSync(store)).toEqual(["PKIMetadata"]);
  });

  test(`more than ${HEADLESS_COMPONENTS_MAX_BYTES / (1024 * 1024)} MB of components is not kept`, () => {
    const run = dir(); const store = join(dir(), "store"); const logs: string[] = [];
    component(run, "Huge", "1");
    const big = join(run, "Huge", "1", "blob");
    writeFileSync(big, "");
    truncateSync(big, HEADLESS_COMPONENTS_MAX_BYTES + 1); // sparse: costs no disk
    expect(harvestHeadlessComponents(run, store, (l) => logs.push(l))).toEqual([]);
    expect(existsSync(store)).toBe(false);
    expect(logs.some((l) => l.includes("not kept"))).toBe(true);
  });
});
