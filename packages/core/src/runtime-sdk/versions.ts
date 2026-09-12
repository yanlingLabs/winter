import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { SDK_VERSION } from "@yanlinglabs/winter-agent-sdk";

/** The exact peer versions this daemon was written against (P8b-3). The ^ ranges in package.json
 *  are what INSTALLS; these are what the tests PROVE installed. Bump together with the pins. */
export const REQUIRED_WINTER_AGENT_SDK = "0.0.5";
export const REQUIRED_WINTER_RUNTIME_SDK = "0.0.3";
/** P8c-3/versions: the official peer is pinned EXACT (`"0.3.250"` in package.json, no `^`) — the
 *  ladder's package door and the router's own `assertVersionMatrix` both key off this string
 *  matching the installed wrapper's manifest, never a range. */
export const REQUIRED_CLAUDE_AGENT_SDK = "0.3.250";

/**
 * The installed `@anthropic-ai/claude-agent-sdk`'s own declared version, or `undefined` when the
 * optional peer is not installed at all (Winter-only host — never a throw).
 *
 * `createRequire` resolves against a REAL `node_modules`, which is exactly the doorway
 * `official-executable.ts`'s package door already depends on and exactly what does NOT exist inside
 * a compiled `$bunfs` binary (P8b-4's own reasoning) — so this answers `undefined` there too, and
 * `create.ts`'s own installed===REQUIRED check (Task 1.1) is what refuses the OFFICIAL leg on a
 * mismatch, never the daemon as a whole.
 */
export function installedClaudeAgentSdkVersion(): string | undefined {
  try {
    const pkgJsonPath = createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk/package.json");
    return (JSON.parse(readFileSync(pkgJsonPath, "utf8")) as { version: string }).version;
  } catch {
    return undefined;
  }
}

/** Host-declared peer versions (router 0.0.2 consults these FIRST — the only answer that works
 *  inside a compiled $bunfs binary, where createRequire cannot resolve a manifest). P8b-4.
 *  `claudeAgentSdk` is OMITTED (never `undefined`-valued) when the optional peer is not installed —
 *  a Winter-only host must not carry a stray key the router's version matrix would try to satisfy. */
export const NORMA_PEER_VERSIONS: { winterAgentSdk: string; claudeAgentSdk?: string } = {
  winterAgentSdk: SDK_VERSION,
  ...(installedClaudeAgentSdkVersion() === undefined ? {} : { claudeAgentSdk: installedClaudeAgentSdkVersion()! }),
};
