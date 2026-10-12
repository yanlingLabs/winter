/** Host-only adapter executor. Input is already decoded by the authenticated native helper;
 * no guest packet/socket parser, credentials or endpoint selection live on this service port. */
import type { CredentialMaterial, CredentialRef, ProviderContext, ProviderEvent, ResolvedModel, TurnRequest } from "@yanlinglabs/winter-provider-runtime";
import { credentialStoreOverSecretStore } from "../providers/credential-store";
import type { SecretStore } from "../auth/secret-store";

export const COWORK_PROVIDER_LIMITS = Object.freeze({ requestBytes: 2 * 1024 * 1024, eventBytes: 256 * 1024, turnBytes: 16 * 1024 * 1024, eventCount: 8192, activeTurns: 8, pullDeadlineMs: 5000, idleMs: 30_000, turnMs: 600_000 });
/** Captured from host admission, never from a guest/model/account selector. Backend ID is distinct from logical conversation ID. */
export interface CoworkProviderScope {
  homeId: string; workspaceId: string; sessionId: string; backendSessionId: string; taskId: string;
  incarnationId: string; bootId: string; leaseEpoch: number; grantRevision: number; accountRevision: number; modelRevision: number;
}
export interface CoworkProviderAdmission {
  scope: CoworkProviderScope; resolved: ResolvedModel;
  /** Host selected Keychain slot. Never serialized on the provider channel. */
  authRef: Extract<CredentialRef, { kind: "keychain" }>;
  connection: ProviderContext["connection"];
  /** Explicit host-service authority for user/local/private endpoint configurations. */
  endpointGrant?: boolean;
}
export interface CoworkProviderRequest {
  version: 1; operation: "begin" | "next" | "cancel"; invocationId: string;
  scope: CoworkProviderScope; sequence: number; turn?: Omit<TurnRequest, "signal">;
}
export type CoworkProviderResponse = { version: 1; invocationId: string; sequence: number; kind: "accepted" | "event" | "pending" | "closed" | "refused"; event?: ProviderEvent; code?: "authority_denied" | "provider_unavailable" | "effects_uncertain" | "limit" };
export interface CoworkProviderBrokerDeps {
  secrets: SecretStore;
  /** Revalidates canonical owner/boot/task delegation/grant and host selected account/model/destination. */
  assertCurrent(admission: Readonly<CoworkProviderAdmission>): void;
  /** Host auth service owns actual refresh; racing adapter requests share one refresh, never guest credentials. */
  refresh?(admission: Readonly<CoworkProviderAdmission>): Promise<void>;
  log?(event: { kind: "cowork_provider_activity"; providerId: string; model: string; bytes?: number }): void;
}
const TURN_FIELDS = new Set(["model", "system", "systemBlocks", "messages", "tools", "toolChoice", "effort", "thinking", "maxOutputTokens", "requestSummary", "cacheTtl", "cacheDiagnostics", "cacheKey", "allowedTools", "toolChanges", "resumesPausedTurn"]);
const SCOPE_FIELDS = ["homeId", "workspaceId", "sessionId", "backendSessionId", "taskId", "incarnationId", "bootId", "leaseEpoch", "grantRevision", "accountRevision", "modelRevision"] as const;
const EVENT_TYPES = new Set(["message_start", "text_delta", "thinking_summary_delta", "thinking_exposed_delta", "native_thinking_block", "reasoning_progress", "tool_call_start", "tool_call_delta", "tool_call_end", "native_state", "usage", "rate_limit", "retry", "auth_status", "done", "error"]);
const uuid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
function snapshot<T>(value: T, limit: number): T {
  const text = JSON.stringify(value);
  if (typeof text !== "string" || Buffer.byteLength(text) > limit) throw new Error("limit");
  return JSON.parse(text) as T;
}
function safeScope(value: CoworkProviderScope): CoworkProviderScope {
  if (!value || Object.keys(value).length !== SCOPE_FIELDS.length) throw new Error("authority_denied");
  for (const key of SCOPE_FIELDS) {
    const member = value[key];
    if (key.endsWith("Revision") || key === "leaseEpoch") { if (typeof member !== "number" || !Number.isSafeInteger(member) || member < 0) throw new Error("authority_denied"); }
    else if (typeof member !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(member)) throw new Error("authority_denied");
  }
  return Object.freeze({ ...value });
}
interface Turn { id: string; controller: AbortController; iterator: AsyncIterator<ProviderEvent>; next: number; bytes: number; events: number; pending?: Promise<IteratorResult<ProviderEvent>>; pulling?: boolean; retiring?: Promise<void>; failed: boolean; ended: boolean; idle?: ReturnType<typeof setTimeout>; deadline: ReturnType<typeof setTimeout> }
interface MaterialState { generation: number; material: CredentialMaterial | null; fingerprint: string; refresh?: Promise<CredentialMaterial> }
/** open() is a trusted host lifecycle method. Availability requires the native authenticated helper, not this JS shape. */
export class CoworkProviderBroker {
  private active = 0;
  private readonly materials = new Map<string, MaterialState>();
  constructor(private readonly deps: CoworkProviderBrokerDeps) {}
  open(value: CoworkProviderAdmission): { handle(request: CoworkProviderRequest): Promise<CoworkProviderResponse>; close(): void } {
    const admission: CoworkProviderAdmission = Object.freeze({ ...value, scope: safeScope(value.scope), authRef: Object.freeze({ ...value.authRef }), connection: Object.freeze(snapshot(value.connection, 16_384)), resolved: Object.freeze({ ...value.resolved }) });
    if (admission.authRef.kind !== "keychain" || admission.connection.providerId !== admission.resolved.providerId || !admission.resolved.providerModelId || (admission.connection.local || (admission.connection.baseUrl !== undefined && admission.connection.endpointOrigin !== "reviewed") || admission.resolved.adapter.family === "local-openai") && admission.endpointGrant !== true) throw new Error("authority_denied");
    this.deps.assertCurrent(admission);
    const store = credentialStoreOverSecretStore(this.deps.secrets), seen = new Set<string>(), secretStrings = new Set<string>();
    for (const header of Object.values(admission.connection.headers ?? {})) if (header) secretStrings.add(header);
    const slot = JSON.stringify(admission.authRef); let closed = false, turn: Turn | undefined, usedGeneration = -1;
    const remember = (material: CredentialMaterial | null): void => {
      if (!material) return;
      for (const [key, entry] of Object.entries(material)) if (["key", "token", "accessToken", "refreshToken", "idToken", "secretAccessKey", "sessionToken", "privateKeyPem"].includes(key) && typeof entry === "string" && entry) secretStrings.add(entry);
    };
    const read = async (): Promise<CredentialMaterial | null> => {
      this.deps.assertCurrent(admission); const material = await store.get(admission.authRef); this.deps.assertCurrent(admission); remember(material);
      const fingerprint = JSON.stringify(material); let state = this.materials.get(slot);
      if (!state) { state = { generation: 0, material, fingerprint }; this.materials.set(slot, state); }
      else if (state.fingerprint !== fingerprint) { state.generation++; state.fingerprint = fingerprint; state.material = material; }
      usedGeneration = state.generation; return material;
    };
    const credentials: ProviderContext["credentials"] = {
      get: async ref => { if (JSON.stringify(ref) !== slot) throw new Error("authority_denied"); return read(); },
      set: async () => { throw new Error("host_refresh_required"); }, delete: async () => { throw new Error("host_refresh_required"); },
      ...(this.deps.refresh ? { refresh: async (ref: Extract<CredentialRef, { kind: "keychain" }>): Promise<CredentialMaterial> => {
        if (JSON.stringify(ref) !== slot) throw new Error("authority_denied"); this.deps.assertCurrent(admission);
        const state = this.materials.get(slot); if (!state) throw new Error("provider_unavailable");
        if (state.generation > usedGeneration && state.material) { remember(state.material); return state.material; }
        state.refresh ??= (async () => { await this.deps.refresh!(admission); this.deps.assertCurrent(admission); const material = await read(); if (!material) throw new Error("provider_unavailable"); return material; })().finally(() => { state.refresh = undefined; });
        const material = await state.refresh; this.deps.assertCurrent(admission); remember(material); return material;
      } } : {}),
    };
    const ctx: ProviderContext = { connection: admission.connection, authRef: admission.authRef, credentials, stallTimeoutMs: 60_000, log: event => this.deps.log?.({ kind: "cowork_provider_activity", providerId: admission.resolved.providerId, model: admission.resolved.modelKey, ...(typeof event.bytes === "number" && Number.isFinite(event.bytes) ? { bytes: event.bytes } : {}) }) };
    const release = (current: Turn): void => {
      clearTimeout(current.deadline); if (current.idle) clearTimeout(current.idle);
      if (turn === current && !current.pending) { current.ended = true; turn = undefined; this.active--; }
    };
    const retire = (current: Turn): Promise<void> => {
      if (current.retiring) return current.retiring;
      current.controller.abort(); if (current.idle) clearTimeout(current.idle);
      const pending = current.pending;
      current.retiring = (async () => {
        if (pending) { try { await pending; } catch {} }
        if (!current.iterator.return) throw new Error("effects_uncertain");
        const cleanup = current.iterator.return(); current.pending = cleanup;
        const result = await cleanup; if (result.done !== true) throw new Error("effects_uncertain"); current.pending = undefined; release(current);
      })();
      // A failed/ignored finalizer retains admission/debt. No timer proves it gone.
      void current.retiring.catch(() => {}); return current.retiring;
    };
    const stop = (current: Turn): void => { current.failed = true; void retire(current); };
    const idle = (current: Turn): void => { if (current.idle) clearTimeout(current.idle); current.idle = setTimeout(() => stop(current), COWORK_PROVIDER_LIMITS.idleMs); current.idle.unref?.(); };
    const reply = (request: CoworkProviderRequest, kind: CoworkProviderResponse["kind"], fields: Partial<CoworkProviderResponse> = {}): CoworkProviderResponse => ({ version: 1, invocationId: uuid(request?.invocationId) ? request.invocationId : "00000000-0000-0000-0000-000000000000", sequence: Number.isSafeInteger(request?.sequence) && request.sequence >= 0 ? request.sequence : 0, kind, ...fields });
    return {
      close: () => { closed = true; if (turn) stop(turn); },
      handle: async request => {
        try {
          if (closed || !request || request.version !== 1 || !uuid(request.invocationId) || !Number.isSafeInteger(request.sequence) || request.sequence < 0 || SCOPE_FIELDS.some(key => safeScope(request.scope)[key] !== admission.scope[key]) || Object.keys(request).some(key => !["version", "operation", "invocationId", "scope", "sequence", "turn"].includes(key))) throw new Error("authority_denied");
          this.deps.assertCurrent(admission);
          if (request.operation === "begin") {
            if (request.sequence !== 0 || turn || this.active >= COWORK_PROVIDER_LIMITS.activeTurns || seen.has(request.invocationId) || seen.size >= 4096) throw new Error("authority_denied");
            const payload = snapshot(request.turn, COWORK_PROVIDER_LIMITS.requestBytes);
            if (!payload || Object.keys(payload).some(key => !TURN_FIELDS.has(key)) || payload.model !== admission.resolved.providerModelId || !Array.isArray(payload.messages) || payload.messages.length > 512 || payload.tools !== undefined && (!Array.isArray(payload.tools) || payload.tools.length > 128) || payload.maxOutputTokens !== undefined && (!Number.isSafeInteger(payload.maxOutputTokens) || payload.maxOutputTokens < 1 || payload.maxOutputTokens > 32_768)) throw new Error("authority_denied");
            const controller = new AbortController(); const iterator = admission.resolved.adapter.streamTurn({ ...payload, signal: controller.signal }, ctx)[Symbol.asyncIterator]();
            if (typeof iterator.return !== "function") throw new Error("provider_unavailable");
            const current: Turn = { id: request.invocationId, controller, iterator, next: 1, bytes: 0, events: 0, failed: false, ended: false, deadline: setTimeout(() => stop(current), COWORK_PROVIDER_LIMITS.turnMs) }; current.deadline.unref?.();
            turn = current; this.active++; seen.add(current.id); idle(current); return reply(request, "accepted");
          }
          const current = turn;
          if (!current || current.id !== request.invocationId || request.turn !== undefined || request.sequence !== current.next || current.failed || current.retiring || (current.pulling && request.operation !== "cancel")) throw new Error("authority_denied");
          current.next++;
          if (request.operation === "cancel") { stop(current); return reply(request, "closed", { code: "effects_uncertain" }); }
          if (request.operation !== "next") throw new Error("authority_denied");
          if (current.idle) clearTimeout(current.idle); current.pulling = true;
          const pending = current.pending ?? current.iterator.next(); current.pending = pending;
          let timeout: ReturnType<typeof setTimeout> | undefined;
          try {
            const waiting = Symbol("pending");
            const item = await Promise.race([pending, new Promise<typeof waiting>(resolve => { timeout = setTimeout(() => resolve(waiting), COWORK_PROVIDER_LIMITS.pullDeadlineMs); })]);
            if (timeout) clearTimeout(timeout); current.pulling = false;
            if (closed || current.failed) throw new Error("effects_uncertain"); this.deps.assertCurrent(admission);
            if (item === waiting) { idle(current); return reply(request, "pending"); }
            current.pending = undefined;
            if (closed || current.failed) throw new Error("effects_uncertain"); this.deps.assertCurrent(admission);
            if (item.done) { release(current); return reply(request, "closed"); }
            let event = item.value;
            if (!event || !EVENT_TYPES.has(event.type)) throw new Error("provider_unavailable");
            if (event.type === "error") event = { type: "error", error: { ...event.error, message: "host provider request failed", retryable: false } };
            if (event.type === "auth_status") event = { type: "auth_status", isAuthenticating: event.isAuthenticating };
            const copied = snapshot(event, COWORK_PROVIDER_LIMITS.eventBytes), serialized = JSON.stringify(copied);
            if ([...secretStrings].some(secret => serialized.includes(JSON.stringify(secret).slice(1, -1)))) throw new Error("provider_unavailable");
            current.bytes += Buffer.byteLength(serialized); current.events++;
            if (current.bytes > COWORK_PROVIDER_LIMITS.turnBytes || current.events > COWORK_PROVIDER_LIMITS.eventCount) throw new Error("limit");
            if (event.type === "done" || event.type === "error") {
              let drainDeadline: ReturnType<typeof setTimeout> | undefined;
              try { await Promise.race([retire(current), new Promise<never>((_, reject) => { drainDeadline = setTimeout(() => reject(new Error("effects_uncertain")), COWORK_PROVIDER_LIMITS.pullDeadlineMs); })]); }
              finally { if (drainDeadline) clearTimeout(drainDeadline); }
              if (closed || current.failed) throw new Error("effects_uncertain"); this.deps.assertCurrent(admission);
            } else idle(current);
            return reply(request, "event", { event: copied });
          } catch (error) {
            if (timeout) clearTimeout(timeout); current.pulling = false; stop(current);
            // Ignored cancellation never admits another turn until the exact
            // pending adapter operation settles. A timeout is no exit proof.

            throw error;
          }
        } catch (error) {
          if (turn) stop(turn);
          const code = error instanceof Error && ["authority_denied", "effects_uncertain", "limit"].includes(error.message) ? error.message as "authority_denied" | "effects_uncertain" | "limit" : "provider_unavailable";
          return reply(request, "refused", { code });
        }
      },
    };
  }
}
