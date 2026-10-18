import { loadCatalog, type WinterModelDescriptor } from "@yanlinglabs/winter-provider-catalog";
import { estimateCostUsd } from "@yanlinglabs/winter-provider-runtime";

// Pricing for the usage DB (`docs/claude/usage.md`): the SAME catalog and the SAME price function the Winter runtime
// prices a generation with (`@yanlinglabs/winter-provider-runtime`'s `estimateCostUsd` over the pinned catalog's
// `pricing` evidence — only `official-doc` evidence prices; anything else is "unknown", never a guess).
//
// Used for what the runtime did NOT price: a subscription row's tokens (codex-oauth — priced at its API twin,
// `openai/<model>`), and the Codex CLI's and Claude Code's usage. Every such figure is a LIST-PRICE ESTIMATE: a
// subscription is not billed per token, so the number says what the same tokens would cost on the API.

/** Tokens in Winter's normalized shape: `input` EXCLUDES cache reads and writes (they are their own fields). */
export interface NormalizedUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** The one-hour-lifetime SUBSET of `cacheWrite` (Anthropic prices it at 2× input). */
  cacheWrite1h?: number;
}

export interface PriceAnswer {
  costUsd: number;
  /** What the cache reads saved against the same tokens at the full input price. */
  cacheSavingsUsd: number;
  /** The catalog row that priced it. */
  model: string;
}

/** The API twin a subscription or app provider is priced at. */
const TWIN_PROVIDER: Readonly<Record<string, string>> = {
  "codex-oauth": "openai",
  codex: "openai",
  openai: "openai",
  "claude-code": "anthropic",
  anthropic: "anthropic",
  console: "anthropic",
};

export class UsagePricer {
  private readonly byProvider = new Map<string, Map<string, WinterModelDescriptor>>();
  private readonly byKey = new Map<string, WinterModelDescriptor>();

  constructor(models: readonly WinterModelDescriptor[] = loadCatalog().models) {
    for (const m of models) {
      this.byKey.set(m.key, m);
      let names = this.byProvider.get(m.providerId);
      if (names === undefined) { names = new Map(); this.byProvider.set(m.providerId, names); }
      names.set(m.upstreamId, m);
      for (const alias of m.aliases ?? []) if (!names.has(alias)) names.set(alias, m);
    }
  }

  /** The catalog row a `provider` + `model` names: the exact key, the provider's upstream id or alias, the twin
   *  provider's, then (Anthropic ids only) a dated id without its date and dashed versions as dotted. */
  descriptorFor(provider: string | undefined, model: string): WinterModelDescriptor | undefined {
    if (model.includes("/")) {
      const exact = this.byKey.get(model);
      if (exact?.pricing !== undefined) return exact;
      const slash = model.indexOf("/");
      return this.descriptorFor(model.slice(0, slash), model.slice(slash + 1));
    }
    const candidates: string[] = [];
    if (provider !== undefined) candidates.push(provider);
    const twin = provider === undefined ? undefined : TWIN_PROVIDER[provider];
    if (twin !== undefined && !candidates.includes(twin)) candidates.push(twin);
    const names = [model];
    if (twin === "anthropic" || provider === "anthropic") {
      const undated = model.replace(/-\d{8}$/, "");
      if (undated !== model) names.push(undated);
      // `claude-opus-4-5` → `claude-opus-4.5` (the catalog's spelling); the alias table covers most, this the rest.
      const dotted = undated.replace(/-(\d+)-(\d+)$/, "-$1.$2");
      if (!names.includes(dotted)) names.push(dotted);
    }
    for (const p of candidates) {
      const table = this.byProvider.get(p);
      if (table === undefined) continue;
      for (const name of names) {
        const d = table.get(name);
        if (d?.pricing !== undefined) return d;
      }
    }
    return undefined;
  }

  /** The list price of `usage` on `model`, or undefined when the catalog has no official price for it. */
  price(provider: string | undefined, model: string, usage: NormalizedUsage): PriceAnswer | undefined {
    const descriptor = this.descriptorFor(provider, model);
    if (descriptor === undefined) return undefined;
    const est = estimateCostUsd({
      inputTokens: usage.input, outputTokens: usage.output, cacheReadTokens: usage.cacheRead, cacheWriteTokens: usage.cacheWrite,
      ...(usage.cacheWrite1h === undefined ? {} : { cacheWrite1hTokens: usage.cacheWrite1h }),
    }, descriptor);
    if (est.costBasis !== "list") return undefined;
    return { costUsd: est.costUsd, cacheSavingsUsd: this.cacheSavings(descriptor, usage.cacheRead), model: descriptor.key };
  }

  /** What `cacheRead` tokens saved on `model` (same price function, the reads priced as plain input instead). */
  savingsFor(provider: string | undefined, model: string, cacheRead: number): number {
    const d = this.descriptorFor(provider, model);
    return d === undefined ? 0 : this.cacheSavings(d, cacheRead);
  }

  private cacheSavings(descriptor: WinterModelDescriptor, cacheRead: number): number {
    if (cacheRead <= 0) return 0;
    const asInput = estimateCostUsd({ inputTokens: cacheRead, outputTokens: 0 }, descriptor).costUsd;
    const asRead = estimateCostUsd({ inputTokens: 0, outputTokens: 0, cacheReadTokens: cacheRead }, descriptor).costUsd;
    return Math.max(0, asInput - asRead);
  }
}
