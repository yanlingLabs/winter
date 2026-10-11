// ComputerV2 Phase 2 — APP ADAPTERS, delivered at bind (the user's idea). Binding an app
// may print, once per session, the functions made for it (`app.extras.<name>(…)`, each with its access class), its
// scripting dictionary's commands as typed wrappers (`app.dict.<name>(…)`, `dict.ts`) and a short guide — in the TOOL
// RESULT only, never in the tool description (fixed per incarnation, so prompt caching is unaffected). After a
// compaction, a reset or a worker restart the block is printed again — at the next bind, or the next primitive that
// touches the app — and `app.help()` prints it any time.
//
// The service calls in at five places (`service.ts`): `onBind` just before a bind prints its state, `beforePrimitive`
// after a target primitive's lock, `primitive` for `extra` / `dict` / `help`, and `clearSession` / `observe` for the
// lifecycle. An adapter failure never fails a bind: no adapter, no dictionary, or a helper too old to list one simply
// means nothing more is printed.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import type { SessionEvent } from "@yanlinglabs/winter-protocol";
import { applicationPathsForBundleId } from "../../auth/keychain-ffi";
import { AutomationFailure, isAutomationFailure } from "../errors";
import { CLICK_ONLY_PRIMITIVES, cardName } from "../policy";
import {
  HELPER_SCRIPTING_COMMANDS_VERSION, HelperRpcError, helperVersionAtLeast,
  type ActResult, type FindResult, type ScriptingCommandsResult, type SnapshotResult, type WaitForResult,
} from "../protocol";
import type { ExtraSpec } from "../worker/bridge";
import { appleScriptText } from "./apps/common";
import { AdapterDelivery } from "./delivery";
import { buildDictSource, dictListing, generateDict, type DictInfo } from "./dict";
import { AdapterRegistry, BUILTIN_ADAPTERS } from "./registry";
import type { AdapterRunScope, AdapterScope, AdapterTarget, AppAdapter, AuthPurpose, ExtraAccess } from "./types";

export type { AdapterRunScope, AdapterScope, AdapterTarget, AppAdapter, ExtraDef } from "./types";

/** How many running apps' dictionaries are kept (by bundle id + pid), and generated wrapper sets (by bundle id +
 *  `CFBundleVersion`). */
const DICT_CACHE_MAX = 64;
const SCRIPTING_COMMANDS_TIMEOUT_MS = 8_000;
/** A dictionary command's AppleScript may run this long (clamped to the script's time left). */
const DICT_COMMAND_TIMEOUT_MS = 30_000;
/** `help("<extra>")`: the extra's doc, at most. */
const HELP_EXTRA_DOC_CAP = 600;

export interface AppAdaptersDeps {
  /** The adapter table (default: the built-in one, `registry.ts`). */
  adapters?: readonly AppAdapter[];
  /** More adapters beside it — a test daemon's own (the live suite's fixture adapter). */
  extra?: readonly AppAdapter[];
  /** The app's `CFBundleShortVersionString` when the bind did not say (a helper older than 1.8.0) — asked only for an
   *  app whose adapter has version conditions. Default: LaunchServices' path for the bundle id, then its Info.plist. */
  appVersion?(bundleId: string): string | undefined;
  log?(line: string): void;
}

/** What the adapters know of one bound target. */
interface Bound {
  target: AdapterTarget;
  adapter?: AppAdapter;
  dict?: DictInfo;
  /** Why there is no dictionary list (for `help("dict")`). */
  dictUnavailable?: string;
}

const bad = (message: string): TypeError => Object.assign(new TypeError(message), { name: "TypeError" });

/** `a`, `a and b`, `a, b and c`. */
function andList(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

function capBytes(s: string, max: number): string {
  if (Buffer.byteLength(s) <= max) return s;
  let out = s;
  while (Buffer.byteLength(out) > max - 3) out = out.slice(0, -1);
  return `${out}…`;
}

/** An extra's return value as the worker gets it: JSON-plain (functions and the like dropped). */
function plainValue(v: unknown): unknown {
  if (v === undefined) return undefined;
  try { return JSON.parse(JSON.stringify(v)) as unknown; } catch { return undefined; }
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(true); }, Math.max(0, ms));
    const onAbort = (): void => { clearTimeout(timer); resolve(false); };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** The policy purpose an extra's class asks for: `view` observes; `click` and `full` act at that class. */
export function purposeFor(access: ExtraAccess, primitive: string): AuthPurpose {
  return access === "view" ? { kind: "observe" } : { kind: "act", primitive, access };
}

/** LaunchServices' copy of the app, its `CFBundleShortVersionString` (a lookup and a file read, never a launch). */
function launchServicesVersion(bundleId: string): string | undefined {
  let paths: string[];
  try { paths = applicationPathsForBundleId(bundleId); } catch { return undefined; }
  for (const p of paths) {
    const r = spawnSync("/usr/bin/plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", join(p, "Contents", "Info.plist")], { encoding: "utf8", timeout: 5_000 });
    const v = typeof r.stdout === "string" ? r.stdout.trim() : "";
    if (r.status === 0 && v.length > 0) return v;
  }
  return undefined;
}

export class AppAdapters {
  readonly registry: AdapterRegistry;
  readonly delivery = new AdapterDelivery();
  /** Session → target id → what is known of it (set at bind). */
  private readonly sessions = new Map<string, Map<string, Bound>>();
  /** bundle id + pid → the app's dictionary (or why there is none). */
  private readonly dictByApp = new Map<string, { info?: DictInfo; why?: string }>();
  /** bundle id + `CFBundleVersion` → its generated wrappers. */
  private readonly dictByVersion = new Map<string, DictInfo>();

  constructor(private readonly deps: AppAdaptersDeps = {}) {
    this.registry = new AdapterRegistry([...(deps.adapters ?? BUILTIN_ADAPTERS), ...(deps.extra ?? [])]);
  }

  private log(line: string): void { this.deps.log?.(line); }

  // ── the service's call sites ───────────────────────────────────────────────────────────────────────────────

  /** A bind is about to print its state: print the app's block (first time in the session) or the one line saying it
   *  was shown, and hand back the names the worker's `app.extras` / `app.dict` answer — on EVERY bind (each one makes a
   *  new handle). Nothing for an app with no adapter and no dictionary. */
  async onBind(scope: AdapterRunScope, info: AdapterTarget): Promise<{ handle?: { extras?: ExtraSpec[]; dict?: string[] } } | undefined> {
    const b = this.remember(scope.sessionId, await this.resolve(scope, info));
    const block = this.block(b);
    if (block === undefined) return undefined;
    if (this.delivery.has(scope.sessionId, info.bundleId)) {
      scope.builder.daemonLine(this.oneLiner(b));
    } else {
      scope.builder.guide(block);
      this.delivery.mark(scope.sessionId, info.bundleId);
    }
    return { handle: this.handle(b) };
  }

  /** A primitive on a bound target: after a compaction (the delivered set forgotten) the block is printed again here,
   *  before the primitive's own output. `help` prints it itself. */
  async beforePrimitive(scope: AdapterRunScope, t: AdapterTarget): Promise<void> {
    if (scope.primitive === "help") return;
    const b = this.sessions.get(scope.sessionId)?.get(t.targetId);
    if (b === undefined || this.delivery.has(scope.sessionId, t.bundleId)) return;
    const block = this.block(b);
    if (block === undefined) return;
    scope.builder.guide(block);
    this.delivery.mark(scope.sessionId, t.bundleId);
  }

  /** `app.extras.<name>(…)`, `app.dict.<name>(…)`, `app.help(…)`. */
  async primitive(scope: AdapterRunScope, t: AdapterTarget, primitive: string, args: Record<string, unknown>): Promise<unknown> {
    const known = this.sessions.get(scope.sessionId)?.get(t.targetId) ?? this.remember(scope.sessionId, await this.resolve(scope, t));
    // The target as the service knows it NOW (a `useWindow` since the bind changed the bound window).
    const b: Bound = { ...known, target: t };
    switch (primitive) {
      case "help": return this.help(scope, b, args);
      case "extra": return await this.extra(scope, b, args);
      case "dict": return await this.dict(scope, b, args);
      default: throw bad(`unknown primitive ${primitive}`);
    }
  }

  /** The hub observer: a main-thread compaction forgets what was delivered. */
  observe(event: SessionEvent): void {
    this.delivery.observe(event);
  }

  /** A reset, a worker restart, the session's end: its bindings and what its model saw are gone. */
  clearSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.delivery.clearSession(sessionId);
  }

  // ── resolution ─────────────────────────────────────────────────────────────────────────────────────────────

  private remember(sessionId: string, b: Bound): Bound {
    let m = this.sessions.get(sessionId);
    if (m === undefined) { m = new Map(); this.sessions.set(sessionId, m); }
    m.set(b.target.targetId, b);
    return b;
  }

  private async resolve(scope: AdapterRunScope, t: AdapterTarget): Promise<Bound> {
    let version = t.appVersion;
    if (version === undefined && this.registry.versioned(t.bundleId)) version = (this.deps.appVersion ?? launchServicesVersion)(t.bundleId);
    const adapter = this.registry.find(t.bundleId, version);
    const d = await this.dictFor(scope, t);
    return { target: t, ...(adapter === undefined ? {} : { adapter }), ...d };
  }

  /** The app's dictionary commands: `target.scriptingCommands` (helper 1.8.0+), once per running app (bundle id + pid),
   *  the wrappers generated once per (bundle id, `CFBundleVersion`). Never fails the caller but for a cancellation. */
  private async dictFor(scope: AdapterRunScope, t: AdapterTarget): Promise<{ dict?: DictInfo; dictUnavailable?: string }> {
    if (!helperVersionAtLeast(scope.helperVersion(), HELPER_SCRIPTING_COMMANDS_VERSION)) {
      return { dictUnavailable: `Winter Computer Use is older than ${HELPER_SCRIPTING_COMMANDS_VERSION}, so it lists no dictionary commands — use scriptingDictionary() and applescript(), or update Winter` };
    }
    const key = `${t.bundleId.toLowerCase()}\u0000${t.pid}`;
    const hit = this.dictByApp.get(key);
    if (hit !== undefined) {
      this.dictByApp.delete(key);
      this.dictByApp.set(key, hit);
      return hit.info !== undefined ? { dict: hit.info } : { dictUnavailable: hit.why ?? "no dictionary commands" };
    }
    let res: ScriptingCommandsResult;
    try {
      res = await scope.helper<ScriptingCommandsResult>("target.scriptingCommands", { targetId: t.targetId, callId: scope.callId }, SCRIPTING_COMMANDS_TIMEOUT_MS);
    } catch (err) {
      // Only a cancellation stops the bind; anything else (a busy app, a lost window) just means no list this time.
      if ((isAutomationFailure(err) && err.kind === "Cancelled") || (err instanceof HelperRpcError && err.code === "cancelled")) throw err;
      if (err instanceof HelperRpcError && (err.code === "unsupported" || err.code === "invalid_params")) {
        this.cache(key, { why: "Winter Computer Use could not list this app's dictionary commands" });
        return { dictUnavailable: "Winter Computer Use could not list this app's dictionary commands" };
      }
      this.log(`computer-use: the dictionary commands of ${t.bundleId} could not be read (${err instanceof Error ? err.message.slice(0, 200) : "error"})`);
      return { dictUnavailable: "its dictionary could not be read just now — try help(\"dict\") again" };
    }
    const vkey = typeof res?.bundleVersion === "string" ? `${t.bundleId.toLowerCase()}\u0000${res.bundleVersion}` : undefined;
    const info = (vkey === undefined ? undefined : this.dictByVersion.get(vkey)) ?? generateDict(res);
    if (vkey !== undefined) {
      this.dictByVersion.set(vkey, info);
      while (this.dictByVersion.size > DICT_CACHE_MAX) this.dictByVersion.delete(this.dictByVersion.keys().next().value!);
    }
    this.cache(key, { info });
    return { dict: info };
  }

  private cache(key: string, v: { info?: DictInfo; why?: string }): void {
    this.dictByApp.set(key, v);
    while (this.dictByApp.size > DICT_CACHE_MAX) this.dictByApp.delete(this.dictByApp.keys().next().value!);
  }

  // ── what is printed ────────────────────────────────────────────────────────────────────────────────────────

  /** The extras block: the extras, the dictionary line, the guide — whichever exist, in that order. */
  block(b: Bound): string | undefined {
    const name = cardName(b.target.name);
    const lines: string[] = [];
    const extras = b.adapter?.extras ?? [];
    if (extras.length > 0) {
      lines.push(`${name} extras — on this app's handle: .extras.<name>(…); .help() shows them again`);
      for (const e of extras) lines.push(`  ${e.signature} · ${e.access} — ${e.summary}`);
    }
    const n = b.dict?.commands.length ?? 0;
    if (n > 0) lines.push(`${name} dictionary: ${n} command${n === 1 ? "" : "s"} — .dict.<name>(…), run like applescript(); .help("dict") lists them`);
    const guide = b.adapter?.guide;
    if (guide !== undefined) lines.push(`Guide ${guide.id}:`, guide.text.trim());
    return lines.length === 0 ? undefined : lines.join("\n");
  }

  /** `(Finder: extras, dictionary commands and guide finder@1 were shown earlier — .help() shows them again)`. */
  private oneLiner(b: Bound): string {
    const parts: string[] = [];
    if ((b.adapter?.extras.length ?? 0) > 0) parts.push("extras");
    if ((b.dict?.commands.length ?? 0) > 0) parts.push("dictionary commands");
    if (b.adapter?.guide !== undefined) parts.push(`guide ${b.adapter.guide.id}`);
    return `(${cardName(b.target.name)}: ${andList(parts)} ${parts.length === 1 && parts[0]!.startsWith("guide") ? "was" : "were"} shown earlier — .help() shows them again)`;
  }

  private handle(b: Bound): { extras?: ExtraSpec[]; dict?: string[] } {
    const extras = (b.adapter?.extras ?? []).map((e) => ({ name: e.name, access: e.access }));
    const dict = (b.dict?.commands ?? []).map((c) => c.name);
    return { ...(extras.length === 0 ? {} : { extras }), ...(dict.length === 0 ? {} : { dict }) };
  }

  // ── the three primitives ───────────────────────────────────────────────────────────────────────────────────

  private help(scope: AdapterRunScope, b: Bound, args: Record<string, unknown>): string {
    const topic = args.topic;
    const search = args.search;
    if (topic !== undefined && topic !== null && typeof topic !== "string") throw bad("help() takes a topic: \"dict\" or one extra's name");
    if (search !== undefined && typeof search !== "string") throw bad("help() takes { search?: string }");
    const emit = args.emit !== false;
    const name = cardName(b.target.name);
    const extras = b.adapter?.extras ?? [];
    if (topic === undefined || topic === null || topic === "") {
      const block = this.block(b);
      if (block !== undefined) this.delivery.mark(scope.sessionId, b.target.bundleId);
      const text = block ?? `${name} has no extras, dictionary commands or guide in Winter`;
      if (emit) scope.builder.guide(text);
      return text;
    }
    if (topic === "dict") {
      // Command names and descriptions are the app's own words: data, inside the fence.
      const text = b.dict !== undefined ? dictListing(name, b.dict, search) : `${name}: ${b.dictUnavailable ?? "no dictionary commands"}`;
      scope.builder.markScreenRead();
      if (emit) scope.builder.text(text, { screen: true });
      return text;
    }
    const def = extras.find((e) => e.name === topic);
    if (def !== undefined) {
      const text = `${def.signature} · ${def.access} — ${def.summary}${def.doc === undefined ? "" : `\n${capBytes(def.doc, HELP_EXTRA_DOC_CAP)}`}`;
      if (emit) scope.builder.guide(text);
      return text;
    }
    throw bad(`help() takes no topic (everything), "dict"${extras.length > 0 ? `, or one of ${name}'s extras: ${extras.map((e) => `"${e.name}"`).join(", ")}` : ""}`);
  }

  private async extra(scope: AdapterRunScope, b: Bound, args: Record<string, unknown>): Promise<unknown> {
    const name = args.name;
    const argv = args.args === undefined ? [] : args.args;
    if (typeof name !== "string") throw bad("extras: the extra's name is missing");
    if (!Array.isArray(argv)) throw bad(`extras.${name.slice(0, 40)}() takes positional arguments`);
    // The worker only hands out listed names; the name is checked again here (the worker is untrusted).
    const def = b.adapter?.extras.find((e) => e.name === name);
    const app = { bundleId: b.target.bundleId, name: b.target.name };
    if (def === undefined) {
      const list = (b.adapter?.extras ?? []).map((e) => e.name);
      throw bad(`${cardName(b.target.name)} has no extra "${name.slice(0, 60)}"${list.length > 0 ? ` — its extras: ${list.join(", ")}` : ""}`);
    }
    scope.metric.extra = def.name;
    await scope.authorize(app, purposeFor(def.access, `extras.${def.name}`));
    const value = await def.run(this.extraScope(scope, b.target, def.access), argv);
    // Whatever an extra returns was read from the app: the session's output is data from here on.
    scope.builder.markScreenRead();
    return plainValue(value);
  }

  private async dict(scope: AdapterRunScope, b: Bound, args: Record<string, unknown>): Promise<unknown> {
    const name = args.name;
    const argv = args.args === undefined ? [] : args.args;
    if (typeof name !== "string") throw bad("dict: the command's name is missing");
    if (!Array.isArray(argv)) throw bad(`dict.${name.slice(0, 40)}() takes positional arguments`);
    const cmd = b.dict?.commands.find((c) => c.name === name);
    if (cmd === undefined) throw bad(`${cardName(b.target.name)} has no dictionary command "${name.slice(0, 60)}" — help("dict") lists them`);
    scope.metric.extra = cmd.name;
    // The arguments first: a call that cannot be written never raises a card.
    const source = buildDictSource(b.target.bundleId, cmd, argv);
    await scope.authorize({ bundleId: b.target.bundleId, name: b.target.name }, { kind: "act", primitive: `dict.${cmd.name}`, access: "full" });
    const res = await scope.applescript(b.target, source, { timeoutMs: DICT_COMMAND_TIMEOUT_MS });
    // Run like applescript(): its result is printed (the app's data, inside the fence) and returned.
    if (res.result !== null && res.result !== undefined && res.result.length > 0) scope.builder.text(res.result, { screen: true });
    return { result: res.result ?? null };
  }

  /** What one extra sees: only the invariant's doors, aimed at this target, held to the extra's class. */
  private extraScope(scope: AdapterRunScope, t: AdapterTarget, access: ExtraAccess): AdapterScope {
    const callId = scope.callId;
    const needs = (what: string, cls: "click" | "full"): void => {
      if (access === "view" || (cls === "full" && access !== "full")) {
        throw new AutomationFailure("NotAllowed", `this ${access} extra cannot ${what} (Winter's own adapter is wrong — report it)`);
      }
    };
    return {
      app: { name: t.name, bundleId: t.bundleId, pid: t.pid },
      signal: scope.signal,
      window: () => {
        if (typeof t.windowId !== "number" || !Number.isInteger(t.windowId) || t.windowId <= 0) {
          throw new AutomationFailure("NoWindow", `Winter doesn't know which ${t.name} window is bound, so nothing was done — bind the window again (apps.open, or useWindow)`);
        }
        return t.windowId;
      },
      applescript: async (source, o) => appleScriptText((await scope.applescript(t, source, o)).result),
      find: async (query) => (await scope.helper<FindResult>("target.find", { targetId: t.targetId, query, callId })).elements,
      snapshot: async (o) => (await scope.helper<SnapshotResult>("target.snapshot", {
        targetId: t.targetId, callId, full: true, ...(o?.within === undefined ? {} : { within: o.within }),
      })).text,
      act: async (action) => {
        needs(action.kind, CLICK_ONLY_PRIMITIVES.has(action.kind) ? "click" : "full");
        // Background only: never the foreground, never the user's desktop (an act that needs either fails, typed).
        const res = await scope.helper<ActResult>("target.act", {
          targetId: t.targetId, sessionId: scope.sessionId, callId, action,
          access: access === "click" ? "click" : "full", privatePath: scope.privatePath, allowForeground: false,
        });
        scope.acted(t.targetId);
        return res;
      },
      waitFor: async (cond, timeoutMs) => {
        const ms = scope.clampWait(timeoutMs);
        const r = await scope.helper<WaitForResult>("target.waitFor", { targetId: t.targetId, cond, timeoutMs: ms, callId }, ms + 5_000);
        return { waitedMs: r.waitedMs };
      },
      openDocument: async (path, opener) => {
        needs("open a document", "full");
        const h = await scope.openDocument(path, opener);
        return { name: h.name, bundleId: h.bundleId, handle: h };
      },
      print: (text) => scope.builder.text(text, { screen: true }),
      say: (text) => scope.builder.daemonLine(text),
      notice: (text) => scope.builder.notice(text),
      clampWait: (ms) => scope.clampWait(ms),
      sleep: (ms) => abortableSleep(ms, scope.signal),
    };
  }
}
