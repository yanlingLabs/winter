// #92 N3 and N4, the host's records and checks (no guest here): stable uids through the allocation table (L7), the
// four-state store and the continuation it gives, the resume plan, the hold token, and the closed shapes of every
// held-input answer and host-messaging answer. The literals mirror agent-sdk #43 (pinned below).
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { coworkContinuationFor, coworkResumePlan } from "../../src/cowork/cold-resume";
import { COWORK_GUEST_IDENTITIES } from "../../src/cowork/conversation-set";
import {
  COWORK_HELD_INPUT_CAPABILITY, COWORK_HELD_INPUT_ERRORS, COWORK_HOST_INPUT_SUBTYPES, CoworkHeldInputRefusal, coworkCommitAnswer, coworkDiscardAnswer, coworkForgetAnswer,
  coworkHeldInputsEvent, coworkHeldInputVerbs, coworkHoldAnswer, coworkHoldToken, coworkHostMessageListAnswer, coworkHostMessageSendAnswer, coworkOffersHeldInput,
} from "../../src/cowork/held-input";
import { COWORK_GUEST_UID_FIRST } from "../../src/cowork/repository";
import { doorFixture, type DoorFixture } from "./session-door-fixture";

const fixtures: DoorFixture[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.close(); });
const BACKEND = "0b6d7c4e-5a1f-4c2e-9d3b-7e8f9a0b1c2d", HEX = "a".repeat(64), BOOT = "11111111-2222-4333-8444-555555555555";
const fixture = (sessions = ["conversation"]) => { const f = doorFixture({ sessions }); fixtures.push(f); return f; };

test("N3 L7: uids are allocated once per conversation, only through the uid table, never the workspace gid, never reused while held", () => {
  const f = fixture(["s_000000000001", "s_000000000002", "s_000000000003"]), gid = COWORK_GUEST_IDENTITIES.workspaceGid;
  expect(COWORK_GUEST_UID_FIRST).toBe(COWORK_GUEST_IDENTITIES.runtimeUid); // the first conversation keeps the N2 picks
  const one = f.records.allocateGuestUids("s_000000000001", gid);
  expect(one).toEqual({ runtimeUid: 2001, toolUid: 2002 });
  expect(f.records.allocateGuestUids("s_000000000001", gid)).toEqual(one); // stable
  expect(f.records.storeState("s_000000000001")).toMatchObject({ runtimeUid: 2001, toolUid: 2002 });
  // A retired (not released) uid is still held: the next conversation never gets it.
  f.db.db.run("UPDATE cowork_guest_uids SET retired_at='t' WHERE uid=2001");
  expect(f.records.allocateGuestUids("s_000000000002", gid)).toEqual({ runtimeUid: 2003, toolUid: 2004 });
  // The workspace gid is skipped wherever it falls.
  expect(f.records.allocateGuestUids("s_000000000003", 2005)).toEqual({ runtimeUid: 2006, toolUid: 2007 });
  const rows = f.db.db.query("SELECT uid, role, session_id FROM cowork_guest_uids ORDER BY uid").all();
  expect(rows).toEqual([
    { uid: 2001, role: "runtime", session_id: "s_000000000001" }, { uid: 2002, role: "tool", session_id: "s_000000000001" },
    { uid: 2003, role: "runtime", session_id: "s_000000000002" }, { uid: 2004, role: "tool", session_id: "s_000000000002" },
    { uid: 2006, role: "runtime", session_id: "s_000000000003" }, { uid: 2007, role: "tool", session_id: "s_000000000003" },
  ]);
  expect(() => f.records.allocateGuestUids("s_missing00000", gid)).toThrow();
});

test("N3: the store state moves none -> started (write-ahead with the incarnation) -> created -> lost, and never back", () => {
  const f = fixture();
  expect(f.records.storeState("conversation")).toEqual({ storeState: "none", lastIncarnationId: null, runtimeUid: null, toolUid: null });
  expect(() => f.records.markStoreCreated("conversation")).toThrow("recovery_required"); // a turn without the write-ahead record
  f.records.assignConversationBackend("conversation", BACKEND, "incarnation-1");
  expect(f.records.storeState("conversation")).toMatchObject({ storeState: "started", lastIncarnationId: "incarnation-1" });
  f.records.assignConversationBackend("conversation", BACKEND, "incarnation-2"); // a resumed incarnation records itself
  expect(f.records.storeState("conversation")).toMatchObject({ storeState: "started", lastIncarnationId: "incarnation-2" });
  expect(() => f.records.assignConversationBackend("conversation", "1b6d7c4e-5a1f-4c2e-9d3b-7e8f9a0b1c2d", "incarnation-3")).toThrow("authority_denied");
  expect(f.records.storeState("conversation").lastIncarnationId).toBe("incarnation-2");
  f.records.markStoreCreated("conversation"); f.records.markStoreCreated("conversation");
  expect(f.records.storeState("conversation").storeState).toBe("created");
  f.records.assignConversationBackend("conversation", BACKEND, "incarnation-3");
  expect(f.records.storeState("conversation").storeState).toBe("created"); // never back to started
  f.records.markStoreLost("conversation");
  f.records.markStoreCreated("conversation");
  expect(f.records.storeState("conversation").storeState).toBe("lost"); // terminal
});

test("N3: the continuation table and the resume plan (proven-ended boots of the last incarnation only)", () => {
  expect(["none", "started", "created"].map(coworkContinuationFor)).toEqual(["fresh", "either", "resume"]);
  for (const state of ["lost", "", "fresh"]) expect(() => coworkContinuationFor(state)).toThrow("cold_resume_unavailable");
  const f = fixture();
  expect(coworkResumePlan(f.records, "conversation")).toEqual({ continuation: "fresh", endedGuestBoots: [] });
  f.db.db.run("UPDATE cowork_conversations SET store_state='started' WHERE session_id='conversation'");
  expect(() => coworkResumePlan(f.records, "conversation")).toThrow("recovery_required"); // started with no incarnation
  f.records.assignConversationBackend("conversation", BACKEND, "incarnation-1");
  const boot = (incarnationId: string, bootId: string, proof: string | null) => f.db.db.run("INSERT INTO cowork_guest_boots(workspace_id,incarnation_id,lease_epoch,guest_boot_id,recorded_at,ended_proof,ended_at) VALUES(?,?,1,?,'t',?,?)", [f.workspaceId, incarnationId, bootId, proof, proof === null ? null : "t"]);
  boot("incarnation-1", BOOT, "orderly-receipt");
  boot("incarnation-0", "21111111-2222-4333-8444-555555555555", "new-boot");
  expect(coworkResumePlan(f.records, "conversation")).toEqual({ continuation: "either", endedGuestBoots: [BOOT] });
  f.records.markStoreCreated("conversation");
  expect(coworkResumePlan(f.records, "conversation").continuation).toBe("resume");
  f.db.db.run("UPDATE cowork_guest_boots SET ended_proof=NULL, ended_at=NULL WHERE incarnation_id='incarnation-1'");
  expect(coworkResumePlan(f.records, "conversation").endedGuestBoots).toEqual([]); // an unproven end is never evidence
  f.records.markStoreLost("conversation");
  expect(() => coworkResumePlan(f.records, "conversation")).toThrow("cold_resume_unavailable");
});

test("N4: the literals mirror agent-sdk #43, and the hold token is sha256(hold-v1|receipt|incarnation|epoch|offer)", () => {
  expect(COWORK_HELD_INPUT_CAPABILITY).toBe("held-input-v1");
  expect(COWORK_HOST_INPUT_SUBTYPES).toEqual({ hold: "host_input_hold", commit: "host_input_commit", discard: "host_input_discard", forget: "host_input_forget" });
  expect([...COWORK_HELD_INPUT_ERRORS]).toEqual(["conflict", "superseded", "committed", "unknown_input", "epoch", "invalid", "journal_full", "journal_failed"]);
  expect(coworkHoldToken("r1", "inc-1", 2, 3)).toBe(createHash("sha256").update("hold-v1|r1|inc-1|2|3").digest("hex"));
  expect(coworkHoldToken("r1", "inc-1", 2, 4)).not.toBe(coworkHoldToken("r1", "inc-1", 2, 3));
  for (const args of [["", "i", 1, 1], ["r", "", 1, 1], ["r", "a|b", 1, 1], ["r", "i", 0, 1], ["r", "i", 1, 0], ["r", "i", 1.5, 1]] as const) expect(() => coworkHoldToken(...(args as unknown as [string, string, number, number]))).toThrow("invalid_request");
  expect(coworkOffersHeldInput({ capabilities: ["confined-guest-posture-v1", "held-input-v1"] })).toBe(true);
  expect(coworkOffersHeldInput({ capabilities: ["confined-guest-posture-v1"] })).toBe(false);
  expect(coworkOffersHeldInput(undefined)).toBe(false);
});

test("N4: every answer is checked against its closed shape; anything else is uncertain (recovery_required)", () => {
  expect(coworkHoldAnswer({ held: true })).toEqual({ held: true });
  expect(coworkHoldAnswer({ held: true, again: true })).toEqual({ held: true, again: true });
  expect(coworkHoldAnswer({ held: false, state: "in_transcript" })).toEqual({ held: false, state: "in_transcript" });
  for (const bad of [{ held: false }, { held: true, state: "committed" }, { held: false, state: "held" }, { held: true, again: false }, { held: true, extra: 1 }, null, [], "held"]) expect(() => coworkHoldAnswer(bad)).toThrow("recovery_required");
  for (const outcome of ["folded", "queued", "started", "already"] as const) expect(coworkCommitAnswer({ outcome })).toEqual({ outcome });
  for (const bad of [{ outcome: "lost" }, { outcome: "folded", x: 1 }, {}]) expect(() => coworkCommitAnswer(bad)).toThrow("recovery_required");
  expect(coworkDiscardAnswer({ discarded: true })).toEqual({ discarded: true });
  expect(coworkDiscardAnswer({ discarded: false, reason: "superseded" })).toEqual({ discarded: false, reason: "superseded" });
  for (const bad of [{ discarded: false }, { discarded: true, reason: "superseded" }, { discarded: false, reason: "other" }]) expect(() => coworkDiscardAnswer(bad)).toThrow("recovery_required");
  expect(coworkForgetAnswer({ forgotten: false })).toEqual({ forgotten: false });
  for (const bad of [{ forgotten: 1 }, { forgotten: true, x: 1 }]) expect(() => coworkForgetAnswer(bad)).toThrow("recovery_required");
  const record = { inputId: "r1", digest: HEX, holdToken: HEX, state: "held" };
  expect(coworkHeldInputsEvent({ inputs: [] })).toEqual([]);
  expect(coworkHeldInputsEvent({ inputs: [record, { ...record, inputId: "r2", state: "in_transcript" }] })).toHaveLength(2);
  for (const bad of [{}, { inputs: [record, record] }, { inputs: [{ ...record, state: "discarded" }] }, { inputs: [{ ...record, digest: "A".repeat(64) }] }, { inputs: [{ ...record, extra: 1 }] }]) expect(() => coworkHeldInputsEvent(bad)).toThrow("recovery_required");
});

test("N4: the verbs check requests before they leave, bind the live epoch, and map refusals (typed) from uncertainty", async () => {
  const sent: unknown[] = [];
  let answer: unknown = { held: true }, epoch: { incarnationId: string; leaseEpoch: number } | undefined = { incarnationId: "inc-1", leaseEpoch: 2 }, live: unknown;
  const query = {
    holdInput: async (request: unknown) => { sent.push(request); if (answer instanceof Error) throw answer; return answer; },
    commitInput: async (...args: unknown[]) => { sent.push(args); return { outcome: "folded" }; },
    discardInput: async () => ({ discarded: true }), forgetInput: async () => ({ forgotten: true }),
  };
  live = query;
  const verbs = coworkHeldInputVerbs(() => live, () => epoch);
  const input = { inputId: "r1", holdToken: HEX, text: "hello", clientName: "peer" };
  expect(await verbs.hold(input)).toEqual({ held: true });
  expect(sent[0]).toEqual({ inputId: "r1", holdToken: HEX, epoch: { incarnationId: "inc-1", leaseEpoch: 2 }, text: "hello", clientName: "peer" });
  expect(await verbs.commit("r1", HEX)).toEqual({ outcome: "folded" });
  for (const bad of [{ ...input, text: "" }, { ...input, text: "x".repeat(64 * 1024 + 1) }, { ...input, text: "é".repeat(32 * 1024 + 1) }, { ...input, clientName: "" }, { ...input, clientName: "c".repeat(257) }, { ...input, holdToken: "short" }, { ...input, inputId: "bad id" }]) {
    await expect(verbs.hold(bad)).rejects.toThrow("invalid_request");
  }
  expect(sent).toHaveLength(2); // nothing invalid left the host
  answer = Object.assign(new Error("x"), { code: "superseded" });
  await expect(verbs.hold(input)).rejects.toBeInstanceOf(CoworkHeldInputRefusal);
  answer = Object.assign(new Error("x"), { code: "transport_reset" });
  await expect(verbs.hold(input)).rejects.toThrow("recovery_required");
  answer = { held: "yes" };
  await expect(verbs.hold(input)).rejects.toThrow("recovery_required");
  epoch = undefined;
  await expect(verbs.hold(input)).rejects.toThrow("cold_resume_unavailable");
  await expect(verbs.commit("r1", HEX)).rejects.toThrow("cold_resume_unavailable");
  epoch = { incarnationId: "inc-1", leaseEpoch: 2 }; live = { holdInput: async () => ({ held: true }) }; // an SDK without the verbs
  await expect(verbs.hold(input)).rejects.toThrow("unsupported_topology");
  live = undefined;
  await expect(verbs.forget("r1", HEX)).rejects.toThrow("cold_resume_unavailable");
});

test("N4: host-messaging answers are checked before the host replies (agent-sdk isHostMessageSendAnswer / normaliseHostMessageListAnswer)", () => {
  for (const ok of [{ status: "delivered" }, { status: "queued", note: "n" }, { status: "refused", reason: "not in this Project", retryable: false }, { status: "delivered", notify: { subscribed: true } }, { status: "delivered", notify: { refused: "no" } }]) expect(coworkHostMessageSendAnswer(ok)).toEqual(ok as never);
  for (const bad of [{ status: "refused" }, { status: "not_found", reason: "" }, { status: "sent" }, { status: "delivered", note: "n".repeat(501) }, { status: "delivered", extra: 1 }, { status: "delivered", notify: { subscribed: false } }, { status: "delivered", retryable: "no" }]) expect(() => coworkHostMessageSendAnswer(bad)).toThrow("invalid_request");
  expect(coworkHostMessageListAnswer({ sessions: [{ address: "a", status: "idle", mode: "cowork" }], omitted: 2 })).toEqual({ sessions: [{ address: "a", status: "idle", mode: "cowork" }], omitted: 2 });
  for (const bad of [{ sessions: [{ address: "", status: "idle", mode: "x" }] }, { sessions: [{ address: "a", status: "busy", mode: "x" }] }, { sessions: [], omitted: -1 }, { sessions: [{ address: "a", status: "idle", mode: "x", path: "/" }] }]) expect(() => coworkHostMessageListAnswer(bad)).toThrow("invalid_request");
});
