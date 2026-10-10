// The browser engine's test harness: the REAL engine, registry, policy, locks, diff bases and result builder, over FAKE
// backends (`browser-fake-transport.ts`) — one built-in ("winter") and one user browser ("chrome", Google Chrome).
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NewSessionEvent } from "@yanlinglabs/winter-protocol";
import { ApprovalBroker } from "../../src/agent/approvals";
import type { SessionApprovalPolicy } from "../../src/agent/gate";
import { BrowserEngine } from "../../src/computer-use/browser/engine";
import { BrowserBackendRegistry } from "../../src/computer-use/browser/registry";
import type { TabRunScope } from "../../src/computer-use/browser/tab-scope";
import { DiffBases } from "../../src/computer-use/diff-base";
import { TargetLocks } from "../../src/computer-use/locks";
import { ComputerPolicy, newRunGrants, type SessionFacts } from "../../src/computer-use/policy";
import { ResultBuilder } from "../../src/computer-use/result";
import type { PrimitiveMetric } from "../../src/computer-use/telemetry";
import type { Settings } from "../../src/settings";
import { FakeCdpTransport } from "./browser-fake-transport";

export interface HarnessOpts {
  policy?: SessionApprovalPolicy;
  facts?: Partial<SessionFacts>;
  /** Answer each card: the option id, or false to deny; undefined leaves it pending. */
  answer?: (summary: string) => string | false | undefined;
  apps?: Record<string, unknown>;
  dangerousAdded?: string[];
  savedRules?: string[];
  vision?: boolean;
  installed?: string[];
}

export function harness(o: HarnessOpts = {}) {
  const home = mkdtempSync(join(tmpdir(), "winter-browser-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "winter-browser-cwd-"));
  const tmp = mkdtempSync(join(tmpdir(), "winter-browser-tmp-"));
  mkdirSync(join(cwd, "sub"), { recursive: true });
  const registry = new BrowserBackendRegistry();
  const winter = new FakeCdpTransport("winter", "winter");
  const chrome = new FakeCdpTransport("chrome", "chrome");
  const winterReg = registry.register(winter, { family: "winter", name: "Winter (built-in)", instanceKey: "winter" });
  const chromeReg = registry.register(chrome, { family: "chrome", name: "Google Chrome", bundleId: "com.google.Chrome", instanceKey: "chrome-instance-1" });
  const panel = new Map<string, Array<{ tabId: string; url?: string; title?: string }>>();
  const closedWinter: Array<{ sessionId: string; tabId: string }> = [];
  let nextPanel = 1;
  const settings = { computerUse: { apps: o.apps ?? {} } } as unknown as Settings;
  const facts: SessionFacts = { policy: o.policy ?? "bypass", mode: "code", ...o.facts };
  const approvals = new ApprovalBroker();
  const cards: Array<Extract<NewSessionEvent, { type: "approval_requested" }>> = [];
  const policy = new ComputerPolicy({
    settings: () => settings,
    saveAlwaysGrant: () => {},
    approvals,
    emit: (_sid, e) => {
      if (e.type !== "approval_requested") return;
      const card = e as Extract<NewSessionEvent, { type: "approval_requested" }>;
      cards.push(card);
      const a = o.answer?.(card.summary);
      if (a === undefined) return;
      queueMicrotask(() => approvals.resolve(card.sessionId, card.callId, a !== false, "test", a === false ? undefined : a));
    },
    session: () => facts,
    attended: () => true,
  });
  const stops: Array<{ sessionId: string; reason: string }> = [];
  const engine = new BrowserEngine({
    registry,
    mintWinterTab: (sid, url) => {
      const tabId = `w${nextPanel++}`;
      const list = panel.get(sid) ?? [];
      list.push({ tabId, ...(url === undefined ? {} : { url }) });
      panel.set(sid, list);
      return tabId;
    },
    winterTabClosed: (sessionId, tabId) => {
      closedWinter.push({ sessionId, tabId });
      panel.set(sessionId, (panel.get(sessionId) ?? []).filter((t) => t.tabId !== tabId));
    },
    winterTabs: (sid) => ({ tabs: (panel.get(sid) ?? []).map((t) => ({ ...t, url: winter.tabs.get(t.tabId)?.page.url ?? t.url })) }),
    sessionInfo: () => ({ cwd, title: "Test session" }),
    site: { dangerousDomainsAdded: () => o.dangerousAdded ?? [], savedAllowRules: () => o.savedRules ?? [] },
    home,
    uploadRoots: () => ({ tmpDir: tmp, denyRead: [join(cwd, "secret")] }),
    installed: (b) => (o.installed ?? []).includes(b),
    persistentlyAllowed: (sid, b) => policy.persistentlyAllowed(sid, b),
    stopScript: (sessionId, reason) => stops.push({ sessionId, reason }),
  });
  const locks = new TargetLocks();
  const diffBases = new DiffBases();
  const images = new Map<string, { data: string }>();
  const lastTargetShot = new Map<string, string>();

  /** One script run's scope (a run id, its grants, its builder, its locks). */
  const run = (sessionId = "s1", runId = `run_${Math.random().toString(16).slice(2, 8)}`) => {
    const builder = new ResultBuilder();
    const abort = new AbortController();
    const held = new Map<string, () => void>();
    const grants = newRunGrants(sessionId);
    const acted = new Set<string>();
    const metric: PrimitiveMetric = { ts: 0, sessionId, callId: "cv2_test", primitive: "x", ms: 0, helperMs: 0 };
    const sites = new Set<string>();
    const browsers = new Set<string>();
    const scope: TabRunScope = {
      sessionId, runId, callId: "cv2_test", vision: o.vision ?? true, signal: abort.signal,
      live: () => { if (abort.signal.aborted) throw new Error("ended"); },
      timeLeft: () => 30_000, clampWait: (ms) => Math.min(ms, 30_000),
      lock: async (key, label) => {
        if (held.has(key)) return;
        held.set(key, await locks.acquire(key, { runId, sessionId }, { waitMs: 200, label, signal: abort.signal }));
      },
      authorize: (app, purpose) => policy.authorize(grants, app, purpose, abort.signal),
      sessionPolicy: () => facts.policy,
      sessionFacts: () => facts,
      siteCard: (summary) => policy.siteCard(grants, summary, abort.signal),
      persistentlyAllowed: (b) => policy.persistentlyAllowed(sessionId, b),
      builder, lastTargetShot, acted, diffBases, metric,
      keepImage: (img) => { const id = `img${images.size + 1}`; images.set(id, { data: img.imageBase64 }); return { image: id, width: img.width, height: img.height }; },
      noteSite: (h) => sites.add(h), noteBrowser: (b) => browsers.add(b), trusted: () => {},
    };
    const end = (): void => {
      abort.abort();
      for (const r of held.values()) r();
      held.clear();
      engine.runEnded(sessionId, runId);
    };
    const text = (): string => builder.build().content.map((c) => (c.type === "text" ? c.text : "[image]")).join("");
    return { scope, builder, end, text, metric, sites, browsers, grants };
  };
  return { engine, registry, winter, chrome, winterReg, chromeReg, panel, closedWinter, cards, approvals, run, locks, diffBases, home, cwd, tmp, facts, stops, policy };
}
