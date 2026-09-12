import { randomBytes } from "node:crypto";
import type { NewSessionEvent } from "@winter/protocol";
import type { AuditLog } from "./audit";

// ---------------------------------------------------------------------------------------------
// Verb → consent-class table (spec §5, Phase 4c). Exactly one class exists in Phase 4: "battery"
// (setChargeLimit/getChargeLimit, the XPC helper's SMC charge-limit verbs). Fan-curve verbs are a
// later phase's addition to this table, not this file's concern today.
//
// `verbClass` is the SINGLE SOURCE OF TRUTH consumed by TWO callers: this broker's own
// request()'s defense-in-depth unknown-verb check (reachable directly by hardware.test.ts's unit
// tests, which never go through the ipc layer at all), and the ipc handler's plugin-consent gate
// (ipc/server.ts's hardware.request case — it needs the class BEFORE it can check
// `permissions.hardware.includes(cls)`, since a manifest's permission list is keyed by CLASS, not
// by individual verb name).
// ---------------------------------------------------------------------------------------------

export type HardwareClass = "battery";

const VERB_CLASSES: Record<string, HardwareClass> = {
  setChargeLimit: "battery",
  getChargeLimit: "battery",
};

/** `null` = unknown verb, typed-rejected (never a raw protocol error) by both this broker and the
 *  ipc consent gate. */
export function verbClass(verb: string): HardwareClass | null {
  return VERB_CLASSES[verb] ?? null;
}

// ---------------------------------------------------------------------------------------------
// HardwareBroker — thin, injectable plumbing around request/respond correlation. Mirrors
// PeripheralBroker's call()/respond() mechanics in peripheral/broker.ts EXACTLY (pending map,
// injectable timeout, delete-then-resolve, never throws across the public surface) — the only
// structural difference is there is no lease to validate first: a hardware verb call isn't gated
// by a lease, it's gated by plugin consent, which lives ONE LAYER UP in the ipc handler (see
// ipc/server.ts's hardware.request case). This broker never touches PluginStore or any consent
// state at all — its constructor deps are deliberately narrower than PeripheralBroker's (no
// `policy`, no `emitTransient`; just `audit` + `pushToProvider` + an optional `timeoutMs`).
// ---------------------------------------------------------------------------------------------

export type HardwareRequester = { kind: "plugin" | "harness"; id: string };

/** Task 2 review pin (binding): a typed RESULT UNION, not RpcFailure — mirrors
 *  `PeripheralLeaseResult` (packages/protocol/src/methods.ts). This local TS union is kept
 *  independent of the protocol zod schema (same precedent as PeripheralBroker's own
 *  LeaseResult/CallResult types not importing their protocol counterparts) — coverage that the
 *  two stay in sync lives in the tests, not the type system. */
export type HardwareRequestError =
  | { code: "unknown_verb" }
  | { code: "consent_denied"; missing?: string }
  | { code: "no_provider"; message: string }
  | { code: "timeout" }
  | { code: "provider_error"; message: string };

export type HardwareRequestResult = { resultJson: string } | HardwareRequestError;

export type HardwareRespondResult = { ok: true };

interface PendingHardwareRequest {
  resolve: (r: HardwareRequestResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface HardwareBrokerDeps {
  audit: AuditLog;
  /** Push a `hardware_requested` event directly to the active provider connection (Winter.app) —
   *  bypasses session attachment entirely, mirrors `PeripheralBrokerDeps.pushToProvider` EXACTLY.
   *  daemon.ts wires BOTH brokers to the SAME `ProviderLink` instance
   *  (`pushToProvider: (event) => providerLink.push(event)`) — the app's one provider connection
   *  doubles as the hardware provider. Returns false when there is no provider connection to
   *  deliver to (npm-only install, or Winter.app not running/not yet advertised). */
  pushToProvider: (event: NewSessionEvent) => boolean;
  /** Per-call round-trip timeout to the provider (spec-fixed at 10000ms via
   *  WINTER_HARDWARE_TIMEOUT_MS; overridable here only so tests don't have to wait out a real 10s
   *  — mirrors PeripheralBrokerDeps.callTimeoutMs / ApprovalBroker/PlanBroker/BashReviewer's own
   *  constructor-overridable timeouts elsewhere in this codebase). */
  timeoutMs?: number;
}

export class HardwareBroker {
  private pending = new Map<string, PendingHardwareRequest>();
  private readonly timeoutMs: number;

  constructor(private readonly deps: HardwareBrokerDeps) {
    this.timeoutMs = deps.timeoutMs ?? Number(process.env.WINTER_HARDWARE_TIMEOUT_MS ?? 10_000);
  }

  /** Route one hardware verb call to the active provider connection and await its
   *  `hardware.respond` answer (or the timeout). `unknown_verb` (verbClass(req.verb) is null) and
   *  `no_provider` (deps.pushToProvider returned false) are both resolved SYNCHRONOUSLY, before
   *  any promise/timer is created — same immediate short-circuit shape as
   *  PeripheralBroker.call()'s pre-checks. Every settled outcome — unknown_verb, no_provider,
   *  timeout, or a respond()-triggered success/provider_error — is audited exactly once, as a
   *  single combined `{kind:"hardware", verb, requester, outcome}` line (see `auditHardware`). */
  async request(req: { requester: HardwareRequester; verb: string; argsJson?: string }): Promise<HardwareRequestResult> {
    if (!verbClass(req.verb)) {
      const outcome: HardwareRequestResult = { code: "unknown_verb" };
      this.auditHardware(req.verb, req.requester, outcome);
      return outcome;
    }

    const requestId = `hwreq_${randomBytes(6).toString("hex")}`;
    const event: NewSessionEvent = {
      type: "hardware_requested",
      // Neither a plugin nor a harness/dev requester is a session — sessionId/threadId are pure
      // correlation filler here, same precedent as PluginToolInvokeEvent (plugins/supervisor.ts
      // sets `sessionId: pluginId, threadId: "main"` for the exact same reason). Never read back
      // for session-attach replay: this event is TRANSIENT and targeted at one connection via
      // pushToProvider, not broadcast through SessionHub.
      sessionId: req.requester.id, threadId: "main",
      requestId, verb: req.verb, argsJson: req.argsJson ?? "",
    };

    const result = new Promise<HardwareRequestResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        const outcome: HardwareRequestResult = { code: "timeout" };
        this.auditHardware(req.verb, req.requester, outcome);
        resolve(outcome);
      }, this.timeoutMs);
      this.pending.set(requestId, {
        resolve: (r) => { this.auditHardware(req.verb, req.requester, r); resolve(r); },
        timer,
      });
    });

    const delivered = this.deps.pushToProvider(event);
    if (!delivered) {
      const p = this.pending.get(requestId);
      if (p) { clearTimeout(p.timer); this.pending.delete(requestId); }
      const outcome: HardwareRequestResult = { code: "no_provider", message: "hardware features require Winter.app" };
      this.auditHardware(req.verb, req.requester, outcome);
      return outcome;
    }
    return result;
  }

  /** Provider's answer to a `hardware_requested` push — resolves the matching pending call (first
   *  response wins, mirrors ApprovalBroker/PlanBroker/PeripheralBroker). A late/duplicate/unknown
   *  `requestId` is a silent no-op, never an error — same tolerance as PeripheralBroker.respond().
   *  `error` set (regardless of `resultJson`) means the call failed with a provider-side typed
   *  error, passed through verbatim as `provider_error`. */
  respond(req: { requestId: string; resultJson?: string; error?: string }): HardwareRespondResult {
    const p = this.pending.get(req.requestId);
    if (!p) return { ok: true };
    this.pending.delete(req.requestId);
    clearTimeout(p.timer);
    if (req.error !== undefined) {
      p.resolve({ code: "provider_error", message: req.error });
    } else {
      p.resolve({ resultJson: req.resultJson ?? "" });
    }
    return { ok: true };
  }

  /** Audit a denied hardware request (consent gate rejection before broker.request() is called).
   *  Writes the same uniform `{kind:"hardware", verb, requester, outcome}` shape as the broker's
   *  internal auditHardware method — used by the ipc consent handler (ipc/server.ts's
   *  hardware.request case) on its two `"consent_denied"` early-return paths: the plugin's manifest
   *  doesn't declare the permission class the verb needs, or it does but the plugin hasn't been
   *  granted "hardware" consent yet. `code: "unknown_verb"` is accepted here for API completeness
   *  (and so it's directly testable) but is never actually reached from the ipc handler — an
   *  unrecognized verb never gets this far in the first place, because `request()` above checks
   *  `verbClass(req.verb)` itself and self-audits the `unknown_verb` outcome via `auditHardware`
   *  before this method would ever be called for it. */
  auditDenied(req: { requester: HardwareRequester; verb: string; code: "consent_denied" | "unknown_verb"; missing?: string }): void {
    const outcome: HardwareRequestError =
      req.code === "consent_denied"
        ? { code: "consent_denied", ...(req.missing && { missing: req.missing }) }
        : { code: "unknown_verb" };
    this.deps.audit.append({ kind: "hardware", verb: req.verb, requester: req.requester, outcome });
  }

  private auditHardware(verb: string, requester: HardwareRequester, outcome: HardwareRequestResult): void {
    this.deps.audit.append({ kind: "hardware", verb, requester, outcome });
  }
}
