// WS-21 fix round 2 (C1, Opus review of lane L5's Mac plugin screen -- two Critical consent holes
// on the daemon side): consent must be bound to WHAT WAS DISCLOSED, not just to a plugin's
// qualified spec name. Before this fix, `plugins.consents[spec]` survived a change of what the spec
// pointed at:
//   - `plugin.uninstall` never called `removePluginFromSettings` (consent outlives the uninstall);
//   - `addMarketplace` re-points an EXISTING marketplace name at a NEW folder (`sdk-plugin-api.ts`'s
//     Contract-B adapter, mirroring `manage.ts:424`'s own re-point behavior);
//   - `installPlugin` overwrites the user-scope install path for a spec that's already installed
//     (mirroring `manage.ts:499`).
// Scenario the ruling names: the user installs `helper` from folder A and consents to `node a.js`,
// then installs from folder B -- whose marketplace happens to share the same name -- whose entry is
// `sh payload.sh`. Pre-fix, the row still shows "already consented" and B's command starts without
// the user ever having seen it.
//
// The fix: `plugins.consents[spec]` becomes `{classes: string[], fingerprint: string}`, and a class
// only reads back as consented when the STORED fingerprint matches a FRESH one computed off the
// plugin's CURRENT install path + entry. A record that isn't exactly this new shape -- the pre-fix
// `{exec?,tcc?,hardware?}` per-class-timestamp object, a bare array, anything hand-edited -- reads
// as NOT consented: no record written before this fix could ever carry a valid fingerprint, so this
// is a deliberate, free migration -- every pre-existing consent is treated as withdrawn and the user
// is asked once, fresh.
//
// Used from THREE call sites, all producing/consuming the SAME shape: `agent/plugins.ts#PluginStore`
// (the boot-time / `livePlugins()` read, which gates `pluginSpawnEligible`), `ipc/server.ts`'s
// `plugin.list` (`extras.consented`) and `plugin.setConsent` (writes a fresh, correctly-fingerprinted
// record), and `plugins/convert-legacy.ts#rekeyConsents` (writes a fingerprinted record for each
// migrated plugin, at conversion time, when it already knows the plugin's converted install path).
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";

/** Exactly the fields `plugin.list`'s own `extras.entry` discloses (`ipc/server.ts#pluginExtrasFor`)
 *  -- `cwd`, though `winter-plugin.json` may declare it, is never part of that disclosure and so
 *  never part of the fingerprint either. */
export interface PluginFingerprintEntry {
  command: string;
  args?: string[];
}

/** The new, fingerprinted consent record shape -- `plugins.consents[spec]`. */
export interface PluginConsentRecordV2 {
  classes: string[];
  fingerprint: string;
}

const KNOWN_CONSENT_CLASSES = ["exec", "tcc", "hardware"] as const;
type KnownConsentClass = (typeof KNOWN_CONSENT_CLASSES)[number];

/**
 * sha256 over the plugin's REAL (symlink-resolved) install path plus its entry command/args -- what
 * the user actually saw disclosed when they granted consent. Falls back to the given path unresolved
 * if `realpath` fails (a moved/deleted directory mid-check); the hash still changes deterministically
 * for a genuinely different path either way, which is all invalidation needs.
 */
export function pluginConsentFingerprint(installPath: string, entry: PluginFingerprintEntry | undefined): string {
  let real = installPath;
  try {
    real = realpathSync(installPath);
  } catch {
    /* keep the given path -- a moved/deleted directory mid-check still hashes deterministically */
  }
  const payload = JSON.stringify({
    installPath: real,
    entry: entry ? { command: entry.command, args: entry.args ?? [] } : null,
  });
  return createHash("sha256").update(payload).digest("hex");
}

/**
 * `true` only for the NEW shape, `{classes: string[], fingerprint: string}` -- a legacy bare array
 * (`["exec","tcc"]`), the pre-fix per-class-timestamp object (`{exec: 173...,tcc: 173...}`), or
 * anything else hand-edited reads as `false`. See this module's header for why that is deliberate.
 */
export function isPluginConsentRecordV2(v: unknown): v is PluginConsentRecordV2 {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  return Array.isArray(r.classes) && r.classes.every((c) => typeof c === "string") && typeof r.fingerprint === "string";
}

/**
 * The consent classes actually granted for a stored `record`, gated on `record.fingerprint` matching
 * `currentFingerprint` exactly -- a stale, shape-invalid or fingerprint-mismatched record reads as
 * zero classes consented. Filters to the known consent classes defensively, in case a hand-edited
 * record's `classes` array carries an unrecognized string.
 */
export function consentedClassesFor(record: unknown, currentFingerprint: string): KnownConsentClass[] {
  if (!isPluginConsentRecordV2(record) || record.fingerprint !== currentFingerprint) return [];
  return record.classes.filter((c): c is KnownConsentClass => (KNOWN_CONSENT_CLASSES as readonly string[]).includes(c));
}
