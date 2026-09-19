import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Provider, TurnInputItem } from "../providers/types";
import type { SessionStore } from "../sessions/store";
import type { Settings } from "../settings";
import { effortToSpendForRole, pinsFor, ownProviderFor } from "../settings";
import { internalModelFor } from "../providers/manager";
import { isInternalRefusal, requireInternalWiring, type InternalCall, type InternalRefusal } from "../providers/internal-router";
import { classifyProviderFailure, type RoleHealthRegistry, type SubscriptionQuotaSource } from "../providers/role-health";
import { applyOps, validateOps, RESERVED_FILES, MAX_FILES } from "./dream-ops";

// WS-20: the model half is no longer a hardcoded constant — see `pinsFor(settings).dream` in
// settings.ts, read hot via `DreamerDeps.settings` below.
export const DREAM_EFFORT = "medium";
export const DREAM_MIN_EVENTS = 40;
export const DREAM_MIN_SPACING_MS = 7_200_000; // 2h
export const DREAM_TICK_MS = 300_000; // 5min
export const DREAM_WINDOW_MAX_CHARS = 200_000;

export const DREAM_INSTRUCTION = [
  "You are Winter's memory, consolidating while she rests. You receive: her current memory files, her tombstones list, today's date, and a transcript window of her recent conversations as the user's assistant (including outcomes of work sessions she delegated).",
  "Distill the transcript into durable memories:",
  "- SYNTHESIZE, don't transcribe: combine observations into abstractions that will matter weeks from now — preferences, ongoing projects, people, decisions, constraints. Never write fact-lists or echo single messages.",
  "- REVISE over time: every memory file carries `revised: <date>` frontmatter and a `sources: <seq ranges>` line. Update time-bounded facts as they age (an upcoming event becomes a past one; finished work is finished). Rewrite files rather than appending contradictions.",
  "- FORGET on request: if the user asked to forget or not mention something in this window, emit a tombstone op with a short description of the banned fact AND delete any file holding it.",
  "- TOMBSTONES ARE LAW: never write anything matching the tombstones list, even if the transcript re-teaches it.",
  "- NEVER memorize secrets, credentials, tokens, or keys, even if they appear. Skip transient trivia.",
  `- One topic per kebab-case .md file; at most ${MAX_FILES} files may exist — consolidate rather than sprawl. Content per file must stay small (under 8KB).`,
  'Reply with ONLY a JSON object, no prose: {"ops":[{"op":"write","file":"<kebab-name>.md","content":"..."} | {"op":"delete","file":"..."} | {"op":"tombstone","text":"..."}]} — an empty ops array is a valid answer when nothing is worth keeping.',
].join("\n");

const SUBSTANTIVE = new Set(["user_message", "assistant_message", "child_update"]);

export interface DreamerDeps {
  // Daemon settings surface (2026-09-17 plan, item 2): `live`, when present, is
  // `RebindableProvider.live` (providers/manager.ts) — the CURRENTLY BOUND backend's own identity,
  // mutated in place by `refresh` on a hot `provider.model` write that crosses catalog providers.
  // `runCycle` below compares `pinsFor(settings).dream`'s provider against THIS (falling back to
  // `ownProviderFor(settings)` only when absent, e.g. a test double) rather than the pure settings
  // read alone, which could disagree with the actual bound backend for as long as a rebind has not
  // caught up — or forever, on a rebind that failed (no credential yet for the new provider).
  // `quota?`: the SAME `RebindableProvider.quota` (providers/manager.ts) a real `agentProvider`
  // already carries — structurally satisfied with no adapter, since `Dreamer` is always constructed
  // with the WHOLE `RebindableProvider` object as `provider` (daemon.ts) and this type only narrows
  // which of its fields this class reads. Feeds `classifyProviderFailure`'s `subscriptionQuota`
  // input so a Codex usage-limit note can carry the account's own reported reset time even when the
  // failing round itself carried no `retryAfterMs`. Absent (every test double) means role-health
  // just never has that extra signal — `retryAfterMs` alone, when present, still works.
  /** The LEGACY double path — see `resolve`. Omitted by a real daemon. */
  provider?: { provider: Provider; model: string; live?: () => { providerId?: string }; quota?: SubscriptionQuotaSource }; // wrapper for parity with compactor/titler; model IGNORED — dreams pin pinsFor(settings).dream
  /**
   * 2026-09-19: the internal-jobs resolver (`providers/internal-router.ts`'s `resolve("pins.dream",
   * settings)`, bound to the live settings holder) — the ONE seam a real daemon wires. It answers the
   * `Provider`, the bare model, the qualified tag and the already-normalised effort together, so a pin
   * naming a provider other than `settings.provider.model`'s now RUNS ON ITS OWN PROVIDER instead of
   * being skipped: `internalModelFor`'s guard becomes the fix it was standing in for.
   *
   * Optional only because ~6 test files construct this class with a bare `{provider, model}` double;
   * exactly one of the two paths is used per cycle.
   */
  resolve?: () => InternalCall | InternalRefusal;
  /** B-1: `InternalProviderView.refreshSoon` — reconciles the internal-jobs credential snapshot from the
   *  scheduler's own slot (and after a rejected credential), so an out-of-band `winter login`/`winter
   *  logout` is picked up with no restart. Rate-limited and non-blocking inside. Absent in every double. */
  refreshCredentials?: () => void;
  store: SessionStore;
  dir: () => string;                // assistantMemoryDirFor thunk
  enabled: () => boolean;           // memoryEnabledHot
  // WS-20: hot settings read, same "re-read every call" discipline as every other settings-backed
  // getter — `pinsFor(deps.settings())` is called at each dream cycle, never a boot snapshot.
  settings: () => Settings | null;
  activeTurnCount: () => number;    // engine idle signal
  now?: () => number;               // injectable clock (tests)
  timeoutMs?: number;               // default WINTER_DREAM_TIMEOUT_MS ?? 120_000
  /** session-activity-hygiene T7 (spec §3): the session cleaner "rides the existing Dreaming cycle
   *  (its scheduler, its model configuration, low effort)". THE SCHEDULER is this class's tick
   *  timer, so the cleaner hangs off it here — one pass per tick, AFTER the dream pass.
   *
   *  A STRUCTURAL type, not a `SessionCleaner` import: the dependency runs one way only
   *  (sessions/cleaner.ts imports `DREAM_MODEL` from this file), and a concrete import here would
   *  close that into a cycle. Optional — a daemon with no provider wires no cleaner, and every
   *  pre-T7 `DreamerDeps` literal (this file's own tests included) keeps compiling unchanged.
   *
   *  Deliberately NOT gated by any dream gate: `enabled` here is `memory.enabled` (dreams), while
   *  the cleaner reads its own `cleaner.enabled` inside `runPass`. Nor by the dispatch-session,
   *  spacing or event-count gates, which are all about whether there is anything to DREAM about.
   *  The one thing the two do share is the re-entrancy guard, which is why the cleaner's provider
   *  call carries its own timeout — a hung judgment would otherwise wedge dreaming too. */
  cleaner?: { runPass(): Promise<unknown> };
  /** 2026-09-18: quiet per-role failure notes (`providers/role-health.ts`) — OBSERVATION ONLY, never
   *  changes what `runCycle` throws/logs. Absent (every pre-existing test double) records nothing,
   *  same as a daemon with no `winterHome` to persist against. */
  roleHealth?: RoleHealthRegistry;
}

interface DreamState { watermarkSeq: number; lastDreamAt: number }

export class Dreamer {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  constructor(private readonly deps: DreamerDeps) {
    this.now = deps.now ?? Date.now;
    // A junk env value must fall back to the default, not become NaN — setTimeout(fn, NaN) fires
    // immediately (lsp/client.ts's envNum guards the same footgun the same way).
    const n = Number(process.env.WINTER_DREAM_TIMEOUT_MS);
    this.timeoutMs = deps.timeoutMs ?? (Number.isFinite(n) && n > 0 ? n : 120_000);
  }

  private statePath(): string { return join(this.deps.dir(), "dream-state.json"); }
  private readState(): DreamState {
    try { return JSON.parse(readFileSync(this.statePath(), "utf8")) as DreamState; }
    catch { return { watermarkSeq: 0, lastDreamAt: 0 }; }
  }
  private writeState(s: DreamState): void {
    mkdirSync(this.deps.dir(), { recursive: true });
    const tmp = join(this.deps.dir(), ".dream-state.json.tmp");
    writeFileSync(tmp, JSON.stringify(s));
    renameSync(tmp, this.statePath());
  }

  /** One scheduler slot: the dream pass, then (T7) the session cleaner's pass. NEVER throws
   *  (scheduler precedent), and one pass failing never skips the other — each is wrapped on its
   *  own, so a bad dream cannot stop the cleaner and an exploding cleaner cannot stop dreams. The
   *  re-entrancy guard spans both, so a slow slot is never re-entered by the next timer fire. */
  async tick(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      // B-1 (2026-09-19): the scheduler's slot is the natural place to reconcile the internal-jobs
      // credential snapshot — a `winter login`/`winter logout` that happened out of band (both write the
      // Keychain in-process) is picked up here even on a daemon nothing else poked. Rate-limited and
      // non-blocking inside `refreshSoon`, so this is a no-op on the overwhelming majority of ticks.
      this.deps.refreshCredentials?.();
      try { await this.dreamPass(); }
      catch (e) { console.error(`[dreamer] tick failed: ${String(e)}`); }
      if (this.deps.cleaner) {
        try { await this.deps.cleaner.runPass(); }
        catch (e) { console.error(`[dreamer] cleaner pass failed: ${String(e)}`); }
      }
    } finally {
      this.inFlight = false;
    }
  }

  /** The dream gates, unchanged — extracted from `tick` verbatim so the cleaner could join the slot
   *  without entangling the two passes' gating. */
  private async dreamPass(): Promise<void> {
    if (!this.deps.enabled()) return;
    if (this.deps.activeTurnCount() > 0) return;
    const dispatchId = this.deps.store.dispatchSessionId();
    if (!dispatchId) return;
    const state = this.readState();
    if (this.now() - state.lastDreamAt < DREAM_MIN_SPACING_MS) return;
    const events = this.deps.store.read(dispatchId, state.watermarkSeq);
    const substantive = events.filter((e) => SUBSTANTIVE.has(e.type));
    if (substantive.length < DREAM_MIN_EVENTS) return;
    await this.runCycle(dispatchId, state);
  }

  /** One dream: window → prompt → one terra/medium call → validate → apply → advance. */
  private async runCycle(dispatchId: string, state: DreamState): Promise<void> {
    // WS-20 (review round 1, GUARD): `pinsFor(settings).dream` can name a DIFFERENT provider than
    // the one the daemon's single internal Provider instance is actually bound to (a
    // `settings.pins.dream` override, or a slot whose own default fell back to a sibling provider)
    // — sending that bare modelId to the wrong backend would be silent. Skip the whole cycle rather
    // than guess; `internalModelFor` logs the field name (never the tag) so the mismatch is
    // diagnosable without a raw provider-config dump in the log.
    const settings = this.deps.settings();
    // 2026-09-19: ONE resolution for the whole cycle — provider, model, tag and effort from a single
    // settings/credential generation. A refusal skips the cycle, exactly as an `internalModelFor`
    // mismatch used to, but for the honest reasons only (nothing credentialed, or an explicit pin on a
    // provider Winter's jobs cannot use) rather than for "the pin names a provider we did not bind".
    const resolved = this.deps.resolve?.();
    if (resolved !== undefined && isInternalRefusal(resolved)) return;
    const boundProviderId = resolved?.providerId ?? this.deps.provider?.live?.().providerId ?? ownProviderFor(settings);
    const dreamPin = resolved?.tag ?? pinsFor(settings).dream;
    const dreamModel = resolved !== undefined
      ? resolved.model
      : internalModelFor(dreamPin, { providerId: boundProviderId }, "pins.dream");
    if (dreamModel === undefined) return;
    const dreamProvider = resolved?.provider ?? this.deps.provider?.provider;
    if (dreamProvider === undefined) requireInternalWiring("Dreamer");
    const dreamQuota = resolved?.quota ?? this.deps.provider?.quota;
    // 2026-09-18: the role's stored effort (`settings.roleEfforts["pins.dream"]`), off the SAME live
    // `settings` read as the pin just above — so a Roles-pane change lands on the next cycle, and the
    // model and its effort can never come from two different settings generations. Mapped onto the
    // pin's own row and never a refusal; with nothing stored it is `DREAM_EFFORT`, raw, exactly as
    // before (see `effortToSpendForRole`). Resolved against the TAG: `dreamModel` is already bare.
    const dreamEffort = resolved !== undefined ? resolved.effort : effortToSpendForRole(settings, "pins.dream", dreamPin, DREAM_EFFORT);
    const upTo = this.deps.store.lastSeq(dispatchId);
    const events = this.deps.store.read(dispatchId, state.watermarkSeq);
    const lines: string[] = [];
    for (const e of events) {
      if (e.type === "user_message") lines.push(`[user] ${e.text}`);
      else if (e.type === "assistant_message") lines.push(`[winter] ${e.text}`);
      else if (e.type === "child_update") lines.push(`[delegated work "${e.title}" → ${e.status}]${e.resultSummary ? ` ${e.resultSummary}` : ""}`);
    }
    let transcript = lines.join("\n");
    if (transcript.length > DREAM_WINDOW_MAX_CHARS) {
      transcript = `[earlier events trimmed]\n${transcript.slice(transcript.length - DREAM_WINDOW_MAX_CHARS)}`;
    }
    const dir = this.deps.dir();
    const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md") && !RESERVED_FILES.has(f)) : [];
    const memories = files.map((f) => `--- ${f} ---\n${readFileSync(join(dir, f), "utf8")}`).join("\n\n") || "(no memories yet)";
    const tombstones = existsSync(join(dir, "tombstones.md")) ? readFileSync(join(dir, "tombstones.md"), "utf8") : "(none)";
    const today = new Date(this.now()).toISOString().slice(0, 10);
    const content = `Today's date: ${today}\n\n## Current memory files\n${memories}\n\n## Tombstones (never re-learn)\n${tombstones}\n\n## Transcript window (events ${state.watermarkSeq + 1}..${upTo})\n${transcript}`;
    const input: TurnInputItem[] = [{ type: "message", role: "user", content }];

    // Carried-over review fix (Task 3): without a signal, a Promise.race timeout only makes THIS
    // call stop waiting — the detached streamTurn generator keeps draining under a hung provider,
    // leaking a connection every tick. `ac` ties the provider call's lifetime to the race: aborted
    // in the SAME finally that clears the timer, whichever side of the race wins.
    const ac = new AbortController();
    // 2026-09-18: the EFFECTIVE tag this cycle actually runs on — `dreamModel` above is already the
    // bare id verified to name `boundProviderId`, so recomposing the qualified tag here is exactly
    // the daemon's own `liveModel` recomposition (daemon.ts), just local to this call.
    const effectiveTag = `${boundProviderId}/${dreamModel}`;
    let text = "";
    let sawProviderError = false;
    const run = (async () => {
      // The internal `Provider` abstraction speaks bare model ids in ITS OWN dialect (the same
      // single backend `agentProvider` was constructed for) — `dreamModel`, computed once above
      // via `internalModelFor`, is already that bare id, verified to name the SAME provider this
      // Provider instance is bound to.
      for await (const ev of dreamProvider.streamTurn({
        model: dreamModel, ...(dreamEffort === undefined ? {} : { reasoningEffort: dreamEffort }), instructions: DREAM_INSTRUCTION, input, tools: [], signal: ac.signal,
      })) {
        if (ev.type === "text_delta") text += ev.delta;
        else if (ev.type === "error") {
          // Observation only (this method's throw/catch shape is unchanged) — the classifier reads
          // ONLY the structured fields already on the event, never `ev.message` for its DECISION.
          sawProviderError = true;
          // B-1: a credential the provider REJECTED (or one it says is missing) is the other symptom of a
          // stale snapshot — `winter logout` leaves the daemon believing codex is still signed in. Ask for
          // a rate-limited re-probe so the next cycle is right; never blocking, never per call.
          if (ev.code === "auth") this.deps.refreshCredentials?.();
          this.deps.roleHealth?.recordFailure("pins.dream", effectiveTag, classifyProviderFailure({ ...ev, subscriptionQuota: dreamQuota?.subscriptionQuota() }));
          throw new Error(`provider error: ${ev.message}`);
        }
        else if (ev.type === "done" && ev.stopReason === "aborted") throw new Error("dream aborted");
      }
      // A "done" that is not an aborted stop, with no error event seen: the provider call itself
      // succeeded. Recorded here (before the JSON parse/apply below) because role health is about
      // the PROVIDER CALL, not about whether the model's reply happened to be well-formed JSON.
      if (!sawProviderError) this.deps.roleHealth?.recordSuccess("pins.dream");
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error("dream timed out")), this.timeoutMs); });
    try { await Promise.race([run, timeout]); } finally { clearTimeout(timer); ac.abort(); }

    const m = text.match(/\{[\s\S]*\}/); // reviewer.ts's greedy-brace idiom
    if (!m) throw new Error(`dream returned no JSON: ${text.slice(0, 120)}`);
    const parsed = JSON.parse(m[0]) as { ops?: unknown };
    const v = validateOps(parsed.ops, files);
    if (!v.ok) throw new Error(`dream ops invalid: ${v.error}`);
    applyOps(dir, v.ops);
    this.writeState({ watermarkSeq: upTo, lastDreamAt: this.now() });
  }

  start(intervalMs: number = DREAM_TICK_MS): void {
    if (this.timer) return; // idempotent (scheduler precedent)
    this.timer = setInterval(() => { void this.tick(); }, intervalMs);
    this.timer.unref?.(); // never keeps the daemon alive on its own
  }
  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
}
