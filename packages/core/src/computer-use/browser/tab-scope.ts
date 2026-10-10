// ComputerV2 Phase 2 — what the service hands the browser engine for ONE primitive of ONE script run
// (`service.ts`'s `tabScope`). Everything run-scoped the engine needs and nothing else: the run's identity and
// clock, its locks and grants, the result being built, the session's images and diff bases, and the audit notes.
// The engine never sees the service's RunCtx, the helper or another session's state.
import type { SessionApprovalPolicy } from "../../agent/gate";
import type { DiffBases } from "../diff-base";
import type { AppRef, SessionFacts } from "../policy";
import type { ResultBuilder } from "../result";
import type { PrimitiveMetric } from "../telemetry";
import type { ImageHandle } from "../worker/bridge";

export type TabAuthorizePurpose = { kind: "bind" } | { kind: "act"; primitive: string } | { kind: "observe" };

export interface TabRunScope {
  readonly sessionId: string;
  readonly runId: string;
  readonly callId: string;
  /** The session's model tag (the screenshot budget). */
  readonly model?: string;
  /** Does the model accept images? `false`: screenshot and Points are `NotAllowed`. */
  readonly vision: boolean;
  /** Aborts when the run is cancelled or ends. */
  readonly signal: AbortSignal;
  /** Throws `Cancelled` when the run has ended or been cancelled — call after every await. */
  live(): void;
  /** The ms this run has left (a card's wait does not count). */
  timeLeft(): number;
  /** A wait bounded by the run's time left. */
  clampWait(ms: number): number;
  /** Take `key` (a tab lock, `tab:<backendId>:<tabKey>`) for the rest of the run — a 30 s wait, then `TargetBusy`
   *  naming the holder. Re-entrant within the run. */
  lock(key: string, label: string): Promise<void>;
  /** The per-app policy for a user's browser (its bundle id): floors, access, the per-app card. */
  authorize(app: AppRef, purpose: TabAuthorizePurpose): Promise<void>;
  /** The session's approval policy, and its facts (mode, origin). */
  sessionPolicy(): SessionApprovalPolicy;
  sessionFacts(): SessionFacts;
  /** Raise the dangerous-domain site card (`once` / `session`) — the run's clock is paused while it waits. */
  siteCard(summary: string): Promise<{ approved: boolean; optionId?: string }>;
  /** Did the user allow this app for longer than this run (session/always grant, or bypass)? */
  persistentlyAllowed(bundleId: string): boolean;
  /** Is the app already allowed for this session — so using it raises no card now (a session/always grant, bypass,
   *  or an "Allow once" this run got)? */
  granted(bundleId: string): boolean;
  readonly builder: ResultBuilder;
  /** Store an image in the session's image store (the bytes stay in the daemon) and hand back its handle. */
  keepImage(img: { imageBase64: string; mime: string; width: number; height: number }): ImageHandle;
  /** The session's latest screenshot id per target (a Point is pixels in it). */
  readonly lastTargetShot: Map<string, string>;
  /** Targets this run acted on (state/screenshot settle after an act). */
  readonly acted: Set<string>;
  readonly diffBases: DiffBases;
  readonly metric: PrimitiveMetric;
  /** For the audit line: a site (host only) and a backend this run touched. */
  noteSite(host: string): void;
  noteBrowser(id: string): void;
  /** A failure sentence that is the daemon's own words (shown outside the DATA-ONLY fence when it escapes). */
  trusted(sentence: string): void;
}
