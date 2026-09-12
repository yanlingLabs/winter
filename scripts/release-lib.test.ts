import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appcastInsertPlan,
  appcastItem,
  caskFrom,
  catalogueStaleness,
  dmgStagePlan,
  embedWinterCheck,
  embedWinterFlagGate,
  embeddedRuntimesDescriptionLine,
  GH_REPO,
  handoffReleaseBody,
  handoffReleaseTitle,
  NAME_SCAN_EXCLUSIONS,
  nameScanPlan,
  preflight,
  publishGuard,
  resolveSigningIdentity,
  row16Gate,
  row16IdentityCheck,
  row16ProvenanceCheck,
  verifyVersionsJsonAgainstPins,
  WINTER_APP_BUNDLE_ID,
} from "./release-lib";
import { sha256File } from "./stage-runtimes";
import { REQUIRED_CLAUDE_AGENT_SDK, REQUIRED_WINTER_AGENT_SDK, REQUIRED_WINTER_RUNTIME_SDK } from "../packages/core/src/runtime-sdk/versions";

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

  test("no description given (existing callers) -> no <description> element at all", () => {
    const xml = appcastItem({ ...base, beta: false });
    expect(xml).not.toContain("<description>");
  });

  test("P8d-2: an optional description renders as a CDATA-wrapped standard <description> element", () => {
    const xml = appcastItem({ ...base, beta: false, description: "Winter agent SDK 0.0.4 · Claude Agent SDK 0.3.250" });
    expect(xml).toContain("<description><![CDATA[Winter agent SDK 0.0.4 · Claude Agent SDK 0.3.250]]></description>");
  });
});

describe("embeddedRuntimesDescriptionLine (P8d-2)", () => {
  test("names both pinned SDK versions", () => {
    expect(embeddedRuntimesDescriptionLine({ winterAgentSdk: REQUIRED_WINTER_AGENT_SDK, officialSdk: REQUIRED_CLAUDE_AGENT_SDK })).toBe(
      `Winter agent SDK ${REQUIRED_WINTER_AGENT_SDK} · Claude Agent SDK ${REQUIRED_CLAUDE_AGENT_SDK}`,
    );
  });
});

describe("verifyVersionsJsonAgainstPins (P8d-2's claude gate, pure half)", () => {
  const sha = "a".repeat(64);
  const goodVersionsJson = JSON.stringify({
    schema: 1,
    winterAgentSdk: REQUIRED_WINTER_AGENT_SDK,
    winterRuntimeSdk: REQUIRED_WINTER_RUNTIME_SDK,
    officialSdk: REQUIRED_CLAUDE_AGENT_SDK,
    claudeCode: "2.1.250",
    checksums: { winterPreSign: sha, claude: sha },
    stagedAt: "2026-09-12T00:00:00Z",
  });

  test("a valid record whose recorded claude checksum matches the actual binary -> ok", () => {
    const r = verifyVersionsJsonAgainstPins({ versionsJsonText: goodVersionsJson, claudeSha256: sha });
    expect(r.ok).toBe(true);
    expect(r.failures).toEqual([]);
    expect(r.versions?.officialSdk).toBe(REQUIRED_CLAUDE_AGENT_SDK);
  });

  test("a checksum mismatch fails, names both hashes, but still returns the parsed record", () => {
    const wrongSha = "b".repeat(64);
    const r = verifyVersionsJsonAgainstPins({ versionsJsonText: goodVersionsJson, claudeSha256: wrongSha });
    expect(r.ok).toBe(false);
    expect(r.failures[0]).toContain(sha);
    expect(r.failures[0]).toContain(wrongSha);
    expect(r.versions).toBeDefined();
  });

  test("unparseable or pin-mismatched VERSIONS.json fails via the SAME gate the executable ladder uses, versions omitted", () => {
    const r = verifyVersionsJsonAgainstPins({ versionsJsonText: "{not json", claudeSha256: sha });
    expect(r.ok).toBe(false);
    expect(r.versions).toBeUndefined();
    expect(r.failures[0]).toContain("VERSIONS.json");
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
      url: "https://github.com/yanlingLabs/winter/releases/download/v0.2.002/Norma-0.2.002.dmg",
    });
    expect(rendered).toContain('version "0.2.002"');
    expect(rendered).toContain('sha256 "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"');
    expect(rendered).toContain(
      'url "https://github.com/yanlingLabs/winter/releases/download/v0.2.002/Norma-0.2.002.dmg"',
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

  test("NAME_SCAN_EXCLUSIONS matches the LibreOffice language-subtag-registry.xml file only — nothing else in that tree", () => {
    const lo = "Contents/Resources/LibreOffice";
    const m = (p: string) => NAME_SCAN_EXCLUSIONS.some((re) => re.test(p));
    expect(m(`${lo}/Resources/liblangtag/language-subtag-registry.xml`)).toBe(true);
    // Anchored to that ONE file — not its parent directory, not a sibling, not the dylib tree.
    expect(m(`${lo}/Resources/liblangtag`)).toBe(false);
    expect(m(`${lo}/Resources`)).toBe(false);
    expect(m(lo)).toBe(false);
    expect(m(`${lo}/Frameworks/libmergedlo.dylib`)).toBe(false);
    expect(m(`${lo}/Resources/liblangtag/language-subtag-registry.txt`)).toBe(false); // wrong extension
    expect(m(`${lo}/Resources/other/language-subtag-registry.xml`)).toBe(false); // wrong directory
    // Not a blanket filename match anywhere in the bundle.
    expect(m("Contents/Resources/language-subtag-registry.xml")).toBe(false);
  });

  test("NAME_SCAN_EXCLUSIONS matches the embedded Winter.app whole (Lane H review r0, Major M1)", () => {
    const m = (p: string) => NAME_SCAN_EXCLUSIONS.some((re) => re.test(p));
    expect(m("Contents/Resources/Winter.app")).toBe(true);
    expect(m("Contents/Resources/Winter.app/Contents/Info.plist")).toBe(true);
    expect(m("Contents/Resources/Winter.app/Contents/Resources/runtimes/winter")).toBe(true);
    // Not a blanket prefix match — a sibling merely starting with "Winter.app" must not sneak in.
    expect(m("Contents/Resources/WinterX.app/Contents/Info.plist")).toBe(false);
    expect(m("Contents/Resources/WinterX.app")).toBe(false);
    // Unrelated paths are unaffected by this rule.
    expect(m("Contents/Resources")).toBe(false);
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

describe("row16ProvenanceCheck (P8d-26: provenance, never rebuild-hash equality)", () => {
  test("a successful rebuild whose hash DIFFERS from the staged build's does NOT fail — bun compiles are not byte-reproducible", () => {
    const r = row16ProvenanceCheck({
      rebuildSucceeded: true,
      freshHash: "a".repeat(64),
      recordedHash: "b".repeat(64),
    });
    expect(r.ok).toBe(true);
    expect(r.failure).toBeUndefined();
    expect(r.record.hashesMatch).toBe(false);
    expect(r.record.freshHash).toBe("a".repeat(64));
    expect(r.record.recordedHash).toBe("b".repeat(64));
  });

  test("a successful rebuild whose hash MATCHES is also ok, and reports hashesMatch: true", () => {
    const same = "c".repeat(64);
    const r = row16ProvenanceCheck({ rebuildSucceeded: true, freshHash: same, recordedHash: same });
    expect(r.ok).toBe(true);
    expect(r.record.hashesMatch).toBe(true);
  });

  test("a failed rebuild (e.g. the checkout is at the wrong tag — buildWinter's own checkoutIsAtTag gate) FAILS, naming the reason", () => {
    const r = row16ProvenanceCheck({
      rebuildSucceeded: false,
      rebuildError: "build-winter: /checkout's HEAD carries 'v0.0.3', not v0.0.4; check out the pinned tag",
      recordedHash: "d".repeat(64),
    });
    expect(r.ok).toBe(false);
    expect(r.failure).toContain("v0.0.3");
    expect(r.failure).toContain("not v0.0.4");
    expect(r.record.rebuildSucceeded).toBe(false);
    expect(r.record.freshHash).toBeUndefined();
    expect(r.record.hashesMatch).toBeUndefined();
  });

  test("a failed rebuild with no error message still fails, with a fallback reason rather than 'undefined'", () => {
    const r = row16ProvenanceCheck({ rebuildSucceeded: false, recordedHash: "e".repeat(64) });
    expect(r.ok).toBe(false);
    expect(r.failure).toContain("unknown reason");
  });

  test("the record always carries recordedHash, whether the rebuild succeeded or failed", () => {
    const ok = row16ProvenanceCheck({ rebuildSucceeded: true, freshHash: "f".repeat(64), recordedHash: "g".repeat(64) });
    const failed = row16ProvenanceCheck({ rebuildSucceeded: false, rebuildError: "boom", recordedHash: "g".repeat(64) });
    expect(ok.record.recordedHash).toBe("g".repeat(64));
    expect(failed.record.recordedHash).toBe("g".repeat(64));
  });
});

describe("row16IdentityCheck (P9a-8: the STRONG checksum-equality path)", () => {
  const sha = (b: string) => b.repeat(64);
  const goodVersionsJson = (overrides: Record<string, unknown> = {}) =>
    JSON.stringify({
      schema: 1,
      winterAgentSdk: REQUIRED_WINTER_AGENT_SDK,
      winterRuntimeSdk: REQUIRED_WINTER_RUNTIME_SDK,
      officialSdk: REQUIRED_CLAUDE_AGENT_SDK,
      claudeCode: "2.1.250",
      checksums: { winterPreSign: sha("a"), claude: sha("b") },
      stagedAt: "2026-09-12T00:00:00Z",
      winterSource: "platform-package",
      ...overrides,
    });

  const temps: string[] = [];
  afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });
  const tempFile = (content: string): string => {
    const dir = mkdtempSync(join(tmpdir(), "row16-identity-"));
    temps.push(dir);
    const p = join(dir, "winter-fake");
    writeFileSync(p, content);
    return p;
  };

  test("STRONG OK: winterSource=platform-package and the embedded checksum equals the installed package's own checksum", () => {
    const pkgPath = tempFile("the installed platform package's own winter bytes\n");
    const embeddedSha = sha256File(pkgPath); // the embed is byte-identical to what's installed
    const r = row16IdentityCheck({
      versionsJsonText: goodVersionsJson({ checksums: { winterPreSign: embeddedSha, claude: sha("b") } }),
      platformPackageBinPath: pkgPath,
      embeddedPreSignSha256: embeddedSha,
    });
    expect(r).toEqual({ ok: true, strong: true, detail: expect.stringContaining("STRONG") });
  });

  test("STRONG MISMATCH: winterSource=platform-package but the checksums disagree — the embed does not match what npm shipped", () => {
    const pkgPath = tempFile("the CURRENTLY installed platform package's winter bytes (post-republish)\n");
    const installedSha = sha256File(pkgPath);
    const staleEmbeddedSha = sha("f"); // whatever was embedded at a prior staging time
    const r = row16IdentityCheck({
      versionsJsonText: goodVersionsJson({ checksums: { winterPreSign: staleEmbeddedSha, claude: sha("b") } }),
      platformPackageBinPath: pkgPath,
      embeddedPreSignSha256: staleEmbeddedSha,
    });
    expect(r.ok).toBe(false);
    expect(r.strong).toBe(true);
    expect(r.detail).toContain("STRONG check FAILED");
    expect(r.detail).toContain(staleEmbeddedSha);
    expect(r.detail).toContain(installedSha);
  });

  test("WEAK: winterSource=checkout-build never attempts the strong path, and is ok on its own (release.ts is what gates it)", () => {
    const r = row16IdentityCheck({
      versionsJsonText: goodVersionsJson({ winterSource: "checkout-build" }),
      platformPackageBinPath: undefined,
      embeddedPreSignSha256: sha("a"),
    });
    expect(r).toEqual({ ok: true, strong: false, detail: expect.stringContaining("WEAK") });
  });

  test("WEAK (absent winterSource, an 8d-era bundle) behaves identically to explicit checkout-build", () => {
    const text = JSON.stringify({
      schema: 1,
      winterAgentSdk: REQUIRED_WINTER_AGENT_SDK,
      winterRuntimeSdk: REQUIRED_WINTER_RUNTIME_SDK,
      officialSdk: REQUIRED_CLAUDE_AGENT_SDK,
      claudeCode: "2.1.250",
      checksums: { winterPreSign: sha("a"), claude: sha("b") },
      stagedAt: "2026-09-12T00:00:00Z",
      // no winterSource field at all
    });
    const r = row16IdentityCheck({ versionsJsonText: text, platformPackageBinPath: undefined, embeddedPreSignSha256: sha("a") });
    expect(r.ok).toBe(true);
    expect(r.strong).toBe(false);
  });

  test("MISSING PACKAGE: winterSource=platform-package but no platform package is installed on this machine -> fails, strong: true", () => {
    const r = row16IdentityCheck({
      versionsJsonText: goodVersionsJson(),
      platformPackageBinPath: undefined,
      embeddedPreSignSha256: sha("a"),
    });
    expect(r.ok).toBe(false);
    expect(r.strong).toBe(true);
    expect(r.detail).toContain("no @yanlinglabs/winter-agent-sdk-darwin-arm64 platform package is installed");
  });

  test("an unparseable VERSIONS.json fails cleanly, never throws", () => {
    const r = row16IdentityCheck({ versionsJsonText: "{", platformPackageBinPath: undefined, embeddedPreSignSha256: sha("a") });
    expect(r.ok).toBe(false);
    expect(r.strong).toBe(false);
    expect(r.detail).toContain("VERSIONS.json");
  });
});

describe("row16Gate (P9a-8: --allow-checkout-winter / --dry-run flag logic)", () => {
  const strongOk = { ok: true, strong: true, detail: "strong ok" } as const;
  const strongFail = { ok: false, strong: true, detail: "strong failed: mismatch" } as const;
  const weak = { ok: true, strong: false, detail: "weak" } as const;

  test("STRONG + ok: always proceeds, regardless of dryRun/allowCheckoutWinter", () => {
    for (const dryRun of [true, false]) {
      for (const allowCheckoutWinter of [true, false]) {
        expect(row16Gate({ identity: strongOk, dryRun, allowCheckoutWinter })).toEqual({ proceed: true });
      }
    }
  });

  test("STRONG + failed (mismatch/missing package): ALWAYS fatal, even with --allow-checkout-winter or --dry-run", () => {
    for (const dryRun of [true, false]) {
      for (const allowCheckoutWinter of [true, false]) {
        const r = row16Gate({ identity: strongFail, dryRun, allowCheckoutWinter });
        expect(r.proceed).toBe(false);
        expect(r.failure).toBe("strong failed: mismatch");
      }
    }
  });

  test("WEAK + --dry-run (no --allow-checkout-winter): proceeds — a rehearsal is exempt", () => {
    expect(row16Gate({ identity: weak, dryRun: true, allowCheckoutWinter: false })).toEqual({ proceed: true });
  });

  test("WEAK + --allow-checkout-winter (non-dry-run): proceeds — the loud escape hatch", () => {
    expect(row16Gate({ identity: weak, dryRun: false, allowCheckoutWinter: true })).toEqual({ proceed: true });
  });

  test("WEAK + neither flag, non-dry-run: FAILS — a real release requires the strong path by default", () => {
    const r = row16Gate({ identity: weak, dryRun: false, allowCheckoutWinter: false });
    expect(r.proceed).toBe(false);
    expect(r.failure).toContain("--allow-checkout-winter");
    expect(r.failure).toContain("STRONG checksum-equality path");
  });
});

describe("GH_REPO (P9c-12)", () => {
  test("points at the renamed repo, not the pre-rename name", () => {
    expect(GH_REPO).toBe("yanlingLabs/winter");
  });
});

describe("embedWinterFlagGate (Winter Phase 9c, Lane H)", () => {
  test("a path given -> always 'embed', dry-run or not", () => {
    expect(embedWinterFlagGate({ dryRun: false, embedWinterPath: "/tmp/Winter.app" })).toEqual({ action: "embed" });
    expect(embedWinterFlagGate({ dryRun: true, embedWinterPath: "/tmp/Winter.app" })).toEqual({ action: "embed" });
  });

  test("no path, --dry-run -> 'none' (a rehearsal may proceed with no embedded Winter.app)", () => {
    expect(embedWinterFlagGate({ dryRun: true, embedWinterPath: undefined })).toEqual({ action: "none" });
  });

  test("no path, non-dry-run -> 'refuse' with the exact user-facing line", () => {
    const r = embedWinterFlagGate({ dryRun: false, embedWinterPath: undefined });
    expect(r.action).toBe("refuse");
    expect(r.failure).toBe("--embed-winter is required for the handoff release");
  });
});

describe("embedWinterCheck (Winter Phase 9c, Lane H)", () => {
  const passing = { bundleIdentifier: WINTER_APP_BUNDLE_ID, signatureOk: true, staplingOk: true };

  test("every check passing -> ok", () => {
    expect(embedWinterCheck(passing)).toEqual({ ok: true, failures: [] });
  });

  test("wrong bundle identifier fails with the exact identifier named in the message", () => {
    const r = embedWinterCheck({ ...passing, bundleIdentifier: "com.norma.app" });
    expect(r.ok).toBe(false);
    expect(r.failures).toEqual([
      `--embed-winter: CFBundleIdentifier is "com.norma.app", expected "${WINTER_APP_BUNDLE_ID}"`,
    ]);
  });

  test("missing/unreadable bundle identifier reports \"(missing)\"", () => {
    const r = embedWinterCheck({ ...passing, bundleIdentifier: undefined });
    expect(r.failures[0]).toContain('"(missing)"');
  });

  test("signature failure and stapling failure each surface their own line", () => {
    const r = embedWinterCheck({ ...passing, signatureOk: false, staplingOk: false });
    expect(r.ok).toBe(false);
    expect(r.failures).toEqual([
      "--embed-winter: codesign --verify --deep --strict failed on the candidate Winter.app",
      "--embed-winter: xcrun stapler validate failed on the candidate Winter.app — it must be notarized and stapled",
    ]);
  });

  test("aggregates every failing check at once, not just the first", () => {
    const r = embedWinterCheck({ bundleIdentifier: "com.norma.app", signatureOk: false, staplingOk: false });
    expect(r.failures).toHaveLength(3);
  });
});

describe("handoffReleaseTitle / handoffReleaseBody (Winter Phase 9c, Lane H)", () => {
  test("title names both the version and the handoff", () => {
    expect(handoffReleaseTitle("0.2.015")).toBe("Norma 0.2.015 — Norma is now Winter");
  });

  test("body with a known embed size names the handoff, the size, and the last-release fact", () => {
    const body = handoffReleaseBody({ version: "0.2.015", beta: false, embeddedWinterSizeBytes: 50 * 1024 * 1024 });
    expect(body).toContain("Norma is now Winter");
    expect(body).toContain("LAST Norma release");
    expect(body).toContain("50.0 MB");
  });

  test("body renders (with no size line) when embeddedWinterSizeBytes is null", () => {
    const body = handoffReleaseBody({ version: "0.2.015", beta: false, embeddedWinterSizeBytes: null });
    expect(body).toContain("Norma is now Winter");
    expect(body).not.toContain("MB)");
  });

  test("beta threads into the body the same way the pre-existing notes string did", () => {
    const body = handoffReleaseBody({ version: "0.2.015", beta: true, embeddedWinterSizeBytes: null });
    expect(body).toContain("0.2.015 (beta)");
  });
});
