import { CString, dlopen, FFIType, ptr } from "bun:ffi";

export interface NativeEvent {
  schema: number;
  opId: number;
  method?: string;
  status: "completed" | "failed";
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
}

/** Trusted probe client, not a model-facing tool surface. Native owns VZ queues. */
export class NativeClient {
  private library;
  private timer: ReturnType<typeof setInterval>;
  private pending = new Map<string, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  readonly events: NativeEvent[] = [];
  constructor(path: string) {
    this.library = dlopen(path, {
      winter_cowork_vm_abi_version: { args: [], returns: FFIType.u32 },
      winter_cowork_vm_submit: { args: [FFIType.ptr], returns: FFIType.u64 },
      winter_cowork_vm_poll: { args: [], returns: FFIType.ptr },
      winter_cowork_vm_string_free: { args: [FFIType.ptr], returns: FFIType.void },
    });
    if (this.library.symbols.winter_cowork_vm_abi_version() !== 1) throw new Error("unsupported native ABI");
    this.timer = setInterval(() => this.poll(), 10);
  }
  private poll(): void {
    for (let count = 0; count < 128; count++) {
      const pointer = this.library.symbols.winter_cowork_vm_poll();
      if (!pointer) return;
      let text: string;
      try { text = new CString(pointer).toString(); }
      finally { this.library.symbols.winter_cowork_vm_string_free(pointer); }
      const event = JSON.parse(text) as NativeEvent;
      this.events.push(event);
      const waiting = this.pending.get(String(event.opId));
      if (!waiting) continue; // Late timeout evidence remains in events; never reuse IDs.
      clearTimeout(waiting.timer);
      this.pending.delete(String(event.opId));
      if (event.status === "completed") waiting.resolve(event.result ?? {});
      else waiting.reject(new Error(`${event.error?.code ?? "native_error"}: ${event.error?.message ?? text}`));
    }
  }
  request(request: Record<string, unknown>, timeoutMs = 90_000): Promise<Record<string, unknown>> {
    const encoded = Buffer.from(JSON.stringify(request) + "\0");
    if (encoded.length > 64 * 1024) return Promise.reject(new Error("probe request too large"));
    const id = String(this.library.symbols.winter_cowork_vm_submit(ptr(encoded)));
    if (id === "0") return Promise.reject(new Error("native operation queue full"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`native operation ${request.method} timed out; completion/guest termination is unproven`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
  }
  /** Do not dlclose: native async tasks may still be unwinding on their own queues. */
  close(): void {
    clearInterval(this.timer);
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error("probe client closed")); }
    this.pending.clear();
  }
}
