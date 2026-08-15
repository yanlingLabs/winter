import { describe, expect, test } from "bun:test";
import {
  appcastInsertPlan,
  appcastItem,
  caskFrom,
  catalogueStaleness,
  dmgStagePlan,
  NAME_SCAN_EXCLUSIONS,
  nameScanPlan,
  preflight,
  publishGuard,
  resolveSigningIdentity,
} from "./release-lib";

describe("preflight", () => {
  test("every check passing -> ok with no failures", () => {
    const result = preflight({ checks: { a: () => null, b: () => null, c: () => null } });
    expect(result).toEqual({ ok: true, failures: [] });
  });

  test("a single failing check surfaces its exact line", () => {
    const result = preflight({
      checks: { a: () => null, b: () => "exact user-facing failure line" },
    });
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(["exact user-facing failure line"]);
  });

  test("aggregates every failing check at once, not just the first", () => {
    const result = preflight({
      checks: {
        identity: () => "missing Developer ID identity for team 37N77U9RSZ — create it in Xcode > Settings > Accounts > Manage Certificates",
        notary: () => null,
        prodKey: () => "production Sparkle key missing — run: .tools/sparkle/bin/generate_keys   (60 seconds; back it up with -x)",
        gh: () => null,
        tag: () => "tag v0.2.001 already exists — bump the version or delete the stale tag",
      },
    });
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual([
      "missing Developer ID identity for team 37N77U9RSZ — create it in Xcode > Settings > Accounts > Manage Certificates",
      "production Sparkle key missing — run: .tools/sparkle/bin/generate_keys   (60 seconds; back it up with -x)",
      "tag v0.2.001 already exists — bump the version or delete the stale tag",
    ]);
  });

  test("no checks -> vacuously ok", () => {
    expect(preflight({ checks: {} })).toEqual({ ok: true, failures: [] });
  });
});

describe("appcastItem", () => {
  const base = {
    version: "0.2.002",
    zipName: "Norma-0.2.002.zip",
    edSignature: "gr6VoIYzbcgIf6ScRRcbnPRnKPKtNGeHmVBqZlHEr3XQ0V6WQdT/E1eeGz1nA9Am==",
    length: 12345678,
    minSystem: "26.0",
  };

  test("stable release (beta:false) has no channel element", () => {
    const xml = appcastItem({ ...base, beta: false });
    expect(xml).not.toContain("sparkle:channel");
  });

  test("beta release (beta:true) has exactly one channel element", () => {
    const xml = appcastItem({ ...base, beta: true });
    const matches = xml.match(/<sparkle:channel>beta<\/sparkle:channel>/g);
    expect(matches?.length).toBe(1);
  });

  test("fields match the Sparkle schema used by the gate rig", () => {
    const xml = appcastItem({ ...base, beta: false });
    expect(xml).toContain("<sparkle:version>0.2.002</sparkle:version>");
    expect(xml).toContain("<sparkle:shortVersionString>0.2.002</sparkle:shortVersionString>");
    expect(xml).toContain("<sparkle:minimumSystemVersion>26.0</sparkle:minimumSystemVersion>");
    expect(xml).toContain(`sparkle:edSignature="${base.edSignature}"`);
    expect(xml).toContain(`length="${base.length}"`);
    expect(xml).toContain('type="application/octet-stream"');
    expect(xml).toContain(base.zipName);
    expect(xml).toContain("<item>");
    expect(xml).toContain("</item>");
  });
});

describe("caskFrom", () => {
  const tmpl = `cask "norma" do
  version "{{version}}"
  sha256 "{{sha256}}"
  url "{{url}}"
  name "Norma {{version}}"
end
`;

  test("interpolates every placeholder, including repeats", () => {
    const rendered = caskFrom(tmpl, {
      version: "0.2.002",
      sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      url: "https://github.com/yanlingLabs/norma/releases/download/v0.2.002/Norma-0.2.002.dmg",
    });
    expect(rendered).toContain('version "0.2.002"');
    expect(rendered).toContain('sha256 "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"');
    expect(rendered).toContain(
      'url "https://github.com/yanlingLabs/norma/releases/download/v0.2.002/Norma-0.2.002.dmg"',
    );
    expect(rendered).toContain('name "Norma 0.2.002"');
    expect(rendered).not.toContain("{{");
    expect(rendered).not.toContain("}}");
  });
});

describe("dmgStagePlan", () => {
  test("plans a copy of the app plus an /Applications symlink", () => {
    const ops = dmgStagePlan("/out/release/0.2.002/dd/Build/Products/Release/Norma.app");
    expect(ops).toEqual([
      {
        kind: "copy",
        source: "/out/release/0.2.002/dd/Build/Products/Release/Norma.app",
        destName: "Norma.app",
      },
      { kind: "symlink", source: "/Applications", destName: "Applications" },
    ]);
  });

  test("throws on a path that doesn't end in .app", () => {
    expect(() => dmgStagePlan("/out/release/0.2.002/Norma.zip")).toThrow();
  });

  test("tolerates a trailing slash on the app path", () => {
    const ops = dmgStagePlan("/tmp/Norma.app/");
    expect(ops[0]).toEqual({ kind: "copy", source: "/tmp/Norma.app/", destName: "Norma.app" });
  });
});

describe("nameScanPlan (panel-cef Task 5 — §11b's exclusion, expressed in the repo)", () => {
  // A miniature Norma.app: two locally-compiled bits, one third-party framework in the VERSIONED
  // layout project.yml actually embeds (Versions/A + Current + top-level symlinks), and the
  // licence notices. Keys are POSIX-relative paths; a value of null is a file, and names listed
  // in SYMLINKS are symlinks — which release.ts's real callbacks filter out, because `find
  // -type f` neither counts nor traverses them.
  const SYMLINKS = new Set([
    "Contents/Frameworks/Chromium Embedded Framework.framework/Chromium Embedded Framework",
    "Contents/Frameworks/Chromium Embedded Framework.framework/Libraries",
    "Contents/Frameworks/Chromium Embedded Framework.framework/Resources",
    "Contents/Frameworks/Chromium Embedded Framework.framework/Versions/Current",
  ]);
  const tree: Record<string, string[] | null> = {
    "": ["Contents"],
    Contents: ["MacOS", "Resources", "Frameworks"],
    "Contents/MacOS": ["Norma", "NormaHelper"],
    "Contents/MacOS/Norma": null,
    "Contents/MacOS/NormaHelper": null,
    "Contents/Resources": ["norma-core", "Licenses"],
    "Contents/Resources/norma-core": null,
    "Contents/Resources/Licenses": ["CEF-LICENSE.txt", "CREDITS.html"],
    "Contents/Resources/Licenses/CEF-LICENSE.txt": null,
    "Contents/Resources/Licenses/CREDITS.html": null,
    Frameworks: null, // unreachable; present only to prove absolute paths are used, not names
    "Contents/Frameworks": ["Sparkle.framework", "Chromium Embedded Framework.framework"],
    "Contents/Frameworks/Sparkle.framework": ["Sparkle"],
    "Contents/Frameworks/Sparkle.framework/Sparkle": null,
    // Framework root: the three top-level symlinks plus the real Versions/ dir.
    "Contents/Frameworks/Chromium Embedded Framework.framework": ["Chromium Embedded Framework", "Libraries", "Resources", "Versions"],
    "Contents/Frameworks/Chromium Embedded Framework.framework/Chromium Embedded Framework": null,
    "Contents/Frameworks/Chromium Embedded Framework.framework/Libraries": null,
    "Contents/Frameworks/Chromium Embedded Framework.framework/Resources": null,
    "Contents/Frameworks/Chromium Embedded Framework.framework/Versions": ["A", "Current"],
    "Contents/Frameworks/Chromium Embedded Framework.framework/Versions/Current": null,
    "Contents/Frameworks/Chromium Embedded Framework.framework/Versions/A": ["Chromium Embedded Framework", "Libraries", "Resources", "_CodeSignature"],
    "Contents/Frameworks/Chromium Embedded Framework.framework/Versions/A/Chromium Embedded Framework": null,
    "Contents/Frameworks/Chromium Embedded Framework.framework/Versions/A/_CodeSignature": ["CodeResources"],
    "Contents/Frameworks/Chromium Embedded Framework.framework/Versions/A/_CodeSignature/CodeResources": null,
    "Contents/Frameworks/Chromium Embedded Framework.framework/Versions/A/Libraries": ["libcef_sandbox.dylib"],
    "Contents/Frameworks/Chromium Embedded Framework.framework/Versions/A/Libraries/libcef_sandbox.dylib": null,
    "Contents/Frameworks/Chromium Embedded Framework.framework/Versions/A/Resources": ["resources.pak", "en.lproj", "sw.lproj"],
    "Contents/Frameworks/Chromium Embedded Framework.framework/Versions/A/Resources/resources.pak": null,
    "Contents/Frameworks/Chromium Embedded Framework.framework/Versions/A/Resources/en.lproj": ["locale.pak"],
    "Contents/Frameworks/Chromium Embedded Framework.framework/Versions/A/Resources/en.lproj/locale.pak": null,
    "Contents/Frameworks/Chromium Embedded Framework.framework/Versions/A/Resources/sw.lproj": ["locale.pak"],
    "Contents/Frameworks/Chromium Embedded Framework.framework/Versions/A/Resources/sw.lproj/locale.pak": null,
  };
  const ROOT = "/out/Norma.app";
  const rel = (absPath: string) => (absPath === ROOT ? "" : absPath.slice(ROOT.length + 1));
  // Mirrors release.ts's real callbacks: symlink-filtered listing + lstat-style isDir.
  const io = {
    root: ROOT,
    listDir: (absPath: string) =>
      (tree[rel(absPath)] ?? []).filter((name) => !SYMLINKS.has(rel(absPath) === "" ? name : `${rel(absPath)}/${name}`)),
    isDir: (absPath: string) =>
      !SYMLINKS.has(rel(absPath)) && tree[rel(absPath)] !== null && tree[rel(absPath)] !== undefined,
  };
  const isExcluded = (relPath: string) => NAME_SCAN_EXCLUSIONS.some((re) => re.test(relPath));

  test("no exclusions matching -> scans the bundle whole, exactly as before Task 5", () => {
    const plan = nameScanPlan({ ...io, isExcluded: () => false });
    expect(plan).toEqual({ targets: [ROOT], excluded: [] });
  });

  test("the shipped exclusion list removes the .lproj packs and NOTHING else", () => {
    const plan = nameScanPlan({ ...io, isExcluded });
    const fw = `${ROOT}/Contents/Frameworks/Chromium Embedded Framework.framework`;
    expect(plan.excluded).toEqual([`${fw}/Versions/A/Resources/en.lproj`, `${fw}/Versions/A/Resources/sw.lproj`]);
    // Every real (non-symlink) leaf file except the two locale packs must be covered.
    const files = Object.entries(tree)
      .filter(([k, v]) => v === null && k !== "Frameworks" && !SYMLINKS.has(k))
      .map(([k]) => `${ROOT}/${k}`);
    const covered = files.filter((f) => plan.targets.some((t) => f === t || f.startsWith(`${t}/`)));
    expect(covered.sort()).toEqual(files.filter((f) => !f.includes(".lproj")).sort());
  });

  test("symlinks are never emitted, so no path is reachable twice and find -type f agrees", () => {
    const plan = nameScanPlan({ ...io, isExcluded });
    for (const link of SYMLINKS) {
      const abs = `${ROOT}/${link}`;
      expect(plan.targets).not.toContain(abs);
      // Nor reachable THROUGH an emitted directory target: the framework root itself is only
      // ever emitted piecemeal here, and the top-level `Resources` symlink would otherwise be a
      // second, unexcluded route to the locale packs.
      expect(plan.targets.some((t) => abs.startsWith(`${t}/`))).toBe(false);
    }
  });

  test("subtrees with nothing excluded are emitted whole, so the target list stays auditable", () => {
    const plan = nameScanPlan({ ...io, isExcluded });
    // Sparkle and MacOS are untouched by the exclusion: one path each, not one per file.
    expect(plan.targets).toContain(`${ROOT}/Contents/Frameworks/Sparkle.framework`);
    expect(plan.targets).toContain(`${ROOT}/Contents/MacOS`);
    // The CEF Mach-O, its dylibs and the non-locale resources are all still scanned.
    const fw = `${ROOT}/Contents/Frameworks/Chromium Embedded Framework.framework`;
    expect(plan.targets).toContain(`${fw}/Versions/A/Chromium Embedded Framework`);
    expect(plan.targets).toContain(`${fw}/Versions/A/Libraries`);
    expect(plan.targets).toContain(`${fw}/Versions/A/Resources/resources.pak`);
    // CREDITS.html measured ZERO hits, so it is deliberately still scanned.
    expect(plan.targets.some((t) => `${ROOT}/Contents/Resources/Licenses/CREDITS.html`.startsWith(t))).toBe(true);
    expect(plan.targets.length).toBeLessThan(12);
  });

  test("targets and exclusions never overlap", () => {
    const plan = nameScanPlan({ ...io, isExcluded });
    for (const e of plan.excluded) {
      expect(plan.targets.some((t) => e === t || e.startsWith(`${t}/`))).toBe(false);
    }
  });

  test("NAME_SCAN_EXCLUSIONS matches locale dirs only — not the framework, its binary, or CREDITS", () => {
    const fw = "Contents/Frameworks/Chromium Embedded Framework.framework";
    const m = (p: string) => NAME_SCAN_EXCLUSIONS.some((re) => re.test(p));
    expect(m(`${fw}/Versions/A/Resources/sw.lproj`)).toBe(true);
    expect(m(`${fw}/Versions/A/Resources/zh-TW.lproj`)).toBe(true);
    expect(m(fw)).toBe(false);
    expect(m(`${fw}/Versions/A/Chromium Embedded Framework`)).toBe(false);
    expect(m(`${fw}/Versions/A/Resources/resources.pak`)).toBe(false);
    expect(m(`${fw}/Versions/A/Libraries/libcef_sandbox.dylib`)).toBe(false);
    expect(m("Contents/Resources/Licenses/CREDITS.html")).toBe(false);
    expect(m("Contents/MacOS/Norma")).toBe(false);
    // Not a blanket "any .lproj anywhere" — Norma's own resources stay scanned.
    expect(m("Contents/Resources/en.lproj")).toBe(false);
    // Nor a subdirectory sneaking past the anchor.
    expect(m(`${fw}/Versions/A/Resources/sw.lproj/locale.pak`)).toBe(false);
    // The top-level `Resources` SYMLINK route is deliberately unmatched — the walker never
    // follows it, so matching it too would be dead policy hiding a walker regression.
    expect(m(`${fw}/Resources/sw.lproj`)).toBe(false);
  });

  test("NAME_SCAN_EXCLUSIONS matches vendored Monaco's vs/ tree only — not the app/ page shell or EditorAssets itself", () => {
    const m = (p: string) => NAME_SCAN_EXCLUSIONS.some((re) => re.test(p));
    // The vendored, unreviewed third-party tree — excluded whole, at the directory node and
    // at any depth beneath it.
    expect(m("Contents/Resources/EditorAssets/vs")).toBe(true);
    expect(m("Contents/Resources/EditorAssets/vs/loader.js")).toBe(true);
    expect(m("Contents/Resources/EditorAssets/vs/base/worker/workerMain.js")).toBe(true);
    // Task 4's in-repo page shell — Norma's OWN code — stays scanned.
    expect(m("Contents/Resources/EditorAssets/app")).toBe(false);
    expect(m("Contents/Resources/EditorAssets/app/index.html")).toBe(false);
    // The parent dir itself (not the vs/ child) stays scanned.
    expect(m("Contents/Resources/EditorAssets")).toBe(false);
    // The licence notice this same embed phase writes stays scanned.
    expect(m("Contents/Resources/Licenses/MONACO-LICENSE.txt")).toBe(false);
    // Not a blanket prefix match — a sibling name merely starting with "vs" must not sneak in.
    expect(m("Contents/Resources/EditorAssets/vsx")).toBe(false);
    // Unrelated CEF paths are unaffected by this rule.
    expect(m("Contents/MacOS/Norma")).toBe(false);
  });
});

describe("appcastInsertPlan", () => {
  const emptyChannel = `<?xml version="1.0"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
  <channel>
    <title>Norma Changelog</title>
  </channel>
</rss>
`;
  const item = `    <item>
      <sparkle:version>0.2.002</sparkle:version>
    </item>`;

  test("dry-run + absent version -> preview target, insert action", () => {
    const plan = appcastInsertPlan({ dryRun: true, version: "0.2.002", appcastXml: emptyChannel, item });
    expect(plan.target).toBe("preview");
    expect(plan.action).toBe("insert");
    expect(plan.updatedXml).toBeDefined();
  });

  test("non-dry-run + absent version -> repo target, insert action", () => {
    const plan = appcastInsertPlan({ dryRun: false, version: "0.2.002", appcastXml: emptyChannel, item });
    expect(plan.target).toBe("repo");
    expect(plan.action).toBe("insert");
    expect(plan.updatedXml).toBeDefined();
  });

  test("updatedXml inserts the item immediately before </channel>, exactly once", () => {
    const plan = appcastInsertPlan({ dryRun: false, version: "0.2.002", appcastXml: emptyChannel, item });
    const xml = plan.updatedXml!;
    const itemMatches = xml.match(/<item>/g);
    expect(itemMatches?.length).toBe(1);
    const channelCloseIndex = xml.indexOf("</channel>");
    const itemIndex = xml.indexOf("<item>");
    expect(itemIndex).toBeGreaterThan(-1);
    expect(itemIndex).toBeLessThan(channelCloseIndex);
    // Nothing but the item + a newline/indent sits between the item's close and </channel>.
    expect(xml.slice(xml.indexOf("</item>") + "</item>".length, channelCloseIndex).trim()).toBe("");
  });

  test("version already present -> skip, dry-run", () => {
    const withItem = emptyChannel.replace("</channel>", `${item}\n  </channel>`);
    const plan = appcastInsertPlan({ dryRun: true, version: "0.2.002", appcastXml: withItem, item });
    expect(plan.target).toBe("preview");
    expect(plan.action).toBe("skip");
    expect(plan.updatedXml).toBeUndefined();
  });

  test("version already present -> skip, non-dry-run (resume-safe: no duplicate item)", () => {
    const withItem = emptyChannel.replace("</channel>", `${item}\n  </channel>`);
    const plan = appcastInsertPlan({ dryRun: false, version: "0.2.002", appcastXml: withItem, item });
    expect(plan.target).toBe("repo");
    expect(plan.action).toBe("skip");
    expect(plan.updatedXml).toBeUndefined();
  });

  test("a DIFFERENT version already present does not block inserting this one", () => {
    const otherItem = `    <item>\n      <sparkle:version>0.1.999</sparkle:version>\n    </item>`;
    const withOther = emptyChannel.replace("</channel>", `${otherItem}\n  </channel>`);
    const plan = appcastInsertPlan({ dryRun: false, version: "0.2.002", appcastXml: withOther, item });
    expect(plan.action).toBe("insert");
    expect(plan.updatedXml).toContain("0.1.999");
    expect(plan.updatedXml).toContain("0.2.002");
  });

  test("missing </channel> anchor throws", () => {
    expect(() =>
      appcastInsertPlan({ dryRun: false, version: "0.2.002", appcastXml: "<rss></rss>", item }),
    ).toThrow();
  });
});

describe("resolveSigningIdentity", () => {
  const sampleOutput = `Policy: Code Signing
  1) AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA "Developer ID Application: Norma (37N77U9RSZ)"
  2) BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB "Apple Development: dev@example.com (37N77U9RSZ)"
  3) CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC "Developer ID Application: Norma (OTHERTEAM1)"
     3 valid identities found
`;

  test("finds the hash of the Developer ID Application identity for the given team", () => {
    const hash = resolveSigningIdentity({ identitiesOutput: sampleOutput, teamId: "37N77U9RSZ" });
    expect(hash).toBe("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  });

  test("ignores a Developer ID Application identity for a DIFFERENT team", () => {
    const hash = resolveSigningIdentity({ identitiesOutput: sampleOutput, teamId: "OTHERTEAM1" });
    expect(hash).toBe("CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC");
  });

  test("ignores a matching team on a non-'Developer ID Application' identity", () => {
    expect(() =>
      resolveSigningIdentity({
        identitiesOutput: `  1) BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB "Apple Development: dev@example.com (37N77U9RSZ)"\n`,
        teamId: "37N77U9RSZ",
      }),
    ).toThrow();
  });

  test("throws a clear error when no identity matches the team", () => {
    expect(() => resolveSigningIdentity({ identitiesOutput: sampleOutput, teamId: "NOTAREALTEAM" })).toThrow(
      "no Developer ID Application identity for team NOTAREALTEAM — create it in Xcode",
    );
  });

  test("empty identities output throws", () => {
    expect(() => resolveSigningIdentity({ identitiesOutput: "", teamId: "37N77U9RSZ" })).toThrow();
  });

  test("envOverride wins immediately — no lookup performed, identitiesOutput can be garbage", () => {
    const hash = resolveSigningIdentity({
      envOverride: "DEADBEEF00000000000000000000000000000000",
      identitiesOutput: "not even real find-identity output",
      teamId: "37N77U9RSZ",
    });
    expect(hash).toBe("DEADBEEF00000000000000000000000000000000");
  });
});

describe("publishGuard", () => {
  const base = { version: "0.2.002" };

  test("--dry-run always skips publish (even with a stale tag/release), reporting a skip-list", () => {
    const g = publishGuard({ dryRun: true, resumePublish: false, tagExists: true, releaseExists: true, ...base });
    expect(g.action).toBe("dry-run-skip");
    expect(g.lines.length).toBeGreaterThan(0);
    expect(g.lines.join("\n")).toContain("v0.2.002");
  });

  test("tag already exists -> abort with the exact line", () => {
    const g = publishGuard({ dryRun: false, resumePublish: false, tagExists: true, releaseExists: false, ...base });
    expect(g.action).toBe("abort");
    expect(g.lines).toEqual([
      "tag v0.2.002 already exists — aborting to avoid double-publish (pass --resume-publish if a prior publish attempt partially completed)",
    ]);
  });

  test("release already exists -> abort with the exact line", () => {
    const g = publishGuard({ dryRun: false, resumePublish: false, tagExists: false, releaseExists: true, ...base });
    expect(g.action).toBe("abort");
    expect(g.lines).toEqual([
      "release v0.2.002 already exists on GitHub — aborting to avoid double-publish (pass --resume-publish if a prior publish attempt partially completed)",
    ]);
  });

  test("both tag and release exist -> aggregates both abort lines", () => {
    const g = publishGuard({ dryRun: false, resumePublish: false, tagExists: true, releaseExists: true, ...base });
    expect(g.action).toBe("abort");
    expect(g.lines.length).toBe(2);
  });

  test("--resume-publish with no existing release -> abort, nothing to resume", () => {
    const g = publishGuard({ dryRun: false, resumePublish: true, tagExists: false, releaseExists: false, ...base });
    expect(g.action).toBe("abort");
    expect(g.lines).toEqual(["--resume-publish given but release v0.2.002 does not exist — nothing to resume"]);
  });

  test("--resume-publish with an existing release -> resume, no abort lines", () => {
    const g = publishGuard({ dryRun: false, resumePublish: true, tagExists: true, releaseExists: true, ...base });
    expect(g.action).toBe("resume");
    expect(g.lines).toEqual([]);
  });

  test("clean state, not dry-run, not resuming -> publish", () => {
    const g = publishGuard({ dryRun: false, resumePublish: false, tagExists: false, releaseExists: false, ...base });
    expect(g.action).toBe("publish");
    expect(g.lines).toEqual([]);
  });
});

describe("catalogueStaleness (T2 review M2 — warn-only nudge in the release pipeline)", () => {
  const verified = "2026-07-31";

  test("inside the budget -> not stale, no line", () => {
    const r = catalogueStaleness({ verified, now: new Date("2026-09-01T00:00:00Z") });
    expect(r.stale).toBe(false);
    expect(r.line).toBeNull();
  });

  test("past the budget -> stale, with a line naming the date, the age and the re-derive command", () => {
    const r = catalogueStaleness({ verified, now: new Date("2027-01-31T00:00:00Z") });
    expect(r.stale).toBe(true);
    expect(r.ageDays).toBeGreaterThan(120);
    expect(r.line).toContain(verified);
    expect(r.line).toContain("NORMA_CODEX_LIVE_DRIFT=1");
  });

  test("exactly at the budget is NOT stale (warn only once genuinely past it)", () => {
    const r = catalogueStaleness({ verified, now: new Date("2026-11-28T00:00:00Z") });
    expect(r.ageDays).toBe(120);
    expect(r.stale).toBe(false);
  });

  test("an unparseable date warns rather than silently passing", () => {
    const r = catalogueStaleness({ verified: "soon", now: new Date("2026-09-01T00:00:00Z") });
    expect(r.stale).toBe(true);
    expect(r.line).toContain("not a parseable date");
  });
});
