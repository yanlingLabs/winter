import { z } from "zod";
import type { Provider, ProviderEvent, TurnInputItem, ToolSpec } from "../providers/types";
import { fetchCleanPage, renderLines, PageCoreError, type PageCache, type CleanPage } from "./tools/page-core";
import { READPAGE_PER_PAGE_CHAR_CAP, READPAGE_TOTAL_OUTPUT_CHAR_CAP } from "./tools/read-page";

/**
 * B2-T3: the ephemeral research sub-agent. A plain, radically reduced loop over
 * `provider.streamTurn` — the SAME turn-loop shape engine.ts's own `runThread` uses (a round:
 * gather streamed events -> collect tool_calls -> dispatch -> feed tool_results back -> repeat
 * until `done`), with everything session-shaped stripped out: no hub, no store, no gate, no
 * persisted events, no session/thread identity at all. The four hard EPHEMERALITY properties
 * (user decision, task-3-brief.md) fall out of that shape rather than being separately enforced:
 *
 *   1. No transcript — nothing in this file ever touches a SessionStore or SessionHub.
 *   2. Not addressable — no BackgroundAgentRegistry entry, no AgentStore/agent_list visibility;
 *      this runner is never handed a sessionId to register anything against.
 *   3. Not re-callable — `run()` is fire-and-return. The loop's whole state lives on the stack of
 *      one async call and is gone the instant the returned Promise settles; no handle is ever
 *      produced or retained anywhere.
 *   4. Unstoppable except by its own wall clock (`RESEARCH_WALL_CLOCK_MS`, injectable via
 *      `deps.wallClockMs` for tests) — there is no store/hub for an external task_stop/abort
 *      bridge to even find this run through. The wall clock is enforced by the loop's OWN race
 *      against every provider step AND every fetch (see `raceDeadline`), not merely by handing
 *      the provider/fetch an AbortSignal and hoping it cooperates — fix-round-1 CRITICAL: a
 *      provider or a fetchFn that ignores its signal entirely still cannot hang this function
 *      past its deadline, because every await that could stall is raced against `deadline`
 *      independently of whether the thing on the other end cooperates.
 *
 * `FetchPage` — this runner's ONLY tool — is a hand-rolled spec + direct dispatch right here, and
 * NEVER touches the daemon's shared ToolRegistry: mode-toolset-census.test.ts carries a forward
 * guard (task-2-brief.md) that fails the whole suite the instant a tool named "FetchPage" is
 * registered there. A full ToolRegistry would buy nothing this loop needs (modes/deferred/scope
 * are code-session concepts this runner has none of) and would be one more surface FetchPage could
 * accidentally leak onto a shared instance from — the smaller, self-contained shape is the SAFER
 * one, not merely the shorter one.
 */

export const RESEARCH_MODEL = "gpt-5.4-mini";
export const RESEARCH_FALLBACK_MODEL = "gpt-5.6-luna";
export const RESEARCH_EFFORT = "low";
export const RESEARCH_MAX_PAGES_DEFAULT = 5;
export const RESEARCH_MAX_PAGES_CEILING = 15;
export const RESEARCH_WALL_CLOCK_MS = 180_000;

// Runaway guard ONLY — the wall clock above is the real bound on wall-clock time. This bounds the
// number of provider round-trips instead, in case a script somehow keeps calling FetchPage forever
// without ever exhausting the page budget (impossible for a well-behaved model, since every
// FetchPage call — even an exhausted one — is still a round; this is belt-and-suspenders).
const MAX_ROUNDS = 12;

// A report is one page-sized unit of chat output (matches ReadPage's own per-page cap, read-page.ts),
// not the whole multi-page batch ceiling — a research report is always a single ReadPage entry's text.
const REPORT_CHAR_CAP = 20_000;

const FETCH_PAGE_TOOL_NAME = "FetchPage";

const FetchPageArgs = z.object({ urls: z.array(z.string().min(1)).min(1).max(8) });

const FETCH_PAGE_TOOL: ToolSpec = {
  name: FETCH_PAGE_TOOL_NAME,
  description:
    "Fetch one or more web pages (1-8 per call) as clean, line-numbered markdown with their outbound links. " +
    "Batch every url you want to read next into ONE call rather than calling this once per url. " +
    "You have a limited page budget for this whole research task, and every url in a batch counts against it — " +
    "when the budget runs out this returns an informational 'page budget exhausted' message instead of a page.",
  parameters: z.toJSONSchema(FetchPageArgs),
};

/** The sub-agent's system prompt (sent as `instructions`, never as an input message) — DEMANDS
 *  (Task 3's user decision) per-sentence citations in the exact `url lines:N-M` form, a closing
 *  links-found list, and an explicit not-read list when truncated. A scripted-provider test cannot
 *  prove the MODEL follows this — what research.test.ts asserts instead is that this text actually
 *  reaches the provider request, and that the budget/truncation machinery (see `handleFetchPage`
 *  and the timeout/round-limit paths below) injects the not-read data into the input the model
 *  sees, so a real model CAN comply. */
export const RESEARCH_SYSTEM_PROMPT = [
  "You are an ephemeral research sub-agent with exactly one tool, FetchPage. You have been given a",
  "seed web page (already fetched, cleaned, and numbered) and a research query. Read the seed page",
  "and, using FetchPage, follow whatever links (on the seed page or on pages you fetch) you need to",
  "answer the query thoroughly. Batch every url you want next into ONE FetchPage call (1-8 urls).",
  "",
  "When you have enough to answer, stop calling tools and write your final report as plain text.",
  "",
  "CITATION RULE (MANDATORY): every sentence of fact in your report must end with a citation in the",
  'EXACT form "<resolved-url> lines:N-M" — the resolved url and the line numbers shown on the',
  "numbered page text you were given. Never cite a url you were not shown numbered lines for, and",
  "never the pre-redirect url if a page you read resolved somewhere else.",
  "",
  "Your report must end with two sections:",
  '1. "Links found:" — every link you saw on the pages you consulted (resolved url + link text),',
  "   one per line.",
  '2. "Not read:" — if you ran out of page budget or ran out of time before finishing, say exactly',
  "   what you did not get to read. Omit this section only if you read everything you needed.",
].join("\n");

/** What ReadPage (read-page.ts) hands the runner for a `query` entry — matches that file's own
 *  `ResearchQuery`/`ResearchRunner` types structurally (TS interfaces compare structurally; this
 *  file deliberately does not import them, so this runner has no compile-time dependency on
 *  ReadPage's own module — daemon.ts is the only place the two are wired together). */
export interface ResearchQuery {
  url: string;
  query: string;
  max_pages?: number;
}

export interface ResearchRunner {
  run(q: ResearchQuery, opts: { signal?: AbortSignal }): Promise<string>;
}

export interface ResearchDeps {
  provider: Provider;
  cache: PageCache;
  fetchFn?: typeof fetch;
  audit?: (line: Record<string, unknown>) => void;
  /** Injectable clock, forwarded to page-core's TTL bookkeeping — test-only. Does NOT govern the
   *  wall clock below, which always runs in real time regardless of this. */
  now?: () => number;
  /** Wall-clock budget override — test-only (shrinks RESEARCH_WALL_CLOCK_MS so a stall test does
   *  not need to wait out the real 180s). Production never sets this. */
  wallClockMs?: number;
}

interface RunState {
  maxPages: number;
  pagesRead: number;
  notRead: string[];
  linksFound: Map<string, string>; // href -> text, first-seen wins (matches page-core's own dedup)
}

function clampMaxPages(requested: number | undefined): number {
  const base = requested ?? RESEARCH_MAX_PAGES_DEFAULT;
  return Math.min(Math.max(Math.trunc(base) || 1, 1), RESEARCH_MAX_PAGES_CEILING);
}

/** Caps `text` to at most `cap` characters TOTAL (including `marker`) — never silently drops the
 *  marker itself over the limit (the marker's length is reserved up front). Shared by the report
 *  cap (below) and the per-page/per-batch caps (fix-round-1 IMPORTANT) — one truncation mechanism,
 *  three cap sizes. */
function capWithMarker(text: string, cap: number, marker: string): string {
  if (text.length <= cap) return text;
  return text.slice(0, Math.max(0, cap - marker.length)) + marker;
}

function capText(text: string): string {
  return capWithMarker(text, REPORT_CHAR_CAP, `\n[report truncated at ${REPORT_CHAR_CAP} chars]`);
}

/** Renders one fetched page as the numbered section the model reads — same shape as ReadPage's own
 *  per-page section (url header, numbered lines, a `Links:` tail), so the model has the resolved
 *  url + line numbers it needs to build a `url lines:N-M` citation, and the outbound links it needs
 *  for its closing "Links found:" section.
 *
 *  fix-round-1 IMPORTANT: capped at READPAGE_PER_PAGE_CHAR_CAP (read-page.ts's own constant, reused
 *  rather than re-invented — the sub-agent's own context deserves the exact same per-page ceiling
 *  ReadPage already enforces for the main model). Before this fix, ONLY the final report (20k) was
 *  capped — a single huge fetched page went into the NEXT provider request whole, uncapped; 8
 *  such pages in one batch measured 2.4M chars in one tool_result. */
function pageSection(page: CleanPage): string {
  const rendered = renderLines(page);
  const linksList = page.links.length
    ? page.links.map((l, i) => `${i + 1}. ${l.text || "(no text)"} (${l.href})`).join("\n")
    : "(none)";
  const section = [page.url, rendered, "", "Links:", linksList].join("\n");
  return capWithMarker(
    section,
    READPAGE_PER_PAGE_CHAR_CAP,
    `\n[page content truncated at ${READPAGE_PER_PAGE_CHAR_CAP} chars — the rest of this page's content was cut]`,
  );
}

function recordLinks(state: RunState, page: CleanPage): void {
  for (const link of page.links) if (!state.linksFound.has(link.href)) state.linksFound.set(link.href, link.text);
}

function linksSummary(state: RunState): string {
  if (state.linksFound.size === 0) return "";
  const lines = [...state.linksFound.entries()].map(([href, t], i) => `${i + 1}. ${t || "(no text)"} (${href})`);
  return `\n\nLinks found:\n${lines.join("\n")}`;
}

function buildSeedMessage(q: ResearchQuery, seed: CleanPage): string {
  return [`Research query: ${q.query}`, "", "Seed page:", pageSection(seed)].join("\n");
}

/** Prefixes `message` with `lastText` when there is any — fix-round-1 Minor 2: a failure that
 *  happens on a LATER round must not discard an EARLIER round's own assistant text; a partial
 *  answer beats none. Every throwing failure path below routes through this (and `capText`) so
 *  none of them can silently drop prior text the way the original provider-error path did. */
function failureMessage(lastText: string, message: string): string {
  return lastText ? `${lastText}\n\n${message}` : message;
}

/** Handles ONE FetchPage tool call (a batch of 1-8 urls): fetches whatever the remaining budget
 *  allows, in the model's requested order, decrementing the budget by every url ATTEMPTED
 *  (success or failure alike — a bad url still costs a slot, or a model could spam invalid urls for
 *  free). Never throws: a per-url fetch failure becomes a labeled failure line in the same combined
 *  section, exactly like ReadPage's own batch (read-page.ts's `renderPage` precedent) — one bad url
 *  in a batch must not fail the whole call. Always informational (isError:false is decided by the
 *  caller, not here) — a fetch failure or a budget exhaustion are both things the model should read
 *  and act on, never a hard tool error.
 *
 *  fix-round-1 CRITICAL: each fetch is raced against the SAME `deadline` the provider stream uses
 *  (`raceDeadline`) — a stuck fetch inside a batch can no longer hang the whole run, independent of
 *  whether the fetch itself would eventually honor `signal`. fix-round-1 IMPORTANT: the joined
 *  output is capped at READPAGE_TOTAL_OUTPUT_CHAR_CAP (read-page.ts's own batch cap), same posture
 *  as ReadPage's own batch response. */
async function handleFetchPage(
  urls: string[],
  state: RunState,
  deps: ResearchDeps,
  signal: AbortSignal,
  deadline: number,
): Promise<string> {
  if (state.pagesRead >= state.maxPages) {
    return `page budget exhausted (${state.pagesRead} pages read)`;
  }
  const remaining = state.maxPages - state.pagesRead;
  const toFetch = urls.slice(0, remaining);
  const skipped = urls.slice(remaining);

  const sections = await Promise.all(
    toFetch.map(async (url) => {
      state.pagesRead++;
      try {
        const race = await raceDeadline(
          fetchCleanPage(url, deps.cache, { fetchFn: deps.fetchFn, now: deps.now, audit: deps.audit, tool: FETCH_PAGE_TOOL_NAME, signal }),
          deadline,
        );
        if (race.timedOut) {
          state.notRead.push(url);
          return `${url}: timed out`;
        }
        recordLinks(state, race.value);
        return pageSection(race.value);
      } catch (e) {
        state.notRead.push(url);
        const message = e instanceof PageCoreError || e instanceof Error ? e.message : String(e);
        return `${url}: ${message}`;
      }
    }),
  );

  if (skipped.length) {
    state.notRead.push(...skipped);
    sections.push(`page budget exhausted (${state.pagesRead} pages read) — not fetched: ${skipped.join(", ")}`);
  }

  return capWithMarker(
    sections.join("\n\n---\n\n"),
    READPAGE_TOTAL_OUTPUT_CHAR_CAP,
    `\n\n[batch output truncated at ${READPAGE_TOTAL_OUTPUT_CHAR_CAP} chars — remaining pages' content was cut]`,
  );
}

/** A context-length complaint is a `bad_request` too, but about the PAYLOAD, not the model choice
 *  — must never burn the one fallback retry (especially now that huge payloads are POSSIBLE again
 *  even after the IMPORTANT cap fix above, just bounded instead of unbounded). Checked first, ahead
 *  of every other rule below, so it wins even when the message also happens to name the model
 *  (a real "context length exceeded" message routinely does: "gpt-5.4-mini's maximum context
 *  length is..."). */
const CONTEXT_LENGTH_RE = /context.length|context_length_exceeded/;

/** Phrases that read as a genuine unknown/unsupported-model complaint, independent of the error
 *  `code` — this is the "or reads as unknown-model" half of the brief's trigger criteria. */
const UNKNOWN_MODEL_RE = /unknown model|model not found|unsupported model|invalid model|model.{0,20}(deprecated|unavailable|unsupported)/;

/** true when a provider error should trigger the ONE model-fallback retry. fix-round-1 Minor 1
 *  NARROWED this from "any bad_request retries" (too broad — a context_length_exceeded, or an
 *  unrelated malformed-arguments bad_request, would have wrongly burned the fallback) to: a
 *  context-length complaint NEVER retries; a message that plainly reads as an unknown/unsupported-
 *  model complaint always retries regardless of code; otherwise only a `bad_request` that also
 *  names the CURRENT model retries (this repo's own provider layer reports a deprecated/unknown
 *  model slug exactly this way — see providers/manager.ts's "deprecated/unavailable... falling
 *  back to..." path). An error under some OTHER code (auth, rate_limit, ...) that merely happens to
 *  mention the model string — e.g. an auth failure message that includes the model name — does
 *  NOT retry: naming the model is only meaningful evidence of a model problem when the code itself
 *  says the request was bad. */
function looksLikeBadModelError(ev: Extract<ProviderEvent, { type: "error" }>, model: string): boolean {
  const msg = ev.message.toLowerCase();
  if (CONTEXT_LENGTH_RE.test(msg)) return false;
  if (UNKNOWN_MODEL_RE.test(msg)) return true;
  return ev.code === "bad_request" && msg.includes(model.toLowerCase());
}

/** Builds the (still-resolved, non-throwing) partial report for a budget/clock/round-limit
 *  truncation — these three are NOT failures: the run may have gathered real content, and the
 *  CRITICAL fix's own contract demands `run()` still RESOLVE (never reject) on a timeout so a
 *  hung fetch/provider can't wedge the calling chat turn. Contrast `failureMessage`'s callers
 *  (provider error / empty report / ambiguous stream end), which DO reject — see Minor 4. */
function notReadReport(lastText: string, state: RunState, reason: string): string {
  const urls = [...new Set(state.notRead)];
  const list = urls.length ? ` Not read: ${urls.join(", ")}.` : "";
  const note = `${reason} (pages read: ${state.pagesRead}).${list}${linksSummary(state)}`;
  return capText(failureMessage(lastText, note));
}

/** Races ONE promise against an absolute deadline — the mechanism that makes the wall clock a real
 *  guarantee rather than a polite request: even something that never resolves and never looks at
 *  an AbortSignal cannot keep the caller waiting past `deadline`. Used for BOTH the provider
 *  stream's `iterator.next()` calls and (fix-round-1 CRITICAL) every `fetchCleanPage` call this
 *  file makes — a rejection from `promise` propagates normally (this only intercepts the "never
 *  settles" case, not real failures). The loser of the race (if `promise` itself never settles) is
 *  simply abandoned — nothing awaits it further. */
async function raceDeadline<T>(promise: Promise<T>, deadline: number): Promise<{ timedOut: true } | { timedOut: false; value: T }> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return { timedOut: true };
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), remaining);
  });
  try {
    return await Promise.race([
      promise.then((value) => ({ timedOut: false as const, value })),
      timeout,
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

async function nextWithDeadline(
  iterator: AsyncIterator<ProviderEvent>,
  deadline: number,
): Promise<{ timedOut: true } | { timedOut: false; value: IteratorResult<ProviderEvent> }> {
  return raceDeadline(iterator.next(), deadline);
}

async function runResearch(q: ResearchQuery, deps: ResearchDeps, externalSignal: AbortSignal | undefined): Promise<string> {
  const maxPages = clampMaxPages(q.max_pages);
  const wallClockMs = deps.wallClockMs ?? RESEARCH_WALL_CLOCK_MS;
  const timeoutSignal = AbortSignal.timeout(wallClockMs);
  const signal = AbortSignal.any([externalSignal, timeoutSignal].filter((s): s is AbortSignal => Boolean(s)));
  const deadline = Date.now() + wallClockMs;

  const state: RunState = { maxPages, pagesRead: 0, notRead: [], linksFound: new Map() };

  let seed: CleanPage;
  {
    let race: { timedOut: true } | { timedOut: false; value: CleanPage };
    try {
      race = await raceDeadline(
        fetchCleanPage(q.url, deps.cache, { fetchFn: deps.fetchFn, now: deps.now, audit: deps.audit, tool: FETCH_PAGE_TOOL_NAME, signal }),
        deadline,
      );
    } catch (e) {
      // A REAL fetch failure (SSRF refusal, http error, ...) — nothing was read at all, an
      // honest failure (throws; see Minor 4 — never a silent isError:false "report"). Contrast
      // the `timedOut` branch below, which the CRITICAL fix's own contract requires to RESOLVE.
      const message = e instanceof PageCoreError || e instanceof Error ? e.message : String(e);
      throw new Error(capText(`could not read the seed page ${q.url}: ${message}`));
    }
    if (race.timedOut) {
      return notReadReport("", state, `Research timed out before finishing (could not read the seed page ${q.url} in time)`);
    }
    seed = race.value;
  }
  state.pagesRead = 1;
  recordLinks(state, seed);

  const input: TurnInputItem[] = [{ type: "message", role: "user", content: buildSeedMessage(q, seed) }];

  let model: string = RESEARCH_MODEL;
  let usedFallback = false;
  let lastText = "";

  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (signal.aborted || Date.now() >= deadline) {
      return notReadReport(lastText, state, "Research timed out before finishing");
    }

    const iterator = deps.provider.streamTurn({
      model,
      instructions: RESEARCH_SYSTEM_PROMPT,
      input,
      tools: [FETCH_PAGE_TOOL],
      signal,
      reasoningEffort: RESEARCH_EFFORT,
    })[Symbol.asyncIterator]();

    let textBuf = "";
    const calls: Extract<ProviderEvent, { type: "tool_call" }>[] = [];
    let stop: "end_turn" | "tool_calls" | "aborted" | null = null;
    let roundError: Extract<ProviderEvent, { type: "error" }> | undefined;
    let hitDeadline = false;

    while (true) {
      const step = await nextWithDeadline(iterator, deadline);
      if (step.timedOut) { hitDeadline = true; break; }
      if (step.value.done) break;
      const ev = step.value.value;
      if (ev.type === "text_delta") textBuf += ev.delta;
      else if (ev.type === "tool_call") calls.push(ev);
      else if (ev.type === "done") { stop = ev.stopReason; break; }
      else if (ev.type === "error") { roundError = ev; break; }
      // reasoning_item/usage: deliberately ignored — no persistence, no hub, nothing to forward them to.
    }

    // fix-round-1 Minor 5: close this round's provider iterator so a well-behaved generator's own
    // `finally` block runs (the engine's real `for await` loop gets this for free; our hand-rolled
    // while-loop above does not, since it never calls `.next()` again after seeing done/error). The
    // hitDeadline case is the one exception: the `next()` we just abandoned may NEVER settle (a
    // stalled provider that ignores its signal), and `.return()` on an iterator with a pending
    // `.next()` waits for that `.next()` to settle first — awaiting it here would reintroduce
    // exactly the hang this whole fix removes. Every other exit means the last `.next()` already
    // settled, so `.return()` is safe to await.
    if (hitDeadline) {
      const r = iterator.return?.();
      if (r && typeof (r as Promise<unknown>).catch === "function") (r as Promise<unknown>).catch(() => {});
    } else {
      try { await iterator.return?.(); } catch { /* best-effort cleanup only */ }
    }

    if (hitDeadline || signal.aborted) {
      return notReadReport(lastText, state, "Research timed out before finishing");
    }

    // Captured BEFORE the roundError check below (fix-round-1 Minor 2) — a LATER round's failure
    // must not discard an EARLIER round's own assistant text (a partial answer beats none).
    if (textBuf) lastText = textBuf;

    if (roundError) {
      if (!usedFallback && looksLikeBadModelError(roundError, model)) {
        usedFallback = true;
        model = RESEARCH_FALLBACK_MODEL;
        continue; // retry the SAME round (input unchanged) with the fallback model
      }
      // fix-round-1 Minor 4: THROWS (rejects) rather than resolving with a failure-shaped string —
      // read-page.ts's own runResearch already catches a rejected research.run() and surfaces it as
      // an isError:true entry; resolving here made a failed run look like isError:false success.
      throw new Error(capText(failureMessage(lastText, `provider error (${roundError.code}): ${roundError.message}. Pages read: ${state.pagesRead}.${linksSummary(state)}`)));
    }

    if (stop !== "tool_calls" || calls.length === 0) {
      if (stop === "aborted") return notReadReport(lastText, state, "Research timed out before finishing");
      if (stop === null) {
        // fix-round-1 Minor 3: the provider's stream ended without ever emitting "done" — ambiguous
        // and, if `calls` is non-empty, previously SILENTLY DROPPED those pending tool calls while
        // reporting success. Now an honest failure that names what was pending, instead.
        throw new Error(capText(failureMessage(
          lastText,
          `the provider stream ended unexpectedly${calls.length ? ` with ${calls.length} tool call(s) left unresolved` : ""} (pages read: ${state.pagesRead}).`,
        )));
      }
      if (!lastText.trim()) {
        // fix-round-1 Minor 3: `[done end_turn]` with no text previously returned "" as a SUCCESS
        // report. An empty report is not a report.
        throw new Error(capText(`no report was produced — the model finished with no text (pages read: ${state.pagesRead}).`));
      }
      return capText(lastText); // model is done — its own text IS the report
    }

    if (textBuf) input.push({ type: "message", role: "assistant", content: textBuf });
    for (const call of calls) input.push({ type: "function_call", callId: call.callId, name: call.name, argsJson: call.argsJson });

    for (const call of calls) {
      if (call.name !== FETCH_PAGE_TOOL_NAME) {
        input.push({ type: "tool_result", callId: call.callId, output: `unknown tool: ${call.name} — only FetchPage is available in this run`, isError: true });
        continue;
      }
      let urls: string[];
      try {
        const raw: unknown = JSON.parse(call.argsJson || "{}");
        const parsed = FetchPageArgs.safeParse(raw);
        if (!parsed.success) {
          input.push({ type: "tool_result", callId: call.callId, output: "invalid FetchPage arguments — urls must be 1-8 non-empty strings", isError: true });
          continue;
        }
        urls = parsed.data.urls;
      } catch {
        input.push({ type: "tool_result", callId: call.callId, output: "invalid FetchPage arguments — could not parse JSON", isError: true });
        continue;
      }
      const output = await handleFetchPage(urls, state, deps, signal, deadline);
      input.push({ type: "tool_result", callId: call.callId, output, isError: false });
    }
  }

  // MAX_ROUNDS exhausted without a natural end_turn — the same truncated-report (resolved, not
  // thrown) shape as a timeout.
  return notReadReport(lastText, state, "Research stopped after reaching its round limit");
}

export function createResearchRunner(deps: ResearchDeps): ResearchRunner {
  return {
    run: (q, opts) => runResearch(q, deps, opts?.signal),
  };
}
