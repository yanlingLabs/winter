import { z } from "zod";
import type { ToolRegistry } from "./registry";

export function registerToolSearchTool(r: ToolRegistry): void {
  r.register({
    name: "ToolSearch",
    description:
      "Load deferred tools' schemas so they can be called. Deferred tools are listed by name in the instructions — until loaded, they cannot be invoked. " +
      'Query forms: "select:name1,name2" loads those exact tools; otherwise keywords match name+description ("+term" requires the term). ' +
      "Loaded schemas are returned and the tools become callable from the next step on.",
    args: z.object({
      query: z.string().min(1),
      maxResults: z.number().int().positive().max(20).optional(),
    }),
    run({ query, maxResults }, ctx) {
      // D1-T2: `ctx.mode` — the engine now sets this on every ToolContext it builds (executeCall's
      // ctx literal, engine.ts). Without it, an array-valued `deferred` fails closed to "deferred"
      // for every mode (registry.ts's isDeferred doc comment) — this call would then list e.g.
      // `bash` as loadable from a CODE session too, even though it's already immediate there.
      const rawIndex = r.deferredIndex(ctx.cwd, ctx.loadedTools, ctx.deferThreshold, ctx.builtinDeferral, ctx.deferExternals, ctx.mode);
      // D1-T3: `ctx.mode` above only resolves an ARRAY-valued `deferred` (e.g. bash's
      // `deferred: ["dispatch"]`) — a builtin registered bare `deferred: true` (web_search,
      // web_fetch, every lsp tool, skill_write, notebook_edit — all CODE-only via their own
      // `modes`) rides deferral in EVERY mode regardless of `mode`, so `rawIndex` still lists it for
      // a dispatch/chat session even though that session's `namesForMode`-derived allowlist would
      // never have offered it. Filter with the EXACT allow/exclude semantics runThread's own
      // `offered()` predicate uses (engine.ts) — composing WITH the mode narrowing above, not
      // replacing it: a tool can be excluded from `index` either because this mode never defers it
      // (rawIndex already dropped it) or because this thread's allowTools/excludeTools never
      // offered it at all (this filter). Both `ctx.allowTools`/`ctx.excludeTools` absent (any
      // caller predating this task, e.g. a direct registry.execute() in a unit test) is a no-op —
      // byte-identical to before.
      const index = rawIndex.filter((e) => !ctx.excludeTools?.has(e.name) && (!ctx.allowTools || ctx.allowTools.has(e.name)));
      let matches: Array<{ name: string; description: string }>;
      if (query.startsWith("select:")) {
        const wanted = query.slice("select:".length).split(",").map((s: string) => s.trim()).filter(Boolean);
        matches = index.filter((e) => wanted.includes(e.name));
      } else {
        const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
        const required = tokens.filter((t: string) => t.startsWith("+")).map((t: string) => t.slice(1)).filter(Boolean);
        const rest = tokens.filter((t: string) => !t.startsWith("+"));
        matches = index
          .map((e) => {
            const hay = `${e.name} ${e.description}`.toLowerCase();
            if (!required.every((t: string) => hay.includes(t))) return null;
            const hits = rest.filter((t: string) => hay.includes(t)).length + required.length;
            return hits > 0 ? { e, hits } : null;
          })
          .filter((m): m is { e: { name: string; description: string }; hits: number } => m !== null)
          .sort((a, b) => b.hits - a.hits)
          .slice(0, maxResults ?? 5)
          .map((m) => m.e);
      }
      if (matches.length === 0) {
        const near = index.slice(0, 3).map((e) => e.name).join(", ");
        return `no deferred tools matched "${query}".${near ? ` Deferred tools include: ${near}. Try select:<name> or different keywords.` : " Nothing is currently deferred."}`;
      }
      const lines = matches.map((e) => {
        ctx.markToolLoaded?.(e.name);
        return JSON.stringify(r.specFor(e.name, ctx.cwd));
      });
      return `Loaded ${matches.length} tool(s) — now callable from your next step:\n${lines.join("\n")}`;
    },
  });
}
