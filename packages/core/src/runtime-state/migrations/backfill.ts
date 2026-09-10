// WS-16 §17's Migration A, phase 4: give every session this daemon already owns a
// `RuntimeSessionRecord`, so the runtime spine has a complete picture of the past before anything
// starts routing on it.
//
// WHAT A BACKFILLED RECORD DELIBERATELY DOES NOT CLAIM. A legacy session's history is a Norma
// `SessionEvent` JSONL and nothing else: there is no Claude-dialect compatibility transcript for it,
// no backend session uuid that any file is named after, no recorded SDK or engine version, and no
// selection anybody actually made. Every one of those absences is written down rather than
// papered over —
//
//   backendSessionId        absent            no compatibility transcript exists (§17 step 4, §9)
//   transcriptHealth        "unsupported"     …so its health is not "clean", it is "not a thing"
//   compatibilityLevel      "conversation"    import-the-conversation is the whole ceiling
//   conformanceCorpusVersion "legacy"         no corpus was ever run against this session
//   versionProvenance       "legacy-unknown"  §4: omission is RESERVED for this, never read as current
//   capabilities            import-conversation only
//   selection.reason        "backfill"        nobody chose this; a migration wrote it
//
// — because a plausible-looking lie here is worse than a gap: 8b's `reviewPersistedSelection`
// refuses records that misdescribe themselves, and a `transcriptHealth: "clean"` on a transcript
// that does not exist would send a resume hunting for a file forever.
import { transcriptProjectKey } from "@yanlinglabs/winter-agent-sdk";
import type { RuntimeSelection } from "@yanlinglabs/winter-runtime-sdk";
import { join } from "node:path";
import { repoRootFor, sanitizeProjectKey } from "../../agent/memory-dir";
import { SYNCED_SESSION_ID_RE, type SessionStore } from "../../sessions/store";
import type { RuntimeStateDb } from "../db";
import { RuntimeSessionRecords, type RuntimeSessionState } from "../records";

export interface BackfillReport {
  /** Sessions that gained a record on this run. */
  created: string[];
  /** Phone-origin sessions (`SYNCED_SESSION_ID_RE`): not this daemon's runtimes to describe. */
  skipped: string[];
  /** Sessions that already had a record — what makes a second run a no-op. */
  alreadyPresent: string[];
  errors: Array<{ winterSessionId: string; error: string }>;
}

export interface BackfillDeps {
  rs: RuntimeStateDb;
  store: SessionStore;
  home: string;
  /** `settings.provider.type` — `codex-oauth` | `openai-compatible`. */
  providerId: string;
  now?: () => string;
}

/**
 * The event types that mean "nothing was still in flight when this session was last written to".
 *
 * A session that ends on one of these finished a unit of work, so `exited` is the honest state. A
 * session whose log ends mid-turn (`turn_started`, a `tool_call` with no result, an
 * `approval_requested` nobody answered) ended because something stopped — and this migration cannot
 * tell what — so it settles as `unavailable`, which is precisely §4's "we cannot revalidate this"
 * state rather than a guess in either direction.
 */
const TERMINAL_LAST_EVENTS: ReadonlySet<string> = new Set(["turn_completed", "harness_detached", "agent_error"]);

/**
 * The auth family a legacy session's provider actually authenticates with.
 *
 * `api-key` is claimed for exactly one provider type — an OpenAI-compatible endpoint configured
 * with a key. Everything else this daemon can be configured with today is OAuth-backed
 * (`codex-oauth`), and an OAuth credential is not an API key: `custom` is the union member that says
 * "a family this record cannot name" without asserting one that would be false. `claude-oauth` and
 * `console-oauth` are never inferred here for the same reason the router never infers them — an
 * OAuth family is reachable only by declaration (WS-14 §12's ship gate).
 */
function authFamilyFor(providerId: string): RuntimeSelection["authFamily"] {
  return providerId === "openai-compatible" ? "api-key" : "custom";
}

/**
 * Backfill every native session that has no runtime record yet. Idempotent: a session that already
 * has a record is reported, never rewritten — re-running after adding sessions is the supported way
 * to catch up, and re-running after a crash mid-migration completes it.
 */
export function backfillNativeSessions(deps: BackfillDeps): BackfillReport {
  const { rs, store, providerId } = deps;
  const now = deps.now ?? (() => new Date().toISOString());
  const records = new RuntimeSessionRecords(rs, now);
  const report: BackfillReport = { created: [], skipped: [], alreadyPresent: [], errors: [] };

  for (const row of store.list()) {
    const winterSessionId = row.sessionId;
    // Phone-minted ids are UUIDs; this daemon's are `s_<hex>`. A synced session's runtime lives on
    // the phone, so describing one here would invent a runtime that does not exist on this machine.
    if (SYNCED_SESSION_ID_RE.test(winterSessionId)) {
      report.skipped.push(winterSessionId);
      continue;
    }
    if (records.get(winterSessionId)) {
      report.alreadyPresent.push(winterSessionId);
      continue;
    }
    try {
      backfillOne(deps, records, now, winterSessionId);
      report.created.push(winterSessionId);
    } catch (e) {
      // Bounded per session: one unreadable index row must not deny every other session a record.
      report.errors.push({ winterSessionId, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return report;
}

function backfillOne(deps: BackfillDeps, records: RuntimeSessionRecords, now: () => string, winterSessionId: string): void {
  const { rs, store, home, providerId } = deps;
  const meta = store.meta(winterSessionId);
  const cwd = meta.cwd ?? home;
  const transcriptKey = transcriptProjectKey(cwd);
  // TODAY's memory key, exactly as `memoryDirFor` computes it (`<home>/projects/<key>/memory`) —
  // read from `agent/memory-dir.ts` rather than re-derived here, so this migration and the live
  // memory path can never disagree about where a project's memory is. Task 10 (§17 phase 5) is what
  // moves it to the compatibility key; until then the record states where the memory IS.
  const memoryKey = sanitizeProjectKey(repoRootFor(cwd));
  const settle = settlePathFor(store, meta, winterSessionId);
  const at = now();

  const selection: RuntimeSelection = {
    runtimeKind: "winter-agent",
    providerId,
    // A BARE MODEL ID, DELIBERATELY, and 8b should read legacy rows as unqualified (review r1,
    // minor 6). The SDK types `modelRef` as the provider-qualified catalog ROW KEY
    // (`anthropic/claude-opus-5`), and the obvious derivation — `${providerId}/${model}` — would be
    // a fabrication here: `providerId` on this record is `settings.provider.type`
    // (`codex-oauth` | `openai-compatible`), which is Norma's PROVIDER TYPE, not a catalog provider
    // id, so the composed string would name a row no catalog has ever contained. The bare id is what
    // the session actually ran with, and the record already says it is not to be trusted as current:
    // `versionProvenance: "legacy-unknown"`, `family: "legacy"`, `reason: "backfill"`.
    modelRef: meta.model ?? "unknown",
    family: "legacy",
    authFamily: authFamilyFor(providerId),
    sdkVersion: "unknown",
    reason: "backfill",
    decidedAt: at,
  };

  // ONE transaction per session, and it spans the settling transitions for a reason: `create`
  // always inserts `creating`, and `creating` has exactly two exits (§4's table). A record left in
  // `creating` by a torn run would be reported `alreadyPresent` by every later run and never
  // repaired — so either the whole record lands settled, or none of it lands. Because the whole
  // sequence commits at once, no reader ever observes the intermediate `ready` either.
  rs.transaction(
    () => {
      records.create({
        winterSessionId,
        runtimeKind: "winter-agent",
        providerId,
        modelRef: selection.modelRef,
        // Where this session's compatibility tree WOULD live. Nothing is written there by this
        // migration; it is the root a later import would read from.
        backendRoot: join(home, "projects", transcriptKey),
        transcriptProjectKey: transcriptKey,
        memoryProjectKey: memoryKey,
        tempProjectKey: transcriptKey,
        transcriptDialect: "claude-code-jsonl",
        transcriptHealth: "unsupported",
        compatibilityLevel: "conversation",
        conformanceCorpusVersion: "legacy",
        versionProvenance: "legacy-unknown",
        capabilities: ["import-conversation"],
        selection,
      });
      for (const state of settle) records.transition(winterSessionId, state);
    },
    { mode: "immediate" },
  );
}

/**
 * The states this record walks through to reach the one it should rest in.
 *
 * Always via `ready`, because `create` inserts `creating` and §4's table gives it exactly two exits.
 * Then `exited` when the log's last event says the session finished, `unavailable` otherwise — a log
 * ending mid-turn cannot be called a clean finish.
 *
 * A session the USER ALREADY ARCHIVED then takes one more step to `archived` (review r1, minor 9).
 * "Archive is not delete" (WS-16 §16) has to hold for legacy sessions too: 8b refuses messaging to an
 * archived session, and without this step that refusal would silently skip every session a user
 * retired before the runtime spine existed. `archived` is reachable from `exited` and from
 * `unavailable` alike, so neither has to pretend it ended the way the other did.
 */
function settlePathFor(store: SessionStore, meta: { archived?: boolean }, winterSessionId: string): RuntimeSessionState[] {
  const events = store.read(winterSessionId);
  const last = events[events.length - 1];
  const settled: RuntimeSessionState = last && TERMINAL_LAST_EVENTS.has(last.type) ? "exited" : "unavailable";
  return meta.archived ? ["ready", settled, "archived"] : ["ready", settled];
}
