import type { Provider, ProviderEvent, TurnRequest } from "./types";

export type QuotaState = { kind: "ok" } | { kind: "limited"; resumeAt: number };

export class QuotaManager {
  private readonly maxConcurrent: number;
  readonly maxRetries: number;
  private active = 0;
  private waiters: (() => void)[] = [];
  private limitedUntil = 0;
  private listeners: ((s: QuotaState) => void)[] = [];
  private totals = { inputTokens: 0, outputTokens: 0 };
  /** P8d-13's carry item: R6-B `rate_limit`/`kind:"subscription-quota"` info (`{info: Record<string,
   *  unknown>}`, provider-runtime's own shape — Winter reports it verbatim, never re-shapes it) from
   *  the codex adapter (`runtime-provider.ts`'s `translateEvents`). Distinct from `limitedUntil`
   *  above on purpose: an HTTP 429 (`noteRateLimit`) is a concrete backoff deadline this manager
   *  ENFORCES (`waitIfLimited` blocks the next `streamTurn` on it); a subscription-quota frame is
   *  informational — the provider is not refusing anything, it is reporting how much of the
   *  account's window is left — so it is exposed for a future status view to read and never feeds
   *  `waitIfLimited`. */
  private lastSubscriptionQuota: { info: Record<string, unknown>; at: number } | undefined;

  constructor(opts: { maxConcurrent?: number; maxRetries?: number } = {}) {
    this.maxConcurrent = opts.maxConcurrent ?? 4;
    this.maxRetries = opts.maxRetries ?? 3;
  }

  state(): QuotaState {
    return Date.now() < this.limitedUntil ? { kind: "limited", resumeAt: this.limitedUntil } : { kind: "ok" };
  }
  onStateChange(cb: (s: QuotaState) => void): () => void {
    this.listeners.push(cb);
    return () => { this.listeners = this.listeners.filter((l) => l !== cb); };
  }
  private emit(): void { const s = this.state(); for (const l of this.listeners) l(s); }

  noteRateLimit(retryAfterMs: number): void {
    this.limitedUntil = Math.max(this.limitedUntil, Date.now() + retryAfterMs);
    this.emit();
  }
  noteRecovered(): void {
    if (this.limitedUntil === 0) return; // already ok — don't spam listeners
    this.limitedUntil = 0;
    this.emit();
  }

  accumulate(inputTokens: number, outputTokens: number): void {
    this.totals.inputTokens += inputTokens;
    this.totals.outputTokens += outputTokens;
  }
  usage(): { inputTokens: number; outputTokens: number } { return { ...this.totals }; }

  /** Records the LATEST subscription-quota snapshot the provider has reported — never merged or
   *  accumulated with a previous one (it's a point-in-time reading of the account's own remaining
   *  window, not a delta). */
  noteSubscriptionQuota(info: Record<string, unknown>): void {
    this.lastSubscriptionQuota = { info, at: Date.now() };
  }
  subscriptionQuota(): { info: Record<string, unknown>; at: number } | undefined {
    return this.lastSubscriptionQuota ? { ...this.lastSubscriptionQuota } : undefined;
  }

  async acquire(): Promise<void> {
    if (this.active < this.maxConcurrent) { this.active++; return; }
    await new Promise<void>((r) => this.waiters.push(r));
    this.active++;
  }
  release(): void {
    this.active--;
    this.waiters.shift()?.();
  }

  async waitIfLimited(signal?: AbortSignal): Promise<void> {
    const wait = this.limitedUntil - Date.now();
    if (wait <= 0) return;
    if (signal?.aborted) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, wait);
      const onAbort = () => done();
      function done() { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); resolve(); }
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

/** Wrap a provider with concurrency capping, rate-limit backoff and usage accounting. */
export function withQuota(provider: Provider, q: QuotaManager): Provider {
  return {
    id: provider.id,
    models: () => provider.models(),
    async *streamTurn(req: TurnRequest): AsyncIterable<ProviderEvent> {
      for (let attempt = 0; ; attempt++) {
        await q.waitIfLimited(req.signal);
        await q.acquire();
        let rateLimited: ProviderEvent | null = null;
        let yieldedAny = false;
        try {
          for await (const e of provider.streamTurn(req)) {
            if (e.type === "usage") q.accumulate(e.inputTokens, e.outputTokens);
            if (e.type === "error" && e.code === "rate_limit" && attempt < q.maxRetries && !yieldedAny) {
              rateLimited = e;
              break; // retry outside the slot
            }
            yieldedAny = true;
            yield e;
          }
        } finally {
          q.release();
        }
        if (!rateLimited) { q.noteRecovered(); return; }
        const base = (rateLimited.type === "error" ? rateLimited.retryAfterMs : undefined) ?? 1000 * 2 ** attempt;
        q.noteRateLimit(base + Math.floor(Math.random() * 250)); // jitter
      }
    },
  };
}
