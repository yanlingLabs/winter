// R-1: Winter's own `BrandProfile` — the single object that makes every Winter-owned name in a
// spawned session say "winter" instead of "winter".
//
// WHAT A BRAND ACTUALLY DECIDES (surface map §6.5/§6.6), and why this file is load-bearing rather
// than cosmetic: the SDK derives the session HOME (`<envPrefix>HOME` → `WINTER_HOME`, `<envPrefix>
// PROFILE=dev` → `~/.winter-dev`), the transcript/memory roots under it, the temp root
// (`/private/tmp/<tempRootName>-<uid>/…`), the Keychain service a child reads credentials from, the
// MCP tool namespace (`mcp__<mcpServerName>__…`) and the provider originator — ALL from these
// fourteen strings. A daemon that passed no brand would have Winter-branded children writing
// transcripts into `~/.winter` and reading a `com.winter.*` Keychain service.
//
// THE HOME ALIGNMENT IS THE POINT. `envPrefix: "WINTER_"` + `homeDirName: ".winter"` means
// `resolveWinterHome()` under this brand returns exactly what `resolveWinterHome()` returns —
// `WINTER_HOME` when set, `~/.winter-dev` under `WINTER_PROFILE=dev`, `~/.winter` otherwise. The
// daemon's home and Winter's home are the SAME directory, with no extra wiring and no second
// variable to keep in sync.
import type { BrandProfile } from "@yanlinglabs/winter-agent-sdk";
import { keychainService } from "../profile";
import type { WinterProfile } from "../profile";

/**
 * Build the profile. `profile` is threaded only so a test can assert both halves of the dev/dist
 * split without mutating `process.env` — production always takes the default, which resolves
 * `WINTER_PROFILE` exactly as `auth/secret-store.ts` does.
 */
export function buildCoreBrand(profile?: WinterProfile): BrandProfile {
  return {
    productName: "Winter",
    // BRAND_TOKEN_RE `/^[a-z][a-z0-9-]{0,31}$/` — the daemon package's own name.
    packageName: "winter-core",
    // DOT_DIR_RE `/^\.[a-z][a-z0-9-]{0,31}$/`. `homeDirName` is what `~/<it>` means when no
    // `WINTER_HOME` is set; `projectDirName` is the per-repo config dir (Winter's `.winter/` — the
    // CC-project-folder parity work's own directory).
    homeDirName: ".winter",
    projectDirName: ".winter",
    // INSTRUCTIONS_FILE_RE `/^[A-Z][A-Z0-9_]{0,31}\.md$/`; Winter's answer to CLAUDE.md.
    instructionsFile: "WINTER.md",
    // ENV_PREFIX_RE `/^[A-Z][A-Z0-9]{0,15}_$/` — THE TRAILING UNDERSCORE IS PART OF THE VALUE
    // (`envName(brand, "HOME")` is a bare concatenation). `"WINTER"` would refuse at `resolveBrand`
    // and, if it somehow got through, would have children reading `WINTERHOME`. The Interfaces
    // block in the task briefs spells this without the underscore; that is a typo (report F-2).
    envPrefix: "WINTER_",
    // PROFILE-AWARE, and resolved the same way `auth/secret-store.ts`'s `SERVICE` is: at module
    // load, from `WINTER_PROFILE`. `com.winter.core.dev` under the dev profile, `com.winter.core`
    // otherwise — so a dev child can never read the dist install's credentials. (The SDK would
    // apply the same `.dev` suffix itself via `resolveKeychainServiceForProfile`, but only for a
    // brand that did NOT set the field; an explicitly-set service is never rewritten, which is why
    // this must already be the profile-correct value rather than the bare literal.)
    keychainService: keychainService(profile),
    // The MCP namespace every capability tool is named under: `mcp__winter__<server>__<tool>`
    // (P8b-12). NEVER `winter` — the Mac/iOS renderers key on Winter's names.
    mcpServerName: "winter",
    // Only emptiness is refused here (Winter's own value contains an underscore, so no grammar
    // rule applies).
    presetName: "winter",
    // The spawned child's process title — what `ps` shows for a Winter session's runtime. Distinct
    // from `packageName` on purpose: it is how a user tells a Winter-spawned runtime child apart
    // from `winter-core` itself in Activity Monitor.
    processLabel: "winter",
    // DELIBERATE ToS DECISION, mirrored from `providers/codex-config.ts`'s standing rule (CLAUDE.md
    // "Hard rules"): Winter self-identifies as itself. `resolveBrand` additionally REFUSES the six
    // FIRST_PARTY_ORIGINATORS (`codex`, `codex_cli_rs`, `openai`, `anthropic`, `claude`,
    // `claude-code`), so this can never be reverted to a first-party value by accident.
    codexOriginator: "winter",
    // `/private/tmp/winter-<uid>/winter-<uid>/<projectKey>/<uuid>/{scratchpad,tasks}`.
    tempRootName: "winter",
    pluginManifestDir: ".winter-plugin",
    // `resolveBrand` parses this with `new URL` and requires `https:` (and no control bytes).
    contactUrl: "https://github.com/yanlingLabs/norma",
  };
}

/**
 * THE brand. One frozen object for the daemon's lifetime.
 *
 * Module-load resolution of `keychainService()` follows `auth/secret-store.ts`'s precedent exactly,
 * including its caveat: `WINTER_PROFILE` must be set in the environment BEFORE this module is first
 * imported (mutating it afterwards is inert). Every production entry point — the launchd plist, the
 * app's own spawn — sets it in the environment it starts the process with.
 */
export const CORE_BRAND: BrandProfile = Object.freeze(buildCoreBrand());
