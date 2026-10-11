/**
 * Builds Winter for Chrome, unpacked, into `extensions/winter-for-chrome/dist/<flavor>/` (git-ignored):
 *
 *   bun run build                       both flavors
 *   bun run build --flavor dev          the dev build (fixed id from keys/dev.pub; host com.winter.browser.dev)
 *   bun run build --flavor store        the store build (no key; host com.winter.browser)
 *   bun run build --out <dir>           somewhere else (`<dir>/<flavor>/`)
 *
 * The daemon's pinned CDP allowlist (packages/core/src/computer-use/browser/cdp-allowlist.ts) is bundled in from source,
 * so the extension enforces exactly the list the engine was built against. Icons are rendered from the brand mark. This
 * never uploads or publishes anything.
 */
import { Resvg } from "@resvg/resvg-js";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { extensionManifest, HOST_NAME, type Flavor } from "../src/manifest";

const ROOT = resolve(import.meta.dir, "..");
const REPO = resolve(ROOT, "..", "..");

export function devKey(): string {
  return readFileSync(join(ROOT, "keys", "dev.pub"), "utf8").trim();
}

/**
 * Calls the extension must never contain: each would activate a tab or focus a window, read a site's data, or run code
 * in the page's own world. What this is, honestly: a REGEX over the built bundles (background.js and popup.js) and, in
 * the unit tests, over the sources — a backstop against a slip, not a proof. `background.ts` binds the real `chrome` as
 * `any`, so the type system does not stop such a call there; what keeps them out of the logic is that every other module
 * reaches the browser only through the `ChromeApi` interface (chrome-api.ts), which has none of these members, and the
 * review of the one binding file. A call spelled some other way (computed property names, `eval`) would pass the regex.
 */
export const FORBIDDEN_IN_BUNDLE: { pattern: RegExp; why: string }[] = [
  { pattern: /tabs\.update\s*\(/, why: "tabs.update (could activate a tab)" },
  { pattern: /tabs\.highlight\s*\(/, why: "tabs.highlight (activates tabs)" },
  { pattern: /windows\.update\s*\(/, why: "windows.update (could focus a window)" },
  { pattern: /windows\.create\s*\(/, why: "windows.create (opens a window)" },
  { pattern: /active:\s*true/, why: "active: true" },
  { pattern: /focused:\s*true/, why: "focused: true" },
  { pattern: /world:\s*["']MAIN["']/, why: "a script in the page's main world" },
  { pattern: /chrome\.cookies|cookies\.get/, why: "cookies" },
  { pattern: /document\.cookie/, why: "document.cookie" },
  { pattern: /localStorage|sessionStorage|indexedDB/, why: "a site's storage" },
];

async function buildFlavor(flavor: Flavor, outRoot: string): Promise<string> {
  const out = join(outRoot, flavor);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, "icons"), { recursive: true });
  const built = await Bun.build({
    entrypoints: [join(ROOT, "src", "background.ts"), join(ROOT, "src", "popup.ts")],
    outdir: out,
    target: "browser",
    format: "esm",
    minify: false,
    splitting: false,
    define: { __WINTER_HOST_NAME__: JSON.stringify(HOST_NAME[flavor]) },
  });
  if (!built.success) throw new Error(`bundling failed:\n${built.logs.map((l) => String(l)).join("\n")}`);
  for (const file of ["background.js", "popup.js"]) {
    const bundle = readFileSync(join(out, file), "utf8");
    const hits = FORBIDDEN_IN_BUNDLE.filter((f) => f.pattern.test(bundle));
    if (hits.length > 0) throw new Error(`the ${flavor} ${file} contains what Winter for Chrome must never do: ${hits.map((h) => h.why).join("; ")}`);
  }
  cpSync(join(ROOT, "src", "popup.html"), join(out, "popup.html"));
  const svg = readFileSync(join(REPO, "assets", "brand", "scale-burst.svg"), "utf8");
  for (const size of [16, 32, 48, 128]) {
    const png = new Resvg(svg, { fitTo: { mode: "width", value: size }, background: "rgba(0,0,0,0)" }).render().asPng();
    writeFileSync(join(out, "icons", `${size}.png`), png);
  }
  writeFileSync(join(out, "manifest.json"), `${JSON.stringify(extensionManifest(flavor, flavor === "dev" ? devKey() : undefined), null, 2)}\n`);
  return out;
}

export async function build(flavors: Flavor[], outRoot = join(ROOT, "dist")): Promise<string[]> {
  const outs: string[] = [];
  for (const f of flavors) outs.push(await buildFlavor(f, outRoot));
  return outs;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const flavorArg = flag("--flavor") ?? "all";
  if (!["dev", "store", "all"].includes(flavorArg)) {
    console.error(`--flavor must be dev, store or all (got ${flavorArg})`);
    process.exit(1);
  }
  const flavors: Flavor[] = flavorArg === "all" ? ["dev", "store"] : [flavorArg as Flavor];
  const outRoot = flag("--out");
  for (const out of await build(flavors, outRoot === undefined ? undefined : resolve(outRoot))) console.error(`built ${out}`);
}
