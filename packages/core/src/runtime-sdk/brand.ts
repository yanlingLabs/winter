// R-1 / P9b-7: THE DAEMON'S BRAND IS THE SDK'S OWN `WINTER_BRAND`, PLUS THREE FIELDS.
//
// Pre-rename this file constructed all fourteen `BrandProfile` fields by hand, because the daemon
// (under its OWN old brand) and the runtime SDK (branded "Winter") were two different products with
// two different identities that happened to share code — the daemon's own `homeDirName` differed
// from the SDK's own `.winter`, its own `mcpServerName` differed from the SDK's own `"winter"`, and
// so on down every field. The rename collapses that distinction: the daemon IS the product now, and the
// product IS Winter, so re-deriving fourteen fields by hand would just be retyping the SDK's own
// defaults with a chance to drift from them. `buildCoreBrand` therefore starts from `WINTER_BRAND`
// itself and overrides only the three fields where the daemon's identity is genuinely its own:
//
//  - `packageName: "winter-core"` — this package's own name, distinct from the SDK's
//    `"winter-agent-sdk"`. It is the honest identity in `User-Agent`/vendor-identity headers
//    (`BrandProfile.packageName`'s own doc); the daemon is not the SDK, so it may not borrow the
//    SDK's name here even though every other field is now shared.
//  - `keychainService: keychainService(profile)` — profile-aware (`com.winter.core[.dev]`), because
//    the SDK's own default has no notion of a dev/dist split; `auth/secret-store.ts`'s `SERVICE`
//    resolves the same way, from the same `WINTER_PROFILE`, so the daemon's secret store and its own
//    brand never disagree about which Keychain service a session's credentials live under.
//  - `contactUrl: "https://github.com/yanlingLabs/norma"` — a protected literal (Global Constraints
//    P9b-5): the SDK's own `contactUrl` points at ITS repo (`winter-agent-sdk`), which is not where
//    a report about THIS daemon's behaviour belongs. Flips only if the user's own repo is ever
//    renamed, never as a mechanical consequence of a brand change.
//
// DELIBERATE CONSEQUENCES of taking the rest of `WINTER_BRAND` as-is, accepted rather than
// overridden (P9b-7):
//
//  - `mcpServerName: "winter"` → every daemon-owned capability tool is
//    `mcp__winter__<key>__<tool>` (P8b-12); `capabilities/names.ts`'s own header covers why a
//    composed server name can never collide with this bare value.
//  - `presetName: "winter_code"` → the independently-authored system-prompt preset the Winter leg
//    selects (WS-11); see `mode-options.ts`'s own consumer.
//  - `processLabel: "winter"` → what `ps`/Activity Monitor shows for a spawned Winter child's
//    runtime process — distinct from `packageName` (`"winter-core"`) on purpose: it is how a user
//    tells a Winter-spawned runtime child apart from the daemon itself.
//  - `tempRootName: "winter"` → `/private/tmp/winter-<uid>/winter-<uid>/<projectKey>/<uuid>/…`
//    (WS-01 §2.3 exactly).
//  - `homeDirName: ".winter"` + `envPrefix: "WINTER_"` → THE HOME ALIGNMENT IS THE POINT:
//    `resolveWinterHome()` (the SDK's, given `CORE_BRAND`) returns exactly what core's OWN
//    `resolveWinterHome()` (`../winter-dir.ts`) returns — `WINTER_HOME` when set, `~/.winter-dev`
//    under `WINTER_PROFILE=dev`, `~/.winter` otherwise. The daemon's home and Winter's home are the
//    SAME directory, with no extra wiring and no second variable to keep in sync — pinned in
//    `test/runtime-sdk/brand.test.ts` by asserting the SDK's resolver and core's own agree.
import { WINTER_BRAND, type BrandProfile } from "@yanlinglabs/winter-agent-sdk";
import { keychainService } from "../profile";
import type { WinterProfile } from "../profile";

/**
 * Build the brand. `profile` is threaded only so a test can assert both halves of the dev/dist
 * split without mutating `process.env` — production always takes the default, which resolves
 * `WINTER_PROFILE` exactly as `auth/secret-store.ts` does.
 */
export function buildCoreBrand(profile?: WinterProfile): BrandProfile {
  return {
    ...WINTER_BRAND,
    packageName: "winter-core",
    keychainService: keychainService(profile),
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
