import { describe, expect, test } from "bun:test";
import { ApprovalBroker } from "../../src/agent/approvals";

describe("ApprovalBroker", () => {
  test("resolve settles the waiting promise, first-wins", async () => {
    const b = new ApprovalBroker();
    const pending = b.wait("s1", "c1", 5000);
    expect(b.resolve("s1", "c1", true, "orb")).toEqual({ ok: true, alreadyResolved: false });
    expect(b.resolve("s1", "c1", false, "cli")).toEqual({ ok: true, alreadyResolved: true }); // late answer acknowledged
    await expect(pending).resolves.toEqual({ approved: true, by: "orb" });
  });

  test("timeout auto-denies", async () => {
    const b = new ApprovalBroker();
    await expect(b.wait("s1", "c2", 20)).resolves.toEqual({ approved: false, by: "timeout" });
  });

  test("resolving an unknown approval reports alreadyResolved", () => {
    const b = new ApprovalBroker();
    expect(b.resolve("s1", "nope", true, "x")).toEqual({ ok: true, alreadyResolved: true });
  });

  test("list returns a session's pending approvals with metadata + expiresAt", () => {
    const b = new ApprovalBroker();
    const meta1 = { toolName: "write", summary: "write a.txt", issuedAt: 1000, expiresAt: 1000 + 5000 };
    const meta2 = { toolName: "bash", summary: "run ls", issuedAt: 2000, expiresAt: 2000 + 5000 };
    void b.wait("s1", "c1", 5000, meta1);
    void b.wait("s1", "c2", 5000, meta2);
    void b.wait("s2", "c3", 5000, { toolName: "read", summary: "read b.txt", issuedAt: 3000, expiresAt: 3000 + 5000 });

    const listed = b.list("s1");
    expect(listed).toEqual([
      { callId: "c1", toolName: "write", summary: "write a.txt", issuedAt: 1000, expiresAt: 6000 },
      { callId: "c2", toolName: "bash", summary: "run ls", issuedAt: 2000, expiresAt: 7000 },
    ]);
    // Scoped by session — s2's approval never appears in s1's list.
    expect(b.list("s2").map((p) => p.callId)).toEqual(["c3"]);
    // Unknown session → empty.
    expect(b.list("nope")).toEqual([]);
  });

  test("list omits an approval once it is resolved", () => {
    const b = new ApprovalBroker();
    void b.wait("s1", "c1", 5000, { toolName: "write", summary: "x", issuedAt: 1000, expiresAt: 6000 });
    void b.wait("s1", "c2", 5000, { toolName: "bash", summary: "y", issuedAt: 1000, expiresAt: 6000 });
    b.resolve("s1", "c1", true, "orb");
    expect(b.list("s1").map((p) => p.callId)).toEqual(["c2"]);
  });

  test("list omits an approval once its timeout fires", async () => {
    const b = new ApprovalBroker();
    const p = b.wait("s1", "c1", 20, { toolName: "write", summary: "x", issuedAt: 1000, expiresAt: 1020 });
    expect(b.list("s1").map((c) => c.callId)).toEqual(["c1"]);
    await p; // let the fail-closed timer fire
    expect(b.list("s1")).toEqual([]);
  });

  test("list falls back to Date.now()/+timeoutMs + empty strings when no meta is passed", () => {
    const b = new ApprovalBroker();
    const before = Date.now();
    void b.wait("s1", "c1", 5000);
    const [entry] = b.list("s1");
    expect(entry.callId).toBe("c1");
    expect(entry.toolName).toBe("");
    expect(entry.summary).toBe("");
    expect(entry.issuedAt).toBeGreaterThanOrEqual(before);
    expect(entry.expiresAt).toBe(entry.issuedAt + 5000);
  });
});
