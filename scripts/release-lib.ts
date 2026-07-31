/**
 * Pure, unit-tested parts of the release pipeline (scripts/release.ts). Nothing in this file
 * shells out, touches the filesystem, or reads process.argv — every real-world check (identity
 * lookup, notary profile probe, gh auth, git tree/tag state) lives in release.ts and is wired
 * into `preflight()` as a closure; this module only aggregates results and renders text.
 */

export interface Preflight {
  ok: boolean;
  failures: string[];
}

/**
 * Runs every named check and aggregates ALL failures at once (never short-circuits on the
 * first one) so a release attempt can be told everything wrong in a single pass. Each check
 * returns `null` on pass or the exact user-facing failure line on fail.
 */
export function preflight(opts: { checks: Record<string, () => string | null> }): Preflight {
  const failures: string[] = [];
  for (const check of Object.values(opts.checks)) {
    const line = check();
    if (line !== null) failures.push(line);
  }
  return { ok: failures.length === 0, failures };
}

// Distribution backbone (design spec 2026-07-15-release-pipeline-design.md) — GitHub Releases
// is the sole download host; matches the `origin` remote and project.yml's SUFeedURL. Exported
// so release.ts's publish tail (gh release URL, cask url) shares this single source of truth.
export const GH_REPO = "yanlingLabs/norma";

/**
 * Renders one Sparkle appcast `<item>` for the update-check enclosure (the `.zip`). Schema
 * mirrors scripts/sparkle-feed-gate.ts's local test appcast: title/version/shortVersionString,
 * an optional `sparkle:channel` for beta, minimumSystemVersion, and the signed enclosure.
 */
export function appcastItem(i: {
  version: string;
  zipName: string;
  edSignature: string;
  length: number;
  beta: boolean;
  minSystem: string;
}): string {
  const url = `https://github.com/${GH_REPO}/releases/download/v${i.version}/${i.zipName}`;
  const channel = i.beta ? "\n      <sparkle:channel>beta</sparkle:channel>" : "";
  return `    <item>
      <title>${i.version}</title>
      <sparkle:version>${i.version}</sparkle:version>
      <sparkle:shortVersionString>${i.version}</sparkle:shortVersionString>${channel}
      <sparkle:minimumSystemVersion>${i.minSystem}</sparkle:minimumSystemVersion>
      <enclosure url="${url}" sparkle:edSignature="${i.edSignature}" length="${i.length}" type="application/octet-stream"/>
    </item>`;
}

/** Interpolates a brew cask template (T3's packaging/norma.rb.tmpl) — `{{version}}`/`{{sha256}}`/`{{url}}`. */
export function caskFrom(tmpl: string, i: { version: string; sha256: string; url: string }): string {
  return tmpl
    .replaceAll("{{version}}", i.version)
    .replaceAll("{{sha256}}", i.sha256)
    .replaceAll("{{url}}", i.url);
}

export interface DmgStageOp {
  kind: "copy" | "symlink";
  /** copy: absolute source path to copy from. symlink: the link TARGET it should point to. */
  source: string;
  /** Path, relative to the stage dir, where this entry lands. */
  destName: string;
}

/**
 * Plans the DMG staging directory layout: the (already notarized+stapled) app copied in,
 * plus the conventional `/Applications` symlink so a user can drag-install. Pure — returns an
 * operation list; release.ts performs the actual copy/symlink before handing the dir to
 * `hdiutil create -srcfolder`.
 */
export function dmgStagePlan(appPath: string): DmgStageOp[] {
  const appName = appPath.split("/").filter(Boolean).pop();
  if (!appName || !appName.endsWith(".app")) {
    throw new Error(`dmgStagePlan: expected a path ending in .app, got "${appPath}"`);
  }
  return [
    { kind: "copy", source: appPath, destName: appName },
    { kind: "symlink", source: "/Applications", destName: "Applications" },
  ];
}

export interface AppcastInsertPlanInputs {
  dryRun: boolean;
  version: string;
  /** Current contents of the appcast this run would insert into (read by release.ts from
   * whichever file `target` below resolves to — always `releases/appcast.xml` on disk, since
   * that's the only copy that exists; the preview file is only ever an OUTPUT). */
  appcastXml: string;
  /** The rendered `<item>` block (release-lib's `appcastItem()`) to insert for this version. */
  item: string;
}

export interface AppcastInsertPlanResult {
  /** Where release.ts should write `updatedXml` when `action` is "insert": "preview" ->
   * out/release/<v>/appcast-preview.xml ONLY (dry-run — F1 fix: never the tracked file);
   * "repo" -> releases/appcast.xml (real run — release.ts must do this write from inside its
   * `!DRY_RUN` publish tail, not before). */
  target: "preview" | "repo";
  /** "insert": updatedXml is ready to write. "skip": an <item> for this exact
   * <sparkle:version> is already present — F2 fix, makes re-running (e.g. --resume-publish
   * after a partial failure) idempotent instead of appending a duplicate. */
  action: "insert" | "skip";
  updatedXml?: string;
}

/**
 * Decides where a release's appcast `<item>` should land and whether it needs inserting at
 * all — the pure half of release.ts §10's appcast step (the impure half — reading the real
 * file, writing it, git add/commit/push — stays in release.ts). `--dry-run` always targets
 * "preview" (mirrors `publishGuard`'s dry-run-wins-first shape); a real run targets "repo". A
 * version already present in `appcastXml` (matched by an exact `<sparkle:version>` element) is
 * always "skip", in both modes, so a re-run never appends a duplicate `<item>`. Throws if an
 * insert is needed but `appcastXml` has no `</channel>` to insert before — same "can't find the
 * anchor" failure release.ts used to check for inline.
 */
export function appcastInsertPlan(i: AppcastInsertPlanInputs): AppcastInsertPlanResult {
  const target = i.dryRun ? "preview" : "repo";
  const alreadyPresent = i.appcastXml.includes(`<sparkle:version>${i.version}</sparkle:version>`);
  if (alreadyPresent) return { target, action: "skip" };
  if (!i.appcastXml.includes("</channel>")) {
    throw new Error("appcastXml is missing </channel> — cannot insert the item");
  }
  const updatedXml = i.appcastXml.replace("</channel>", `${i.item}\n  </channel>`);
  return { target, action: "insert", updatedXml };
}

export interface ResolveSigningIdentityInputs {
  /** release.ts's `NORMA_SIGN_IDENTITY` escape hatch — when set, returned as-is with no lookup
   * at all (so `identitiesOutput` doesn't even need to be real, letting a differently-provisioned
   * keychain, e.g. CI, skip `security find-identity` entirely). */
  envOverride?: string;
  /** Raw stdout of `security find-identity -v -p codesigning`. */
  identitiesOutput: string;
  teamId: string;
}

/**
 * Resolves the ONE codesigning identity every `--sign` call in release.ts should use, as a
 * 40-hex-char SHA-1 hash — never a display name — so no legal/company name needs to live in this
 * codebase, and the app resign, its nested/embedded binaries, and the DMG are always signed by
 * the exact same, unambiguous identity (never "whichever Developer ID Application cert happens to
 * match first," which could pick a different identity, e.g. a personal one alongside the org's,
 * if more than one is present in the keychain). Scans `identitiesOutput` line by line for one
 * naming BOTH "Developer ID Application" and `(<teamId>)`, and returns that line's hash. Throws a
 * clear, actionable error when no such line exists.
 */
export function resolveSigningIdentity(i: ResolveSigningIdentityInputs): string {
  if (i.envOverride) return i.envOverride;
  for (const line of i.identitiesOutput.split("\n")) {
    const m = line.match(/([0-9A-Fa-f]{40})\s+"([^"]+)"/);
    if (!m) continue;
    const [, hash, name] = m;
    if (name!.includes("Developer ID Application") && name!.includes(`(${i.teamId})`)) {
      return hash!;
    }
  }
  throw new Error(`no Developer ID Application identity for team ${i.teamId} — create it in Xcode`);
}

export interface PublishGuardInputs {
  dryRun: boolean;
  resumePublish: boolean;
  tagExists: boolean;
  releaseExists: boolean;
  version: string;
}

export interface PublishGuardResult {
  action: "dry-run-skip" | "abort" | "publish" | "resume";
  /** dry-run-skip: the skip-list (what would have run). abort: the exact failure line(s).
   * publish/resume: empty. */
  lines: string[];
}

/**
 * Decides what the publish tail should do, given the current tag/release state. `--dry-run`
 * always wins first (never reachable past it, regardless of other flags) and reports a
 * skip-list instead of aborting. Otherwise: an existing tag or release aborts loudly (exact
 * lines, aggregated like `preflight`) unless `--resume-publish` was passed, in which case a
 * MISSING release is itself an abort ("nothing to resume") and an existing one proceeds as
 * "resume" (upload-missing-only; release.ts does the querying).
 */
export function publishGuard(i: PublishGuardInputs): PublishGuardResult {
  const v = i.version;
  if (i.dryRun) {
    return {
      action: "dry-run-skip",
      lines: [
        `gh release create v${v} --title "Norma ${v}" + upload Norma-${v}.zip + Norma-${v}.dmg`,
        `commit + push releases/appcast.xml`,
        `git tag v${v} && git push origin v${v}`,
      ],
    };
  }
  if (i.resumePublish) {
    if (!i.releaseExists) {
      return {
        action: "abort",
        lines: [`--resume-publish given but release v${v} does not exist — nothing to resume`],
      };
    }
    return { action: "resume", lines: [] };
  }
  const aborts: string[] = [];
  if (i.tagExists) {
    aborts.push(
      `tag v${v} already exists — aborting to avoid double-publish (pass --resume-publish if a prior publish attempt partially completed)`,
    );
  }
  if (i.releaseExists) {
    aborts.push(
      `release v${v} already exists on GitHub — aborting to avoid double-publish (pass --resume-publish if a prior publish attempt partially completed)`,
    );
  }
  if (aborts.length > 0) return { action: "abort", lines: aborts };
  return { action: "publish", lines: [] };
}

/**
 * Provider-catalogue staleness nudge (T2 review M2). `CODEX_MODELS`'s context windows are
 * hand-held constants re-derived from a live `/models` call; the date of that derivation lives in
 * `CODEX_MODELS_VERIFIED` (packages/core/src/providers/codex-config.ts).
 *
 * WARN-ONLY, and deliberately so. A date-triggered FAILURE would redden a green pipeline on a day
 * nobody touched code, and the reflexive repair for that is to bump the date without checking
 * anything — which destroys the guard's meaning. It lives in the RELEASE pipeline rather than in
 * the test suite because that is the moment the number actually ships and a human is watching the
 * output; a `console.warn` inside a 229-file test run is invisible.
 *
 * Pure and injectable (`now`) so it is unit-testable without waiting 120 days.
 */
export function catalogueStaleness(i: { verified: string; now: Date; staleAfterDays?: number }): {
  stale: boolean;
  ageDays: number;
  line: string | null;
} {
  const budget = i.staleAfterDays ?? 120;
  const parsed = Date.parse(i.verified);
  if (Number.isNaN(parsed)) {
    return {
      stale: true,
      ageDays: NaN,
      line: `WARNING: CODEX_MODELS_VERIFIED is not a parseable date ("${i.verified}") — the catalogue staleness nudge cannot run.`,
    };
  }
  const ageDays = Math.floor((i.now.getTime() - parsed) / 86_400_000);
  if (ageDays <= budget) return { stale: false, ageDays, line: null };
  return {
    stale: true,
    ageDays,
    line:
      `WARNING: Codex model catalogue last verified ${i.verified} (${ageDays} days ago, budget ${budget}). ` +
      `This release ships CODEX_MODELS' context windows as constants; a stale window silently breaks ` +
      `auto-compaction. Re-derive: NORMA_CODEX_LIVE_DRIFT=1 bun test codex-models-drift`,
  };
}
