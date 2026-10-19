import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoworkNativeSimulatedCrash, type CoworkNativeConversationContext, type CoworkNativeConversationSet, type CoworkNativeHostShare, type CoworkNativeStartRequest } from "../../../src/cowork/native/host";
import { createCoworkOutputsPreparer, createCoworkShareDirectoryOpener } from "../../../src/cowork/host-env/guest-dirs";
import { guidedConversation, guidedSet } from "./conversation-fixtures";
import { cleanupHarnesses, createHarness, type Harness } from "./harness";

// N2 S7B part 3: what the native host records and checks for the session door (guest boots, the store volume, the continuation echo and the fault to lost mapping, shares,
// the outputs directory and the plan view's epoch). Everything here runs over the fake launcher; no VM exists.

const temps: string[] = [];
afterEach(() => { cleanupHarnesses(); temps.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });
const scratch = (): string => { const dir = realpathSync(mkdtempSync(join(tmpdir(), "winter-b3-"))); temps.push(dir); return dir; };
const OLDER_BOOT = "11111111-1111-4111-8111-111111111111";
const bootRows = (h: Harness) => h.db.db.query<{ incarnation_id: string; guest_boot_id: string; ended_proof: string | null; lease_epoch: number }, []>("SELECT incarnation_id,guest_boot_id,ended_proof,lease_epoch FROM cowork_guest_boots ORDER BY recorded_at").all();
/** A first start and stop formats the data volume, so a later start may honestly resume a store on it. */
const formatted = async (h: Harness): Promise<Harness> => { await (await h.host.start(h.workspaceId)).stop(); return h; };
const lastSet = (h: Harness) => h.launcher.last.conversationSets.at(-1) as unknown as { conversations: { runtime: { continuation: string; endedGuestBoots: string[] } | null; roots: { guestPath: string; readOnly: boolean }[]; toolUid: number }[] };

describe("guest boots: recorded at hello, ended only by the proof that released the disks", () => {
  test("a start records the boot; an orderly stop records orderly-receipt on that row, and only DOOR's reader then lists it", async () => {
    const h = createHarness();
    const running = await h.host.start(h.workspaceId);
    const [row] = bootRows(h);
    expect(row).toMatchObject({ guest_boot_id: running.guestBootId, ended_proof: null, incarnation_id: running.incarnationId, lease_epoch: running.leaseEpoch });
    expect(h.records.endedGuestBoots(h.workspaceId, running.incarnationId)).toEqual([]); // not ended yet: never attested
    expect((await running.stop()).released).toBe(true);
    expect(bootRows(h)[0]!.ended_proof).toBe("orderly-receipt");
    expect(h.records.endedGuestBoots(h.workspaceId, running.incarnationId)).toEqual([running.guestBootId]);
  });
  test("an uncertain stop records no proof (the boot is never listed as ended)", async () => {
    const h = createHarness({ behavior: { stop: "uncertain" } });
    const running = await h.host.start(h.workspaceId);
    expect((await running.stop()).released).toBe(false);
    expect(bootRows(h)[0]!.ended_proof).toBeNull();
    expect(h.records.endedGuestBoots(h.workspaceId, running.incarnationId)).toEqual([]);
  });
  test("a crash and a later boot: the new-boot proof (and only it) ends the old boot", async () => {
    const h = createHarness({ crashAt: "power-running" });
    await expect(h.host.start(h.workspaceId)).rejects.toBeInstanceOf(CoworkNativeSimulatedCrash);
    h.restart();
    expect(h.host.bootReconcile()).toMatchObject([{ action: "retained" }]);
    expect(bootRows(h)[0]).toMatchObject({ ended_proof: null }); // same boot, no proof, nothing recorded
    h.restart({ newBoot: true }); h.hostBoot.ended = true;
    expect(h.host.recover(h.workspaceId)).toMatchObject({ action: "released", evidence: "new-boot" });
    expect(bootRows(h)[0]!.ended_proof).toBe("new-boot");
  });
  test("a boot id reused for another incarnation, or a second id for the same one, is refused by the records", async () => {
    const h = createHarness();
    const running = await h.host.start(h.workspaceId);
    expect(() => h.guestRecords!.recordHello({ workspaceId: h.workspaceId, incarnationId: running.incarnationId, leaseEpoch: running.leaseEpoch, guestBootId: running.guestBootId })).not.toThrow(); // idempotent
    expect(() => h.guestRecords!.recordHello({ workspaceId: h.workspaceId, incarnationId: running.incarnationId, leaseEpoch: running.leaseEpoch, guestBootId: OLDER_BOOT })).toThrow(expect.objectContaining({ code: "boot_conflict" }));
    expect(() => h.guestRecords!.recordHello({ workspaceId: h.workspaceId, incarnationId: "inc-other", leaseEpoch: 1, guestBootId: running.guestBootId })).toThrow(expect.objectContaining({ code: "boot_conflict" }));
    expect(() => h.guestRecords!.recordEnd({ workspaceId: h.workspaceId, incarnationId: running.incarnationId, proof: "guest-said-so" as never })).toThrow(expect.objectContaining({ code: "invalid_record" }));
    expect(h.guestRecords!.recordEnd({ workspaceId: h.workspaceId, incarnationId: running.incarnationId, proof: "owner-recover" })).toBe(true);
    expect(h.guestRecords!.recordEnd({ workspaceId: h.workspaceId, incarnationId: running.incarnationId, proof: "new-boot" })).toBe(false); // a proof is never overwritten
    expect(bootRows(h)[0]!.ended_proof).toBe("owner-recover");
  });
});

describe("the continuation on the wire and its echo", () => {
  const resume = (continuation: "fresh" | "resume" | "either", endedGuestBoots: string[] = []) => ({ continuation, endedGuestBoots }) as const;
  test("a resume record is put on the conversation's runtime, and the guest's echo is exposed", async () => {
    const h = await formatted(createHarness());
    const running = await h.host.start(h.workspaceId, { resume: resume("resume", [OLDER_BOOT]) });
    expect(lastSet(h).conversations[0]!.runtime).toMatchObject({ continuation: "resume", endedGuestBoots: [OLDER_BOOT] });
    expect(running.continuations).toEqual(["resume"]);
  });
  test("without a request the builder's own record is sent and the echo is fresh", async () => {
    const h = createHarness();
    const running = await h.host.start(h.workspaceId);
    expect(lastSet(h).conversations[0]!.runtime).toMatchObject({ continuation: "fresh", endedGuestBoots: [] });
    expect(running.continuations).toEqual(["fresh"]);
  });
  test("a live boot in endedGuestBoots, or ended boots on a fresh start, never leave the host", async () => {
    const h = await formatted(createHarness());
    // the live boot is only known once the guest said hello: read it when the host asks for the list
    const live = { continuation: "resume" as const, get endedGuestBoots() { return [h.launcher.last.bootId]; } };
    await expect(h.host.start(h.workspaceId, { resume: live })).rejects.toMatchObject({ code: "protocol" });
    expect(h.launcher.last.conversationSets).toHaveLength(0);
    const g = createHarness();
    await expect(g.host.start(g.workspaceId, { resume: resume("fresh", [OLDER_BOOT]) })).rejects.toMatchObject({ code: "protocol" });
  });
  for (const [name, echo, continuation] of [["flipped", "flipped", "resume"], ["flipped", "flipped", "fresh"], ["none", "none", "fresh"]] as const) {
    test(`an echo that is ${name} for a ${continuation} set fails the start`, async () => {
      const h = createHarness();
      await formatted(h);
      h.setBehavior({ continuationEcho: echo });
      await expect(h.host.start(h.workspaceId, { resume: resume(continuation) })).rejects.toMatchObject({ code: "protocol" });
      expect(h.host.activeWorkspaces()).toEqual([]);
    });
  }
  test("an `either` set accepts whichever the guest ran", async () => {
    const h = createHarness();
    await formatted(h);
    h.setBehavior({ continuationEcho: "flipped" }); // the fake runs `either` as fresh; flipped reports resume
    const running = await h.host.start(h.workspaceId, { resume: resume("either") });
    expect(running.continuations).toEqual(["resume"]);
  });
  test("a tools-only set echoes nothing, and a set with the wrong count is refused", async () => {
    const toolsOnly = (context: CoworkNativeConversationContext): CoworkNativeConversationSet => ({ profile: null, conversations: [{ ...guidedConversation(context, "conv-0001", "backend-0001", 20000), runtime: null }] });
    const h = createHarness({ conversations: toolsOnly });
    expect((await h.host.start(h.workspaceId)).continuations).toEqual([]);
  });
});

describe("the fault to lost mapping", () => {
  test("resume_store_missing marks the store lost (once) and fails the start; fresh_store_not_empty is a refusal only", async () => {
    const lost: string[] = [];
    const h = createHarness();
    await formatted(h);
    h.setBehavior({ conversations: "store-missing" });
    await expect(h.host.start(h.workspaceId, { resume: { continuation: "resume", endedGuestBoots: [] }, storeLost: reason => lost.push(reason) })).rejects.toMatchObject({ code: "guest_fault" });
    expect(lost).toEqual(["resume_store_missing"]);
    const g = createHarness({ behavior: { conversations: "fresh-store-not-empty" } });
    const other: string[] = [];
    await expect(g.host.start(g.workspaceId, { storeLost: reason => other.push(reason) })).rejects.toMatchObject({ code: "guest_fault" });
    expect(other).toEqual([]);
  });
  test("a storeLost that throws does not hide the failed start", async () => {
    const h = createHarness();
    await formatted(h);
    h.setBehavior({ conversations: "store-missing" });
    await expect(h.host.start(h.workspaceId, { resume: { continuation: "resume", endedGuestBoots: [] }, storeLost: () => { throw new Error("db"); } })).rejects.toMatchObject({ code: "guest_fault" });
  });
});

describe("the store volume's UUID", () => {
  const stored = (h: Harness) => h.guestRecords!.storeVolumeUuid(h.workspaceId);
  test("the first start records the data volume's UUID once; later starts compare", async () => {
    const h = createHarness();
    expect(stored(h)).toBeNull();
    const running = await h.host.start(h.workspaceId);
    const uuid = h.volumes.records(h.workspaceId).find(volume => volume.purpose === "data")!.filesystemUUID;
    expect(stored(h)).toBe(uuid);
    await running.stop();
    await (await h.host.start(h.workspaceId)).stop();
    expect(stored(h)).toBe(uuid);
  });
  test("a different recorded UUID refuses the start before anything moves, and marks a resuming store lost", async () => {
    const h = await formatted(createHarness());
    h.db.db.run("UPDATE cowork_workspaces SET store_volume_uuid=? WHERE workspace_id=?", [OLDER_BOOT, h.workspaceId]);
    const lost: string[] = [];
    await expect(h.host.start(h.workspaceId, { storeLost: reason => lost.push(reason) })).rejects.toMatchObject({ code: "store_lost" });
    expect(lost).toEqual([]); // a fresh start has no store to lose
    await expect(h.host.start(h.workspaceId, { resume: { continuation: "either", endedGuestBoots: [] }, storeLost: reason => lost.push(reason) })).rejects.toMatchObject({ code: "store_lost" });
    expect(lost).toEqual(["volume_mismatch"]);
    expect(h.launcher.sessions).toHaveLength(1); // only the formatting start; no launcher was spawned for the refused ones
    expect(h.volumes.records(h.workspaceId).every(volume => volume.owner === null)).toBe(true);
    expect(h.records.get(h.workspaceId).power).toBe("stopped");
    expect(stored(h)).toBe(OLDER_BOOT); // never overwritten
  });
  test("a store the host believes exists over a never-formatted data volume is lost, and the volume is not touched", async () => {
    const h = createHarness();
    const lost: string[] = [];
    await expect(h.host.start(h.workspaceId, { resume: { continuation: "resume", endedGuestBoots: [] }, storeLost: reason => lost.push(reason) })).rejects.toMatchObject({ code: "store_lost" });
    expect(lost).toEqual(["volume_unformatted"]);
    expect(h.volumes.records(h.workspaceId).map(volume => volume.filesystemState)).toEqual(["unformatted", "unformatted"]);
    expect(h.launcher.sessions).toHaveLength(0);
  });
});

describe("host-backed shares", () => {
  const folder = (root: string, name: string, sourceId: string, revision: number): CoworkNativeHostShare => { const hostPath = join(root, name); mkdirSync(hostPath); return { tag: `f-${name}`, kind: "folder", guestPath: `/workspace/folders/${name}`, readOnly: false, hostPath, sourceId, revision }; };
  const harnessWithShares = (behavior = {}) => createHarness({ behavior, shareDirectories: createCoworkShareDirectoryOpener() });
  test("shares go out on L1 with one open directory each before begin, then on the bootstrap; the mounted folder sources are reported before the set", async () => {
    const root = scratch(), h = harnessWithShares();
    const shares = [folder(root, "notes", "src-1", 3), folder(root, "app", "src-2", 5)];
    const mounted: unknown[] = [], order: string[] = [];
    await h.host.start(h.workspaceId, { shares: () => shares, sharesMounted: (_context, list) => { order.push("mounted"); mounted.push(...list); } });
    const sent = h.launcher.last.received.filter(item => item.message.t === "shares");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.rights).toHaveLength(2);
    expect(h.launcher.last.received.map(item => item.message.t).indexOf("shares")).toBeLessThan(h.launcher.last.received.map(item => item.message.t).indexOf("begin"));
    expect((sent[0]!.message as unknown as { shares: { tag: string; path: string; mode: string }[] }).shares.map(share => [share.tag, share.path, share.mode])).toEqual(shares.map(share => [share.tag, share.hostPath, "rw"]));
    expect(h.launcher.last.bootstrapShares).toHaveLength(1);
    expect(mounted).toEqual([{ sourceId: "src-1", revision: 3 }, { sourceId: "src-2", revision: 5 }]);
    expect(order).toEqual(["mounted"]);
    expect(h.launcher.last.conversationSets).toHaveLength(1); // the set came after
  });
  test("no shares requested: nothing extra goes out", async () => {
    const h = harnessWithShares();
    await h.host.start(h.workspaceId, { shares: () => null, sharesMounted: () => { throw new Error("never"); } });
    expect(h.launcher.last.received.some(item => item.message.t === "shares")).toBe(false);
    expect(h.launcher.last.bootstrapShares).toHaveLength(0);
  });
  test("a guest fault at the shares, a silent guest and a wrong echo each fail the start and never report a share mounted", async () => {
    for (const shares of ["fault", "silent", "wrong-nonce"] as const) {
      const root = scratch(), h = harnessWithShares({ shares });
      let called = 0;
      await expect(h.host.start(h.workspaceId, { shares: () => [folder(root, "notes", "src-1", 1)], sharesMounted: () => { called += 1; } })).rejects.toBeDefined();
      expect(called).toBe(0);
      expect(h.launcher.last.conversationSets).toHaveLength(0);
    }
  });
  test("a sharesMounted that throws is share_mount_failed: the start fails before the set", async () => {
    const root = scratch(), h = harnessWithShares();
    await expect(h.host.start(h.workspaceId, { shares: () => [folder(root, "notes", "src-1", 1)], sharesMounted: () => { throw new Error("refused"); } })).rejects.toMatchObject({ code: "guest_fault", detail: "share_mount_failed" });
    expect(h.launcher.last.conversationSets).toHaveLength(0);
  });
  test("a share the host cannot open as exactly a canonical directory refuses the start before begin", async () => {
    const root = scratch();
    const real = join(root, "real"); mkdirSync(real);
    const link = join(root, "link"); symlinkSync(real, link);
    const file = join(root, "file"); writeFileSync(file, "x");
    for (const hostPath of [link, file, join(root, "missing")]) {
      const h = harnessWithShares();
      await expect(h.host.start(h.workspaceId, { shares: () => [{ tag: "f-x", kind: "folder", guestPath: "/workspace/folders/x", readOnly: true, hostPath, sourceId: "s", revision: 1 }] })).rejects.toMatchObject({ code: "prepare_failed" });
      expect(h.launcher.last.received.some(item => item.message.t === "begin")).toBe(false);
    }
  });
  test("shares without a directory opener are refused", async () => {
    const root = scratch(), h = createHarness();
    await expect(h.host.start(h.workspaceId, { shares: () => [folder(root, "notes", "src-1", 1)] })).rejects.toMatchObject({ code: "prepare_failed" });
  });
});

describe("the outputs directory and the plan view", () => {
  test("the outputs directory is made for a conversation that names it, before the set; it is idempotent and refuses a symlink or a file", () => {
    const home = scratch(), outputs = join(home, "cowork", "workspaces", "ws1", "shared", "outputs");
    mkdirSync(outputs, { recursive: true });
    const prepare = createCoworkOutputsPreparer(home);
    prepare.ensure("ws1", "conv-0001");
    prepare.ensure("ws1", "conv-0001");
    expect(() => prepare.ensure("ws1", "../escape")).toThrow(expect.objectContaining({ code: "invalid_name" }));
    expect(() => prepare.ensure("ws1", ".")).toThrow(expect.objectContaining({ code: "invalid_name" }));
    symlinkSync(home, join(outputs, "linked"));
    expect(() => prepare.ensure("ws1", "linked")).toThrow(expect.objectContaining({ code: "not_directory" }));
    writeFileSync(join(outputs, "plain"), "x");
    expect(() => prepare.ensure("ws1", "plain")).toThrow(expect.objectContaining({ code: "not_directory" }));
    expect(() => prepare.ensure("ws-none", "conv-0001")).toThrow(expect.objectContaining({ code: "root_unusable" }));
    const sibling = join(home, "cowork", "workspaces", "ws2", "shared"); mkdirSync(sibling, { recursive: true }); symlinkSync(outputs, join(sibling, "outputs"));
    expect(() => prepare.ensure("ws2", "conv-0001")).toThrow(expect.objectContaining({ code: "root_unusable" })); // a symlinked root
  });
  test("the host asks the preparer for each outputs root the set names, before it sends; a failure refuses the start", async () => {
    const asked: string[] = [];
    const h = createHarness({ outputs: { ensure: (workspaceId, session) => { asked.push(`${workspaceId}:${session}`); } } });
    await h.host.start(h.workspaceId);
    expect(asked).toEqual([`${h.workspaceId}:conv-0001`]);
    const g = createHarness({ outputs: { ensure: () => { throw new Error("no"); } } });
    await expect(g.host.start(g.workspaceId)).rejects.toMatchObject({ code: "prepare_failed" });
    expect(g.launcher.last.conversationSets).toHaveLength(0);
  });
  const planSet = (epoch: number) => (context: CoworkNativeConversationContext): CoworkNativeConversationSet => {
    const base = guidedConversation(context, "conv-0001", "backend-0001", 20000);
    return { profile: "host-query-guided-v1", conversations: [{ ...base, policy: "plan", roots: [
      { id: "root-notes", guestPath: "/workspace/folders/notes", source: "/workspace/folders/notes", readOnly: true },
      { id: "plan-scratch", guestPath: `/workspace/plan/conv-0001/${epoch}`, source: `/workspace/plan/conv-0001/${epoch}`, readOnly: false }] }] };
  };
  test("a plan view for the current epoch is sent; an earlier epoch is never mounted again, the same one and a later one are", async () => {
    const h = createHarness();
    const request = (epoch: number): CoworkNativeStartRequest => ({ conversations: planSet(epoch) });
    await (await h.host.start(h.workspaceId, request(3))).stop();
    expect(lastSet(h).conversations[0]!.roots.map(root => root.guestPath)).toContain("/workspace/plan/conv-0001/3");
    await expect(h.host.start(h.workspaceId, request(2))).rejects.toMatchObject({ code: "protocol" });
    await (await h.host.start(h.workspaceId, request(3))).stop();
    await (await h.host.start(h.workspaceId, request(4))).stop();
    await expect(h.host.start(h.workspaceId, request(3))).rejects.toMatchObject({ code: "protocol" });
  });
});

describe("the coordinate tool class and the plan view on the wire", () => {
  const withClasses = (toolClasses: string[]) => (context: CoworkNativeConversationContext): CoworkNativeConversationSet => {
    const base = guidedConversation(context, "conv-0001", "backend-0001", 20000);
    return { profile: "host-query-guided-v1", conversations: [{ ...base, runtime: { ...base.runtime!, toolClasses: toolClasses as never } }] };
  };
  test("`coordinate` is the fourth class, last in the order; an out-of-order, repeated or unknown class is refused", async () => {
    const h = createHarness({ conversations: withClasses(["read", "write", "execute", "coordinate"]) });
    await h.host.start(h.workspaceId);
    expect((lastSet(h).conversations[0]!.runtime as unknown as { toolClasses: string[] }).toolClasses).toEqual(["read", "write", "execute", "coordinate"]);
    for (const bad of [["coordinate", "read"], ["read", "read"], ["read", "message"], ["execute", "write"]]) {
      const g = createHarness({ conversations: withClasses(bad) });
      await expect(g.host.start(g.workspaceId)).rejects.toMatchObject({ code: "protocol" });
    }
  });
  test("under plan only the own plan view may be writable; any other writable root, a read-only plan view or a plan view outside plan is refused", async () => {
    const roots = (policy: "plan" | "ask", other: { readOnly: boolean }, view: { readOnly: boolean; path?: string }) => (context: CoworkNativeConversationContext): CoworkNativeConversationSet => {
      const base = guidedConversation(context, "conv-0001", "backend-0001", 20000);
      const path = view.path ?? "/workspace/plan/conv-0001/1";
      return { profile: "host-query-guided-v1", conversations: [{ ...base, policy, roots: [{ id: "root-notes", guestPath: "/workspace/folders/notes", source: "/workspace/folders/notes", readOnly: other.readOnly }, { id: "scratch", guestPath: path, source: path, readOnly: view.readOnly }] }] };
    };
    const ok = createHarness({ conversations: roots("plan", { readOnly: true }, { readOnly: false }) });
    await ok.host.start(ok.workspaceId);
    for (const [name, build] of [
      ["another writable root under plan", roots("plan", { readOnly: false }, { readOnly: false })],
      ["a read-only plan view", roots("plan", { readOnly: true }, { readOnly: true })],
      ["a plan view outside plan", roots("ask", { readOnly: false }, { readOnly: false })],
      ["another session's plan view", roots("plan", { readOnly: true }, { readOnly: false, path: "/workspace/plan/conv-9999/1" })],
      ["a leading-zero epoch", roots("plan", { readOnly: true }, { readOnly: false, path: "/workspace/plan/conv-0001/01" })],
    ] as const) {
      const h = createHarness({ conversations: build });
      await expect(h.host.start(h.workspaceId), name).rejects.toMatchObject({ code: "protocol" });
    }
  });
});
