// Winter Phase 9b — the codemod's rule corpus (P9b-1/P9b-8). Pure functions only; no git.
import { describe, expect, test } from "bun:test";
import { entryAppliesTo, globToRegex, isExemptPath, planMoves, renamePath, rewriteText, scaffoldPresent } from "./codemod";
import { EXPLICIT_TOKEN_MAP, RENAME_ALLOWLIST } from "./allowlist";

const rw = (s: string, path = "packages/core/src/x.ts") => rewriteText(s, path);

describe("generic pass — case preservation and traps", () => {
  test("the three cases", () => {
    expect(rw("norma Norma NORMA").out).toBe("winter Winter WINTER");
  });
  test("identifiers and possessives", () => {
    expect(rw("NormaKit normaHome resolveNormaHome Norma's NormaClient dotNorma").out)
      .toBe("WinterKit winterHome resolveWinterHome Winter's WinterClient dotWinter");
  });
  test("normal*/abnormal/normative are never brand tokens", () => {
    const s = "normal normally normalized normalize normalization normalisation abnormal normative Normal NORMAL Normative whatwgNormalize";
    const r = rw(s);
    expect(r.out).toBe(s);
    expect(r.generic).toBe(0);
    expect(r.residue).toHaveLength(0);
  });
  test("a trap next to a real token", () => {
    expect(rw("normalizeTypedInput(norma)").out).toBe("normalizeTypedInput(winter)");
  });
  test("mcp names, env names, dotted ids, paths", () => {
    expect(rw("mcp__norma__lsp__lsp NORMA_HOME com.norma.core ~/.norma-dev .norma/rules norma-core /usr/local/bin/norma").out)
      .toBe("mcp__winter__lsp__lsp WINTER_HOME com.winter.core ~/.winter-dev .winter/rules winter-core /usr/local/bin/winter");
  });
});

describe("explicit map (P9b-8) — host/runtime vocabulary and SDK collisions", () => {
  test("every entry renames as a whole token", () => {
    for (const [from, to] of EXPLICIT_TOKEN_MAP) {
      const r = rw(`x ${from} y`);
      expect(r.out).toBe(`x ${to} y`);
      expect(r.doubleWinter).toHaveLength(0);
    }
  });
  test("NORMA_WINTER_EXECUTABLE never becomes WINTER_WINTER_EXECUTABLE", () => {
    const r = rw('process.env.NORMA_WINTER_EXECUTABLE ?? env["NORMA_WINTER_REQUIRE_BINARY"]');
    expect(r.out).toBe('process.env.WINTER_RUNTIME_EXECUTABLE ?? env["WINTER_RUNTIME_REQUIRE_BINARY"]');
    expect(r.doubleWinter).toHaveLength(0);
  });
  test("NORMA_BRAND becomes CORE_BRAND, not the SDK's WINTER_BRAND; the SDK's own stays", () => {
    expect(rw("import { WINTER_BRAND } from sdk; export const NORMA_BRAND = buildNormaBrand();").out)
      .toBe("import { WINTER_BRAND } from sdk; export const CORE_BRAND = buildCoreBrand();");
  });
  test("the two string values, and the hyphen-suffixed test dirs", () => {
    expect(rw('processLabel: "norma-winter", id: "com.norma.winter"').out).toBe('processLabel: "winter", id: "com.winter.runtime"');
    expect(rw('mkdtempSync(join(tmpdir(), "norma-winter-chat-e2e-"))').out).toBe('mkdtempSync(join(tmpdir(), "winter-chat-e2e-"))');
  });
  test("a longer identifier containing a key is not split", () => {
    expect(rw("normaToolNameForX normaIdentity").out).toBe("winterToolNameForX winterIdentity");
  });
  test("host/runtime pairs in one line stay distinct", () => {
    expect(rw("const normaId = winterToNormaRoutineId.get(winterId)").out).toBe("const hostId = runtimeToHostRoutineId.get(winterId)");
  });
});

describe("protection (P9b-5) — external infrastructure survives", () => {
  test("GitHub URLs, release assets, the raw feed — protected ONLY inside the frozen legacy feed since 9c (P9c-6)", () => {
    const s = 'url: "https://github.com/yanlingLabs/norma/releases/download/v1/Norma-1.zip" GH_REPO = "yanlingLabs/norma" raw.githubusercontent.com/yanlingLabs/norma/main/releases/appcast.xml';
    // Phase 9c renamed the GitHub repo to `yanlingLabs/winter`; in any ordinary file the old path
    // is now residue the codemod RENAMES (GitHub redirects it, but nothing live may spell it).
    const live = rw(s);
    expect(live.out).toBe('url: "https://github.com/yanlingLabs/winter/releases/download/v1/Winter-1.zip" GH_REPO = "yanlingLabs/winter" raw.githubusercontent.com/yanlingLabs/winter/main/releases/appcast.xml');
    expect(live.residue.filter((x) => x.permittedBy === "gh-repo")).toHaveLength(0);
    // The byte-frozen legacy feed keeps its historical enclosure URLs verbatim.
    const r = rw(s, "releases/appcast.xml");
    expect(r.out).toBe(s);
    expect(r.residue.every((x) => x.permittedBy === "gh-repo" || x.permittedBy === "frozen-norma-feed")).toBe(true);
    expect(r.residue.length).toBeGreaterThanOrEqual(3);
  });
  test("the iOS repo name after a slash survives; the iOS bundle id renames", () => {
    const r = rw("../norma-ios yanlingLabs/norma-ios com.yanlinglabs.norma-ios");
    expect(r.out).toBe("../norma-ios yanlingLabs/norma-ios com.yanlinglabs.winter-ios");
    expect(r.residue.map((x) => x.permittedBy)).toEqual(["ios-repo", "ios-repo"]);
  });
  test("infra credentials, the notary profile, the guard dir, the checkout dir", () => {
    const r = rw("com.norma.infra com.norma.cf norma-notary ~/norma-private/git-hooks 'Norma v2' ~/.ssh/norma-relay", "infra/relay/README.md");
    expect(r.out).toBe("com.norma.infra com.norma.cf norma-notary ~/norma-private/git-hooks 'Norma v2' ~/.ssh/norma-relay");
    expect(r.residue.every((x) => x.permittedBy !== "UNPERMITTED")).toBe(true);
  });
  test("crypto domain tags and the relay-config signing key service survive everywhere (P9b-28)", () => {
    const r = rw('domain: "norma-relay-config/1" proof: "norma-pair-proof/1" sas: "norma-pair-sas/1" service: "com.norma.config-key"', "apple/WinterProtocol/Sources/WinterProtocol/Pairing.swift");
    expect(r.out).toBe('domain: "norma-relay-config/1" proof: "norma-pair-proof/1" sas: "norma-pair-sas/1" service: "com.norma.config-key"');
    expect(r.residue.map((x) => x.permittedBy)).toEqual(["crypto-domain-tags", "crypto-domain-tags", "crypto-domain-tags", "config-key-keychain"]);
    expect(rw("norma-relay-config-thing").out).toBe("winter-relay-config-thing"); // no version suffix → not a tag
  });
  test("norma-relay is only protected under infra/", () => {
    expect(rw("norma-relay", "packages/core/src/x.ts").out).toBe("winter-relay");
  });
  test("an unprotected survivor is reported UNPERMITTED only when it cannot be rewritten (exempt path)", () => {
    const r = rewriteText("Norma 0.2.002 <enclosure url=…/norma/…>", "releases/appcast.xml");
    expect(r.changed).toBe(false);
    expect(r.residue.every((x) => x.permittedBy === "frozen-norma-feed")).toBe(true);
  });
  test("the rename tooling is exempt and permitted", () => {
    expect(isExemptPath("scripts/rename/codemod.ts")).toBe(true);
    expect(rewriteText("norma", "scripts/rename/allowlist.ts").residue[0]?.permittedBy).toBe("rename-tooling");
  });
  test("the legacy-names files are permitted by path", () => {
    expect(rewriteText('export const LEGACY_LAUNCHD_LABEL = "com.norma.core";', "packages/core/src/legacy-names.ts").residue[0]?.permittedBy).toBe("legacy-names");
    expect(rewriteText('static let launchdAgentLabel = "com.norma.core"', "apple/Winter/Sources/App/LegacyNames.swift").residue[0]?.permittedBy).toBe("legacy-names");
  });
});

describe("gates", () => {
  test("double-winter is reported", () => {
    const r = rw("winter-winter WinterWinter WINTER_WINTER winterWinterX");
    expect(r.doubleWinter.map((d) => d.match)).toEqual(["winter-winter", "WinterWinter", "WINTER_WINTER", "winterWinter"]);
  });
  test("idempotent: a second pass over the output changes nothing", () => {
    const first = rw("Norma norma NORMA NORMA_WINTER_EXECUTABLE github.com/yanlingLabs/norma normal");
    const second = rw(first.out);
    expect(second.changed).toBe(false);
    expect(second.out).toBe(first.out);
  });
});

describe("paths", () => {
  test("components rename case-preservingly; traps stay", () => {
    expect(renamePath("apple/NormaKit/Sources/NormaSessionKit/X.swift")).toBe("apple/WinterKit/Sources/WinterSessionKit/X.swift");
    expect(renamePath("examples/battery-limiter/norma-plugin.json")).toBe("examples/battery-limiter/winter-plugin.json");
    expect(renamePath("packages/core/src/normalize.ts")).toBe("packages/core/src/normalize.ts");
    expect(renamePath("packaging/norma.rb.tmpl")).toBe("packaging/winter.rb.tmpl");
  });
  test("planMoves: directories shallowest-first, re-derived after each move, then files", () => {
    const moves = planMoves([
      "apple/NormaKit/Sources/NormaSessionKit/A.swift",
      "apple/NormaKit/Package.swift",
      "apple/Norma/Support/Norma.entitlements",
      "packages/core/src/norma-dir.ts",
      "packages/core/src/normalize.ts",
    ]);
    expect(moves).toEqual([
      { from: "apple/Norma", to: "apple/Winter", kind: "dir" },
      { from: "apple/NormaKit", to: "apple/WinterKit", kind: "dir" },
      { from: "apple/WinterKit/Sources/NormaSessionKit", to: "apple/WinterKit/Sources/WinterSessionKit", kind: "dir" },
      { from: "apple/Winter/Support/Norma.entitlements", to: "apple/Winter/Support/Winter.entitlements", kind: "file" },
      { from: "packages/core/src/norma-dir.ts", to: "packages/core/src/winter-dir.ts", kind: "file" },
    ]);
  });
});

describe("scaffold refusal (P9b-2)", () => {
  test("a tracked top-level norma/ is detected; apple/Norma is not it", () => {
    expect(scaffoldPresent(["norma/norma/normaApp.swift", "apple/Norma/x"])).toBe(true);
    expect(scaffoldPresent(["apple/Norma/x", "norma-vs-cc-tools.md"])).toBe(false);
  });
});

describe("allowlist hygiene", () => {
  test("globs", () => {
    expect(globToRegex("infra/**").test("infra/relay/README.md")).toBe(true);
    expect(globToRegex("infra/**").test("packages/x")).toBe(false);
    expect(entryAppliesTo(RENAME_ALLOWLIST.find((e) => e.id === "infra-ssh-key")!, "infra/relay/oci.ts")).toBe(true);
  });
  test("ids unique", () => {
    const ids = RENAME_ALLOWLIST.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
