import { createRequire } from "node:module";

export interface NativeScope {
  protocolVersion: 1;
  workspaceId: string;
  incarnationId: string;
  grantRevision: number;
  leaseEpoch: number;
}
export interface NativeEvent {
  scope: NativeScope;
  operationId: string;
  sequence: number;
  kind: "accepted" | "processRegistered" | "stdout" | "stderr" | "terminal";
  terminalStatus?: "completed" | "cancelled" | "failed" | "uncertain";
  code?: string;
  message?: string;
  dataBase64?: string;
  exitCode?: number;
  result?: Record<string, string>;
}
export type NativeOperationKind = "capabilities" | "start" | "exec" | "cancel" | "input" | "closeInput" | "stats" | "balloon" | "stop" | "shutdown";
interface AddonController {
  submit(json: string): bigint;
  subscribe(callback: (json: string) => void): void;
  close(): boolean;
}
export class NativeOperationError extends Error {
  constructor(readonly code: string, readonly operationId: string, readonly uncertain: boolean, message: string) {
    super(message); this.name = "NativeOperationError";
  }
}

/** Host-only adapter. Root authority/store code owns scope, launch policy and
 * task IDs; this class is never installed as a guest/model tool. */
export class NativeControllerClient {
  readonly scope: Readonly<NativeScope>;
  private readonly controller: AddonController;
  private readonly pending = new Map<string, { resolve: (event: NativeEvent) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private lastSequence = 0;
  private closed = false;
  private faulted = false;
  constructor(options: { addonPath: string; libraryPath: string; scope: NativeScope; backend?: "production" | "fake"; onEvent?: (event: NativeEvent) => void }) {
    if (![options.scope.grantRevision, options.scope.leaseEpoch].every(Number.isSafeInteger)) throw new Error("Native revisions/epochs must be exact safe integers");
    this.scope = Object.freeze({ ...options.scope });
    const addon = createRequire(import.meta.url)(options.addonPath);
    this.controller = addon.open(options.libraryPath, JSON.stringify({ backend: options.backend ?? "production", scope: this.scope }));
    this.controller.subscribe(json => {
      try {
        const event = JSON.parse(json) as NativeEvent;
        if (JSON.stringify(event.scope, Object.keys(this.scope).sort()) !== JSON.stringify(this.scope, Object.keys(this.scope).sort()) ||
            !Number.isSafeInteger(event.sequence) || event.sequence <= this.lastSequence || !/^\d+$/.test(event.operationId)) throw new Error("Native event scope/sequence differs from its registered owner");
        this.lastSequence = event.sequence;
        if (event.kind === "terminal") {
          const pending = this.pending.get(event.operationId);
          if (pending) {
            this.pending.delete(event.operationId); clearTimeout(pending.timer);
            if (event.terminalStatus === "completed" || event.terminalStatus === "cancelled") pending.resolve(event);
            else pending.reject(new NativeOperationError(event.code ?? "native_failed", event.operationId, event.terminalStatus === "uncertain", event.message ?? "Native operation failed"));
          }
        }
        options.onEvent?.(event); // Receives late terminal evidence too; never blindly replay it.
      } catch (error) {
        this.faulted = true;
        for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error instanceof Error ? error : new Error(String(error))); }
        this.pending.clear();
        try { this.controller.submit(JSON.stringify({ scope: this.scope, kind: "shutdown", stopBudgetMilliseconds: 30_000 })); } catch { /* Ownership stays unproven; no library unload. */ }
      }
    });
  }
  submit(kind: NativeOperationKind, fields: Record<string, unknown> = {}, timeoutMilliseconds = 30_000) {
    if (this.closed || this.faulted) throw new Error("Native controller is closed or its event channel faulted");
    const control = ["cancel", "input", "closeInput", "stop", "shutdown"].includes(kind);
    if (!control && this.pending.size >= 128) throw new Error("Native client request limit reached");
    const id = this.controller.submit(JSON.stringify({ ...fields, scope: this.scope, kind })).toString();
    if (id === "0") throw new NativeOperationError("native_capacity", id, false, "Native operation was not admitted; no work was started");
    const done = new Promise<NativeEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new NativeOperationError("native_timeout", id, true, "Native completion is unproven; the host timeout did not cancel backend work"));
      }, timeoutMilliseconds);
      this.pending.set(id, { resolve, reject, timer });
    });
    return { operationId: id, done };
  }
  async request(kind: NativeOperationKind, fields: Record<string, unknown> = {}, timeoutMilliseconds = 30_000) {
    return this.submit(kind, fields, timeoutMilliseconds).done;
  }
  async writeInput(ownerOperationId: string, taskId: string, bytes: Uint8Array) {
    if (bytes.byteLength > 16 * 1024) throw new Error("Native stdin chunk exceeds 16 KiB");
    // Callers serialize per-process input chunks by awaiting each acknowledgment.
    return this.request("input", { ownerOperationId, taskId, inputBase64: Buffer.from(bytes).toString("base64") });
  }
  async shutdown(budgetMilliseconds = 30_000) {
    await this.request("shutdown", { stopBudgetMilliseconds: budgetMilliseconds }, budgetMilliseconds + 1000);
    for (let i = 0; i < 1000; i++) {
      if (this.controller.close()) { this.closed = true; return; }
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    throw new NativeOperationError("release_owned", "", true, "Native controller remains owned after shutdown; preserve recovery state");
  }
}
