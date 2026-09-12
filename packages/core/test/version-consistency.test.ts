import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CORE_VERSION } from "../src/version";

const ROOT = join(import.meta.dir, "..", "..", "..");
const FORMAT = /^(\d+)\.(\d+)\.(\d{3})$/;
const canonical = readFileSync(join(ROOT, "VERSION"), "utf8").trim();
const m = canonical.match(FORMAT);
const twin = m ? `${+m[1]!}.${+m[2]!}.${+m[3]!}` : "INVALID";

test("VERSION matches #.#.###", () => {
  expect(canonical).toMatch(FORMAT);
});

test("version.ts carries the canonical version", () => {
  expect(CORE_VERSION).toBe(canonical);
});

for (const p of ["cli", "core", "protocol", "plugin-sdk"]) {
  test(`packages/${p}/package.json carries the semver twin`, () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "packages", p, "package.json"), "utf8"));
    expect(pkg.version).toBe(twin);
  });
}

test("project.yml carries the canonical version (both keys)", () => {
  const yml = readFileSync(join(ROOT, "apple", "Winter", "project.yml"), "utf8");
  expect(yml).toContain(`CFBundleShortVersionString: "${canonical}"`);
  expect(yml).toContain(`CFBundleVersion: "${canonical}"`);
});

test("Support/Info.plist carries the canonical version (both keys)", () => {
  const plist = readFileSync(join(ROOT, "apple", "Winter", "Support", "Info.plist"), "utf8");
  const count = plist.split(`<string>${canonical}</string>`).length - 1;
  expect(count).toBeGreaterThanOrEqual(2); // ShortVersionString + BundleVersion
});
