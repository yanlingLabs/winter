import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEV_DAEMON_IDENTIFIER, devCompileCommand, devDaemonHome, resolveDevSigningIdentity, signedFacts } from "./dev-daemon-lib";

const TEAM = "37N77U9RSZ";
const IDENTITIES = `  1) ${"A".repeat(40)} "Apple Development: someone@example.invalid (AAAAAAAAAA)"
  2) ${"B".repeat(40)} "Developer ID Application: Example Org (${TEAM})"
  3) ${"C".repeat(40)} "Apple Development: A Person (BBBBBBBBBB)"
     3 valid identities found
`;
const SUBJECTS: Record<string, string> = {
  "Apple Development: someone@example.invalid (AAAAAAAAAA)": "subject=UID=X, CN=Apple Development: someone@example.invalid (AAAAAAAAAA), OU=OTHERTEAM1, O=Someone, C=US",
  [`Developer ID Application: Example Org (${TEAM})`]: `subject=UID=${TEAM}, CN=Developer ID Application: Example Org (${TEAM}), OU=${TEAM}, O=Example Org, C=US`,
  "Apple Development: A Person (BBBBBBBBBB)": `subject=UID=Y, CN=Apple Development: A Person (BBBBBBBBBB), OU=${TEAM}, O=Example Org, C=US`,
};

describe("the dev daemon's signing identity", () => {
  test("the team is the certificate's OU, not the name's parenthetical; Apple Development preferred; by hash", () => {
    expect(resolveDevSigningIdentity({ identitiesOutput: IDENTITIES, teamId: TEAM, subjectOf: (n) => SUBJECTS[n] })).toEqual({ hash: "C".repeat(40), name: "Apple Development: A Person (BBBBBBBBBB)" });
    const noDev = IDENTITIES.split("\n").filter((l) => !l.includes("A Person")).join("\n");
    expect(resolveDevSigningIdentity({ identitiesOutput: noDev, teamId: TEAM, subjectOf: (n) => SUBJECTS[n] }).hash).toBe("B".repeat(40));
  });

  test("none for the team is a clear error; the override wins without a lookup", () => {
    expect(() => resolveDevSigningIdentity({ identitiesOutput: IDENTITIES, teamId: "NOSUCHTEAM", subjectOf: (n) => SUBJECTS[n] })).toThrow("no code-signing identity for team NOSUCHTEAM");
    expect(resolveDevSigningIdentity({ identitiesOutput: "", teamId: TEAM, subjectOf: () => undefined, override: " D1 " })).toEqual({ hash: "D1", name: "(WINTER_DEV_SIGN_IDENTITY)" });
  });
});

describe("the dev daemon's build and home", () => {
  test("the build is compile:core itself with only the output moved (the pairing cannot drift)", () => {
    const script = (JSON.parse(readFileSync(join(import.meta.dir, "..", "packages", "cli", "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts["compile:core"]!;
    const dev = devCompileCommand(script, "/x/dist/dev/winter-core.1.tmp");
    expect(dev).toBe(script.replace("--outfile ../../dist/winter-core", '--outfile "/x/dist/dev/winter-core.1.tmp"'));
    expect(dev).toContain("src/embedded-worker.ts");
    expect(() => devCompileCommand("bun build --compile src/main.ts --outfile elsewhere", "/x")).toThrow("update scripts/dev-daemon-lib.ts");
  });

  test("home: WINTER_HOME or ~/.winter-dev, never the dist home", () => {
    expect(devDaemonHome({}, "/Users/u")).toBe("/Users/u/.winter-dev");
    expect(devDaemonHome({ WINTER_HOME: "/tmp/h" }, "/Users/u")).toBe("/tmp/h");
    expect(() => devDaemonHome({ WINTER_HOME: "/Users/u/.winter/" }, "/Users/u")).toThrow("dist home");
  });

  test("the signature facts the build insists on", () => {
    const dv = `Executable=/x\nIdentifier=${DEV_DAEMON_IDENTIFIER}\nFormat=Mach-O thin (arm64)\nCodeDirectory v=20500 size=1 flags=0x10000(runtime) hashes=1+7 location=embedded\nTeamIdentifier=${TEAM}\n`;
    expect(signedFacts(dv)).toEqual({ identifier: DEV_DAEMON_IDENTIFIER, teamId: TEAM, runtime: true });
    expect(signedFacts("Identifier=bun\nCodeDirectory v=1 size=1 flags=0x2(adhoc) hashes=1\nTeamIdentifier=not set\n")).toEqual({ identifier: "bun", runtime: false });
  });
});
