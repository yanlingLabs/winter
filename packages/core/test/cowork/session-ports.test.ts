// Cowork session door spine (D1): `cowork/session-ports.ts` declares the native-facing seams as STRUCTURAL COPIES,
// because the native anti-wiring pin lets only native-wiring.ts import cowork/native/* from src (type-only imports
// included). This file is where the copies meet their twins: each pair must be assignable BOTH ways, so a field added,
// removed, renamed or retyped on either side fails `bun run typecheck` here, not a runtime. The module itself must stay
// types only and imported only by the two consumers D1 wires behind the refusal.
import { expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { CoworkNativeConversationContext, CoworkNativeConversationSet, CoworkNativeHostDeps, CoworkNativeStopOutcome } from "../../src/cowork/native/host";
import type { CoworkNativeConversation } from "../../src/cowork/native/protocol";
import { COWORK_READINESS, type CoworkReadinessKey } from "../../src/cowork/session-profile";
import type { CoworkProviderScope } from "../../src/cowork/provider-broker";
import type { LegSession } from "../../src/runtime-sdk/session-driver";
import type {
  CoworkGuestConversation, CoworkGuestConversationContext, CoworkGuestConversationSet, CoworkGuestReadinessKey, CoworkGuestStartRequest,
  CoworkGuestStopOutcome, CoworkLegSession, CoworkProviderRouteScope,
} from "../../src/cowork/session-ports";

/** Exactly the same type (readonly-ness included). */
type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
/** Assignable both ways (TS treats readonly and mutable properties as mutually assignable). */
type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

// Each line is a compile-time fact: flip any twin and `tsc` reports "Type 'false' is not assignable to type 'true'".
const PINS = {
  conversationSet: true as Mutual<CoworkGuestConversationSet, CoworkNativeConversationSet>,
  conversation: true as Mutual<CoworkGuestConversation, CoworkNativeConversation>,
  conversationKeys: true as Same<keyof CoworkGuestConversation, keyof CoworkNativeConversation>,
  runtimeKeys: true as Same<keyof NonNullable<CoworkGuestConversation["runtime"]>, keyof NonNullable<CoworkNativeConversation["runtime"]>>,
  context: true as Mutual<CoworkGuestConversationContext, CoworkNativeConversationContext>,
  contextKeys: true as Same<keyof CoworkGuestConversationContext, keyof CoworkNativeConversationContext>,
  stopOutcome: true as Mutual<CoworkGuestStopOutcome, CoworkNativeStopOutcome>,
  startRequest: true as Mutual<CoworkGuestStartRequest["conversations"], NonNullable<CoworkNativeHostDeps["conversations"]>>,
  readinessKeys: true as Same<CoworkGuestReadinessKey, CoworkReadinessKey>,
  providerScope: true as Mutual<CoworkProviderRouteScope, CoworkProviderScope>,
  providerScopeKeys: true as Same<keyof CoworkProviderRouteScope, keyof CoworkProviderScope>,
  legSession: true as Same<Omit<CoworkLegSession, "mode">, Omit<LegSession, "mode">>,
  legSessionMode: true as Same<CoworkLegSession["mode"], "cowork">,
} satisfies Record<string, true>;

test("every structural copy is assignable both ways to its native twin (the compile-time pins above)", () => {
  expect(Object.values(PINS).every(value => value === true)).toBe(true);
  expect(Object.keys(PINS)).toHaveLength(13);
});

test("the readiness keys are the profile's own, at runtime too", () => {
  const copy: Record<CoworkGuestReadinessKey, true> = {
    "guest-compartment": true, "guest-tool-families": true, "linux-workflow": true, "guest-lsp": true, "skill-surface": true,
    "plan-transition": true, "scheduler-bridge": true, "host-provider-transport": true, "host-network-endpoint": true,
  };
  expect(Object.keys(copy).sort()).toEqual(Object.keys(COWORK_READINESS).sort());
});

test("session-ports is TYPES ONLY: it exports nothing at runtime and imports only types", async () => {
  const module = await import("../../src/cowork/session-ports");
  expect(Object.keys(module)).toEqual([]);
  const source = readFileSync(join(import.meta.dir, "..", "..", "src", "cowork", "session-ports.ts"), "utf8");
  const imports = source.split("\n").filter(line => /^\s*import\b/.test(line));
  expect(imports.length).toBeGreaterThan(0);
  for (const line of imports) expect([line, /^import type \{[^}]+\} from "[^"]+";$/.test(line.trim())]).toEqual([line, true]);
  // Never the native modules or the tool profile (the anti-wiring pins scan comments too, so the needles are absent).
  for (const needle of ["cowork/native", "./native/", "session-profile", "provider-broker"]) expect([needle, source.includes(needle)]).toEqual([needle, false]);
});

test("every src importer of session-ports takes types only (the ports are implemented elsewhere, never constructed here)", () => {
  const packages = join(import.meta.dir, "..", "..", "..");
  const files = readdirSync(packages).flatMap(name => {
    const src = join(packages, name, "src");
    try { if (!statSync(src).isDirectory()) return []; } catch { return []; }
    return readdirSync(src, { recursive: true }).map(String).map(file => join(src, file)).filter(file => /\.(ts|tsx|js|mjs)$/.test(file) && statSync(file).isFile());
  });
  expect(files.length).toBeGreaterThan(100);
  const naming = files.filter(file => /["'`][^"'`]*session-ports["'`]/.test(readFileSync(file, "utf8")));
  // D1's two consumers. Other lanes add importers (S7B's native seams, APPROVALS' port) without editing this test,
  // as long as each import is type-only: the module has no runtime exports, and the door's construction is pinned off
  // by session-door-off.test.ts.
  const names = naming.map(file => relative(packages, file).split(sep).join("/"));
  for (const expected of ["core/src/cowork/service.ts", "core/src/ipc/server.ts"]) expect(names).toContain(expected);
  for (const file of naming) {
    const statements = readFileSync(file, "utf8").match(/\b(?:import|export)\b[^;]*?["'`][^"'`]*session-ports["'`]/g) ?? [];
    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) expect([relative(packages, file), /^(?:import|export) type \{/.test(statement.trim())]).toEqual([relative(packages, file), true]);
  }
});
