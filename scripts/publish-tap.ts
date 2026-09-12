/**
 * Publishes both casks to the Homebrew tap `yanlingLabs/homebrew-winter` (Winter Phase 9c, P9c-5):
 *   - Casks/winter.rb   <- out/release/<version>/winter.rb  (this repo's own release, already
 *                          rendered by release.ts's `caskFrom` call — read verbatim, never
 *                          re-interpolated here)
 *   - Casks/norma.rb    <- packaging/norma-deprecated.rb    (the deprecated cask, filled in by
 *                          hand by the CONTROLLER with the norma-final 0.2.015 release's real
 *                          version/sha256 before a real `--publish` run — see that file's own
 *                          header for the exact slots)
 *
 * Usage: bun run scripts/publish-tap.ts --dry-run | --publish
 *
 * `--dry-run` prints both files' final content and the target repo paths; makes NO network calls
 * (no `gh` invocation at all — not even a read).
 *
 * `--publish` is CONTROLLER-ONLY: it fetches each target path's current blob `sha` via
 * `gh api repos/<repo>/contents/<path>` (absent -> creating a new file, present -> updating one —
 * the GitHub Contents API requires the current `sha` on an update, or it 409s) and PUTs the new
 * content with a commit message ending in the Claude-Session trailer, base64-encoded per the
 * Contents API's own contract. This lane never runs `--publish` itself — the underlying logic
 * (`tapPlan`/`currentSha`/`putArgsFor`/`publishFile`) is unit-tested with a FAKE `GhRunner` in
 * scripts/publish-tap.test.ts instead of a real `gh` process.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, readCanonical } from "./version-lib";

export const TAP_REPO = "yanlingLabs/homebrew-winter";

export interface TapFile {
  /** Repo-relative path under the tap, e.g. "Casks/winter.rb". */
  repoPath: string;
  /** Local path this file's content is read from (verbatim — never interpolated here). */
  localPath: string;
}

/** The two files this release always publishes, for the given VERSION. Pure — no filesystem
 *  reads — so it's unit-testable without a real release build on disk. */
export function tapPlan(version: string): TapFile[] {
  return [
    { repoPath: "Casks/winter.rb", localPath: join(ROOT, "out", "release", version, "winter.rb") },
    { repoPath: "Casks/norma.rb", localPath: join(ROOT, "packaging", "norma-deprecated.rb") },
  ];
}

/** Matches an un-substituted `{{slot_name}}` template placeholder — the exact shape
 *  `packaging/norma-deprecated.rb`'s own header names (`{{version}}`, `{{sha256}}`) for the
 *  controller to hand-fill before a real handoff-release publish. */
const TEMPLATE_SLOT_RE = /\{\{[a-z0-9_]+\}\}/;

/** Fix wave M3 (whole-branch review, Major): the first still-unfilled template slot in `content`,
 *  or `undefined` once every slot has been replaced. `packaging/norma-deprecated.rb` ships in this
 *  repo with `{{version}}`/`{{sha256}}` literally in place — a `--dry-run` or `--publish` before the
 *  controller hand-fills them must never treat that text as ready-to-ship cask content. */
export function findUnfilledTemplateSlot(content: string): string | undefined {
  return content.match(TEMPLATE_SLOT_RE)?.[0];
}

/** Runs `gh` with the given args and returns its stdout. Thrown on a nonzero exit — mirrors
 *  `gh`'s own behaviour, so a fake test runner can `throw` to simulate any failure (a 404 on a
 *  not-yet-existing cask included) without needing to shape a fake exit code. */
export type GhRunner = (args: string[]) => string;

/**
 * The current blob `sha` of `repoPath` on the tap, or `undefined` if it does not exist yet (a
 * brand-new cask — the Contents API 404s, `gh api` exits nonzero, and that is the ONLY reason
 * this treats a `runner` throw as "absent" rather than propagating it; a real network/auth
 * failure looks identical to a caller with just a GhRunner, which is why `publishFile` calling
 * this before every PUT is deliberate — it always re-checks rather than assuming from a prior
 * call, so a cask that gets created between a dry preview and a real publish is still handled).
 */
export function currentSha(runner: GhRunner, repoPath: string): string | undefined {
  try {
    const out = runner(["api", `repos/${TAP_REPO}/contents/${repoPath}`, "--jq", ".sha"]).trim();
    return out === "" ? undefined : out;
  } catch {
    return undefined;
  }
}

/** The commit message every tap publish uses — one per file, so each cask's history on the tap
 *  names exactly what changed. Ends with the Claude-Session trailer (global constraints: tap
 *  commits carry it, same as this repo's own). */
export function commitMessageFor(repoPath: string): string {
  return `chore(tap): publish ${repoPath}\n\nClaude-Session: https://claude.ai/code/session_01YbJpkZBchtYViXeXfsXbDe`;
}

/** The exact `gh api` argv for one PUT — base64 content per the Contents API's contract, `sha`
 *  included only when updating an existing file (omitting it on a create is required; including
 *  a stale one on an update 409s). Exported so the test can assert the argv shape directly
 *  without a real `gh` process. */
export function putArgsFor(repoPath: string, content: string, sha: string | undefined): string[] {
  const args = [
    "api",
    "-X",
    "PUT",
    `repos/${TAP_REPO}/contents/${repoPath}`,
    "-f",
    `message=${commitMessageFor(repoPath)}`,
    "-f",
    `content=${Buffer.from(content, "utf8").toString("base64")}`,
  ];
  if (sha !== undefined) args.push("-f", `sha=${sha}`);
  return args;
}

/** Reads `file.localPath`, fetches its current tap `sha` (if any), and PUTs it. The one function
 *  that actually publishes a single file — `main`'s `--publish` branch calls this twice, once per
 *  `tapPlan()` entry, with the real `gh` runner; the test calls it with a fake one. Fix wave M3
 *  (whole-branch review, Major): refuses BEFORE any network call when `content` still contains an
 *  unfilled `{{slot}}` — this is the defense-in-depth check; `main`'s `--publish` branch also
 *  preflights the WHOLE plan before touching either file, so a bad second file never lands after a
 *  good first one already published. */
export function publishFile(runner: GhRunner, file: TapFile): void {
  const content = readFileSync(file.localPath, "utf8");
  const slot = findUnfilledTemplateSlot(content);
  if (slot) {
    throw new Error(`refusing to publish ${file.repoPath} (from ${file.localPath}): still contains an unfilled template slot ${slot} — fill it in before publishing`);
  }
  const sha = currentSha(runner, file.repoPath);
  runner(putArgsFor(file.repoPath, content, sha));
}

function realGhRunner(args: string[]): string {
  return execFileSync("gh", args, { encoding: "utf8" });
}

/** What `--dry-run` prints for ONE file: its full content, a "missing on disk" note, or — fix wave
 *  M3, Critical — a REFUSAL naming the still-unfilled slot, so a rehearsal never quietly shows
 *  literal `{{version}}` text as though it were ready-to-ship cask content. Pure (no console I/O),
 *  so the refusal path is unit-testable without a real release build on disk. */
export function renderDryRunEntry(file: TapFile): string {
  const header = `--- ${file.repoPath}  (from ${file.localPath}) ---`;
  if (!existsSync(file.localPath)) {
    return `${header}\n  (missing on disk — run a rehearsal or a real release first to produce this file)\n`;
  }
  const content = readFileSync(file.localPath, "utf8");
  const slot = findUnfilledTemplateSlot(content);
  if (slot) {
    return `${header}\n  REFUSED: still contains an unfilled template slot ${slot} — fill it in before publishing.\n`;
  }
  return `${header}\n${content}`;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const publish = argv.includes("--publish");
  if (dryRun === publish) {
    console.error("usage: bun run scripts/publish-tap.ts --dry-run | --publish");
    process.exit(1);
  }

  const version = readCanonical();
  const files = tapPlan(version);

  if (dryRun) {
    console.log(`Tap: ${TAP_REPO}\n`);
    let refused = false;
    for (const f of files) {
      const entry = renderDryRunEntry(f);
      console.log(entry);
      if (entry.includes("REFUSED:")) refused = true;
    }
    console.log(`DRY RUN: would PUT the above to ${TAP_REPO}. No network calls made.`);
    // Fix wave M3: a dry run that found an unfilled slot exits nonzero too — it is a refusal, not a
    // clean preview, even though (per this mode's own contract) it never makes a network call.
    process.exit(refused ? 1 : 0);
  }

  // --publish: CONTROLLER-ONLY (this lane never runs this branch — see the file header and
  // scripts/publish-tap.test.ts, which exercises this exact logic with a fake GhRunner instead).
  // Fix wave M3: preflight the WHOLE plan (existence AND template-slot completeness) before
  // touching either file — so a bad second file is caught before a good first one is published.
  for (const f of files) {
    if (!existsSync(f.localPath)) {
      console.error(`FAIL: ${f.localPath} does not exist — nothing to publish for ${f.repoPath}`);
      process.exit(1);
    }
    const slot = findUnfilledTemplateSlot(readFileSync(f.localPath, "utf8"));
    if (slot) {
      console.error(`FAIL: ${f.localPath} (for ${f.repoPath}) still contains an unfilled template slot ${slot} — fill it in before publishing.`);
      process.exit(1);
    }
  }
  for (const f of files) {
    console.log(`Publishing ${f.repoPath}...`);
    publishFile(realGhRunner, f);
  }
  console.log(`Published Casks/winter.rb + Casks/norma.rb to ${TAP_REPO}.`);
}
