// WS-27: the pure halves of `scripts/dev-daemon.ts` (unit-tested in `dev-daemon.test.ts`).
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** The dev daemon's code-signing identifier: stable, so its designated requirement (identifier + Winter's
 *  team certificate) survives every rebuild and the Keychain keeps trusting it. Distinct from the dist
 *  binary's (`winter-core`), which is signed in the app bundle. */
export const DEV_DAEMON_IDENTIFIER = "com.winter.core.dev";

/**
 * The dev daemon's designated requirement, stated rather than derived: its identifier and Winter's team
 * (the certificate's OU), under Apple's anchor. The derived one would name the signing certificate's common
 * name, which changes with the person or the certificate type; this one holds for any Winter-team
 * certificate, so the Keychain keeps trusting every rebuild whoever signs it.
 */
export function devDaemonRequirement(teamId: string): string {
  return `identifier "${DEV_DAEMON_IDENTIFIER}" and anchor apple generic and certificate leaf[subject.OU] = "${teamId}"`;
}

/** `compile:core`'s own output, which the `verify:*` gates overwrite — the dev daemon is never built there. */
const COMPILE_CORE_OUTFILE = "--outfile ../../dist/winter-core";

/**
 * `packages/cli/package.json`'s `compile:core` script with only its output path changed, so the dev daemon is
 * the same two-entrypoint build (`cli/test/compile-core.test.ts` pins its shape) and cannot drift from it.
 * Throws when the script no longer names the expected output (a change to update here, not to guess around).
 */
export function devCompileCommand(compileCoreScript: string, outfile: string): string {
  if (!compileCoreScript.includes(COMPILE_CORE_OUTFILE)) throw new Error(`compile:core no longer writes ${COMPILE_CORE_OUTFILE} — update scripts/dev-daemon-lib.ts`);
  return compileCoreScript.replace(COMPILE_CORE_OUTFILE, `--outfile ${JSON.stringify(outfile)}`);
}

export interface SigningIdentity {
  hash: string;
  name: string;
}

/**
 * The identity to sign the dev daemon with: one whose certificate's ORGANIZATIONAL UNIT is `teamId` (an
 * "Apple Development" certificate names the person in its common name, not the team, so the name alone
 * cannot say), preferring "Apple Development" (a development build) over "Developer ID Application".
 * Returned by its SHA-1 hash, never a name, so two same-named certificates cannot make `codesign` guess.
 * `subjectOf(name)` answers a certificate's subject line (`security find-certificate -c <name> -p |
 * openssl x509 -noout -subject`); injected so this stays pure. `override` (`$WINTER_DEV_SIGN_IDENTITY`) wins.
 */
export function resolveDevSigningIdentity(input: { identitiesOutput: string; teamId: string; subjectOf: (name: string) => string | undefined; override?: string }): SigningIdentity {
  if (input.override !== undefined && input.override.trim() !== "") return { hash: input.override.trim(), name: "(WINTER_DEV_SIGN_IDENTITY)" };
  const candidates: SigningIdentity[] = [];
  for (const line of input.identitiesOutput.split("\n")) {
    const m = /\b([0-9A-Fa-f]{40})\s+"([^"]+)"/.exec(line);
    if (m === null) continue;
    const [, hash, name] = m as unknown as [string, string, string];
    const subject = input.subjectOf(name) ?? "";
    if (new RegExp(`(^|[,/\\s])OU\\s*=\\s*${input.teamId}([,/\\s]|$)`).test(subject)) candidates.push({ hash, name });
  }
  const rank = (name: string): number => (name.startsWith("Apple Development:") ? 0 : name.startsWith("Developer ID Application:") ? 1 : 2);
  candidates.sort((a, b) => rank(a.name) - rank(b.name));
  const chosen = candidates[0];
  if (chosen === undefined) throw new Error(`no code-signing identity for team ${input.teamId} in this keychain (security find-identity -v -p codesigning) — create one in Xcode, or set WINTER_DEV_SIGN_IDENTITY`);
  return chosen;
}

/** The dev daemon's home: `$WINTER_HOME`, else `~/.winter-dev`. Never the dist home. */
export function devDaemonHome(env: NodeJS.ProcessEnv, home: string = homedir()): string {
  const chosen = resolve(env.WINTER_HOME ?? join(home, ".winter-dev"));
  if (chosen === resolve(join(home, ".winter"))) throw new Error(`refusing to run a dev daemon on ${chosen} — that is the dist home (the daily driver)`);
  return chosen;
}

/** `codesign -dv` facts the build checks after signing. */
export function designatedRequirementOf(codesignDr: string): string | undefined {
  return /^designated => (.+)$/m.exec(codesignDr)?.[1]?.trim();
}

export function signedFacts(codesignDv: string): { identifier?: string; teamId?: string; runtime: boolean } {
  const identifier = /^Identifier=(.+)$/m.exec(codesignDv)?.[1]?.trim();
  const teamId = /^TeamIdentifier=(.+)$/m.exec(codesignDv)?.[1]?.trim();
  const flags = /^CodeDirectory .*flags=0x[0-9a-f]+\(([^)]*)\)/m.exec(codesignDv)?.[1] ?? "";
  return { ...(identifier !== undefined ? { identifier } : {}), ...(teamId !== undefined && teamId !== "not set" ? { teamId } : {}), runtime: flags.split(",").includes("runtime") };
}
