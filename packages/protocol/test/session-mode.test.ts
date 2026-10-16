import { describe, expect, test } from "bun:test";
import {
  CapabilityToolInfoSchema,
  SESSION_MODES,
  SessionCreateParams,
  SessionCreatedEvent,
  SessionEvent,
  SessionModeSchema,
  type SessionMode,
} from "../src";

// Cowork (session door): `cowork` is a RECOGNISED session mode — the wire, a stored log and the capability
// table can name it — while nothing can create or run one (core's `session.create` refuses it for every
// role with `unsupported_topology`; see packages/core/test/ipc/session-create-cowork.test.ts). These pins
// keep the three enum sites and the one list in step.
describe("SessionModeSchema recognises cowork", () => {
  test("SESSION_MODES is exactly the four recognised modes, in this order", () => {
    expect([...SESSION_MODES]).toEqual(["code", "dispatch", "chat", "cowork"]);
    expect(SessionModeSchema.options).toEqual([...SESSION_MODES]);
  });

  test("the type is the union of the list (a fifth mode would have to be added to the list)", () => {
    const all: SessionMode[] = ["code", "dispatch", "chat", "cowork"];
    for (const mode of all) expect(SessionModeSchema.parse(mode)).toBe(mode);
    // @ts-expect-error "workspace" is not a recognised session mode
    const bogus: SessionMode = "workspace";
    expect(SessionModeSchema.safeParse(bogus).success).toBe(false);
  });

  test("session.create's params carry cowork on the wire (the daemon, not the schema, refuses it)", () => {
    expect(SessionCreateParams.parse({ scope: "global", mode: "cowork" }).mode).toBe("cowork");
    for (const mode of ["code", "dispatch", "chat"] as const) expect(SessionCreateParams.parse({ scope: "global", mode }).mode).toBe(mode);
    expect(SessionCreateParams.parse({ scope: "global" }).mode).toBeUndefined();
    for (const bad of ["Cowork", "COWORK", "coworker", "", "agent"]) expect(() => SessionCreateParams.parse({ scope: "global", mode: bad })).toThrow();
  });

  test("session_created round-trips mode: cowork, on the event and through the SessionEvent union", () => {
    const wire = { seq: 1, sessionId: "s_fixture", ts: 1781270000000, type: "session_created", scope: "global", mode: "cowork" };
    expect(SessionCreatedEvent.parse(wire).mode).toBe("cowork");
    const parsed = SessionEvent.parse(wire);
    expect(parsed.type === "session_created" ? parsed.mode : undefined).toBe("cowork");
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(wire);
    expect(() => SessionEvent.parse({ ...wire, mode: "coworker" })).toThrow();
  });

  test("capabilities.list names cowork in its exposure map (a literal false: no Cowork tool surface)", () => {
    const tool = { name: "mcp__winter__sessions__SpawnSession", modes: ["dispatch"], exposure: { code: false, dispatch: true, chat: false, cowork: false } };
    expect(CapabilityToolInfoSchema.parse(tool).exposure.cowork).toBe(false);
    expect(() => CapabilityToolInfoSchema.parse({ ...tool, exposure: { code: false, dispatch: true, chat: false } })).toThrow();
  });
});
