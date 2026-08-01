import { describe, expect, test } from "bun:test";
import {
  appcastInsertPlan,
  appcastItem,
  caskFrom,
  catalogueStaleness,
  dmgStagePlan,
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
