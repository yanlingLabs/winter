// ComputerV2 Phase 2 — the DANGEROUS-DOMAIN floor for browser tabs (both backends), on the old Browser's list and
// matcher (`checkDangerousDomain`, the user-added half resolved per project). Checked on the URL the model supplies
// (`browsers.open`, `goto`), on a tab's current URL when `browsers.tab` binds it, and on every committed top-frame
// navigation.
//
//   session policy                         a listed host
//   ask / accept-edits / plan              a daemon-raised card ("Allow Winter to use <host> in <browser>? It is on
//                                          the dangerous-domains list.", once / this session); a standing
//                                          `WebFetch(domain:…)` allow rule counts as the approval
//   auto / bypass / dont-ask, Dispatch     hard block (`NotAllowed`)
//   a Dispatch child                       its own policy's row (a card is relayed to Dispatch, bounded)
//
// After a committed navigation onto a listed host that is not approved, only back(), close(), url() and title() work
// on that tab until it navigates away.
import { checkDangerousDomain, type DangerousDomainMatch } from "../../agent/tools/page-core";
import { parseRule, ruleMatches } from "../../agent/permission-rules";
import { AutomationFailure } from "../errors";
import type { SessionFacts } from "../policy";
import type { TabRunScope } from "./tab-scope";

/** What a listed host meets in this session: a card, or a hard block. */
export function siteRow(facts: Pick<SessionFacts, "policy" | "mode">): "card" | "block" {
  if (facts.mode === "dispatch" || facts.mode === "chat") return "block";
  switch (facts.policy) {
    case "ask":
    case "accept-edits":
    case "plan":
      return "card";
    default:
      return "block";
  }
}

export function siteCardSummary(host: string, browserName: string): string {
  return `Allow Winter to use ${host} in ${browserName}? It is on the dangerous-domains list.`;
}

/** Does one of the user's saved allow rules (`WebFetch(domain:<host>)`) cover this URL? */
export function ruleAllowsSite(rules: readonly string[], url: string): boolean {
  const call = { name: "web_fetch", argsJson: JSON.stringify({ url }) };
  for (const raw of rules) {
    if (typeof raw !== "string") continue;
    const parsed = parseRule(raw);
    if (parsed !== null && parsed.tool === "web_fetch" && ruleMatches(parsed, call)) return true;
  }
  return false;
}

export interface SiteFloorDeps {
  /** The user-added half of the dangerous-domain list for a project (the daemon's own getter). */
  dangerousDomainsAdded?(cwd?: string): readonly string[] | undefined;
  /** The user's saved allow rules that apply at `cwd` (claude's grammar and Winter's — `WebFetch(domain:…)`). */
  savedAllowRules?(cwd?: string): readonly string[];
}

/** Per session: the hosts approved for the session, and for one run ("once"). */
export class SiteApprovals {
  private readonly session = new Map<string, Set<string>>();
  private readonly runs = new Map<string, Set<string>>();

  approved(sessionId: string, runId: string, host: string): boolean {
    return this.session.get(sessionId)?.has(host) === true || this.runs.get(`${sessionId}\u0000${runId}`)?.has(host) === true;
  }

  approve(sessionId: string, runId: string, host: string, scope: "once" | "session"): void {
    const key = scope === "session" ? sessionId : `${sessionId}\u0000${runId}`;
    const map = scope === "session" ? this.session : this.runs;
    let set = map.get(key);
    if (set === undefined) { set = new Set(); map.set(key, set); }
    set.add(host);
  }

  runEnded(sessionId: string, runId: string): void { this.runs.delete(`${sessionId}\u0000${runId}`); }

  sessionEnded(sessionId: string): void {
    this.session.delete(sessionId);
    for (const k of [...this.runs.keys()]) if (k.startsWith(`${sessionId}\u0000`)) this.runs.delete(k);
  }
}

export function listedHost(url: string, deps: SiteFloorDeps, cwd: string | undefined): DangerousDomainMatch | null {
  let added: readonly string[] = [];
  try { added = deps.dangerousDomainsAdded?.(cwd) ?? []; } catch { added = []; }
  return checkDangerousDomain(url, added);
}

/**
 * The floor for one URL: resolves when it may be used (not listed, or approved), throws `NotAllowed` otherwise —
 * after the site card under the policies that ask. `browserName` names the browser in the card.
 */
export async function ensureSiteAllowed(scope: TabRunScope, approvals: SiteApprovals, deps: SiteFloorDeps, url: string, browserName: string, cwd: string | undefined): Promise<void> {
  const match = listedHost(url, deps, cwd);
  if (match === null) return;
  const host = match.host;
  scope.noteSite(host);
  if (approvals.approved(scope.sessionId, scope.runId, host)) return;
  const facts = scope.sessionFacts();
  if (siteRow(facts) === "block") {
    const why = facts.mode === "dispatch" ? "Dispatch never asks" : facts.mode === "chat" ? "chat never asks" : `this session's ${facts.policy} policy does not ask`;
    throw new AutomationFailure("NotAllowed", `${host} is on the dangerous-domains list (${match.matchedEntry}), and ${why} — don't retry it; ask the user if they need it`);
  }
  let rules: readonly string[] = [];
  try { rules = deps.savedAllowRules?.(cwd) ?? []; } catch { rules = []; }
  if (ruleAllowsSite(rules, url)) return;
  const res = await scope.siteCard(siteCardSummary(host, browserName));
  scope.live();
  if (!res.approved) {
    throw new AutomationFailure("NotAllowed", `The user did not allow Winter to use ${host} (it is on the dangerous-domains list). Don't retry — ask the user what to do instead.`);
  }
  approvals.approve(scope.sessionId, scope.runId, host, res.optionId === "session" ? "session" : "once");
}

/** The primitives that still work on a tab sitting on an unapproved listed host. */
export const BLOCKED_TAB_PRIMITIVES: ReadonlySet<string> = new Set(["back", "close", "url", "title"]);
