import { afterEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { inspect } from "node:util";
import { join } from "node:path";
import { CoworkNativeSimulatedCrash } from "../../../src/cowork/native/host";
import { coworkNativeReceiptMacInput, parseCoworkNativeLauncherLine, parseCoworkNativeStopReceipt, serializeCoworkNativeLauncherLine, serializeCoworkNativeStopReceipt, signCoworkNativeOrderlyReceipt, verifyCoworkNativeOrderlyReceiptMac } from "../../../src/cowork/native/protocol";
import { COWORK_NATIVE_RECEIPT_KEY_ACCOUNT, CoworkNativeReceiptKey, CoworkNativeReceiptKeyError, CoworkNativeReceiptKeyStore, computeCoworkNativeReceiptMac, isCanonicalBase64Of32Bytes, verifyCoworkNativeReceiptMac } from "../../../src/cowork/native/receipt-mac";
import { CoworkNativeRecovery } from "../../../src/cowork/native/recovery";
import { cleanupHarnesses, createHarness, RECEIPT_KEY, type Harness } from "./harness";

afterEach(() => { cleanupHarnesses(); });

// Owner ruling 2026-10-18: a retained Class A receipt counts only if its MAC verifies under the Keychain key AND both guard probes pass.
const vectors = JSON.parse(readFileSync(join(import.meta.dir, "vectors", "stop-receipts.json"), "utf8")).macVectors as {
  keyUtf8: string; keyHex: string; keyBase64: string;
  positive: { name: string; receipt: string; macInput: string; macBase64: string; macHex: string }[];
  negative: { name: string; text: string; expect: string }[];
};
const lineVectors = JSON.parse(readFileSync(join(import.meta.dir, "vectors", "launcher-lines.json"), "utf8")) as { positive: { name: string; line: string; direction: "to-daemon" | "to-launcher"; rights: number }[]; negative: { name: string; line: string; direction: "to-daemon" | "to-launcher"; rights: number; error: string }[] };
const key = CoworkNativeReceiptKey.fromBytes(Buffer.from(vectors.keyUtf8));
const code = (body: () => unknown): string => { try { body(); return "accepted"; } catch (error) { return (error as { code?: string }).code ?? String(error); } };

describe("the golden MAC vectors (the oracle the Swift launcher re-pins to)", () => {
  test("the synthetic key is the documented one", () => {
    expect(Buffer.from(vectors.keyUtf8).length).toBe(32);
    expect(vectors.keyHex).toBe(Buffer.from(vectors.keyUtf8).toString("hex"));
    expect(key.reveal()).toBe(vectors.keyBase64);
  });
  test("every positive receipt parses, round-trips and verifies; its MAC input and MAC are exactly the recorded ones, computed here WITHOUT the code under test", () => {
    expect(vectors.positive.length).toBeGreaterThanOrEqual(3);
    for (const entry of vectors.positive) {
      const receipt = parseCoworkNativeStopReceipt(entry.receipt);
      expect(serializeCoworkNativeStopReceipt(receipt)).toBe(entry.receipt);
      expect(coworkNativeReceiptMacInput(receipt as never)).toBe(entry.macInput);
      // the receipt text is the MAC input with the mac key appended before the closing brace
      expect(entry.receipt).toBe(`${entry.macInput.slice(0, -1)},"mac":"${entry.macBase64}"}\n`);
      const independent = createHmac("sha256", Buffer.from(vectors.keyUtf8)).update(Buffer.from(entry.macInput, "utf8")).digest();
      expect(independent.toString("hex")).toBe(entry.macHex);
      expect(independent.toString("base64")).toBe(entry.macBase64);
      expect(verifyCoworkNativeOrderlyReceiptMac(receipt as never, key)).toBe(true);
    }
  });
  test("every negative receipt is refused the way the vector says: wrong or malformed MACs never verify, missing or malformed ones do not parse", () => {
    for (const entry of vectors.negative) {
      let outcome: string;
      try { outcome = verifyCoworkNativeOrderlyReceiptMac(parseCoworkNativeStopReceipt(entry.text) as never, key) ? "mac-valid" : "mac-invalid"; } catch (error) { outcome = `parse:${(error as { code?: string }).code}`; }
      expect(`${entry.name}:${outcome}`).toBe(`${entry.name}:${entry.expect}`);
      expect(entry.expect).not.toBe("mac-valid");
    }
    expect(vectors.negative.map(entry => entry.name)).toEqual(expect.arrayContaining(["wrong-mac-right-shape", "missing-mac", "mac-31-bytes", "signed-with-another-key"]));
  });
  test("a receipt verifies under no key but the one that signed it, and not with no key at all", () => {
    const receipt = parseCoworkNativeStopReceipt(vectors.positive[0]!.receipt) as never;
    expect(verifyCoworkNativeOrderlyReceiptMac(receipt, CoworkNativeReceiptKey.fromBytes(Buffer.from("synthetic-other-key-012345678901")))).toBe(false);
    expect(verifyCoworkNativeOrderlyReceiptMac(receipt, null)).toBe(false);
  });
  test("the begin vector carries the synthetic key as its last key, and every key defect is refused", () => {
    const begin = lineVectors.positive.find(entry => entry.name === "begin")!;
    expect(begin.line.endsWith(`,"receiptKey":"${vectors.keyBase64}"}\n`)).toBe(true);
    const parsed = parseCoworkNativeLauncherLine(begin.line, "to-launcher") as unknown as { receiptKey: CoworkNativeReceiptKey };
    expect(parsed.receiptKey.reveal()).toBe(vectors.keyBase64);
    expect(serializeCoworkNativeLauncherLine(parsed as never, "to-launcher")).toBe(begin.line);
    const defects = lineVectors.negative.filter(entry => entry.name.startsWith("begin-receipt-key") || entry.name === "begin-version-one");
    expect(defects.map(entry => entry.name)).toEqual(expect.arrayContaining(["begin-receipt-key-missing", "begin-receipt-key-31-bytes", "begin-receipt-key-33-bytes", "begin-receipt-key-hex", "begin-receipt-key-unpadded", "begin-receipt-key-after-home"]));
    for (const entry of defects) expect(`${entry.name}:${code(() => parseCoworkNativeLauncherLine(entry.line, entry.direction, entry.rights))}`).toBe(`${entry.name}:${entry.error}`);
  });
});

describe("the key value never prints", () => {
  test("every textual form of the key is redacted, and the typed begin message does not carry it as text", () => {
    const secret = key.reveal();
    for (const text of [JSON.stringify(key), String(key), `${key}`, inspect(key), JSON.stringify({ nested: { key } }), inspect({ nested: { key } }, { depth: 5 })])
      expect(text.includes(secret) || text.includes(vectors.keyHex) || text.includes(vectors.keyUtf8)).toBe(false);
    expect(Object.keys(key)).toEqual([]);
    const begin = parseCoworkNativeLauncherLine(lineVectors.positive.find(entry => entry.name === "begin")!.line, "to-launcher");
    expect(JSON.stringify(begin).includes(secret)).toBe(false);
    expect(inspect(begin, { depth: 6 }).includes(secret)).toBe(false);
  });
  test("serializing a begin whose key is anything but the wrapper is refused, never stringified", () => {
    const begin = parseCoworkNativeLauncherLine(lineVectors.positive.find(entry => entry.name === "begin")!.line, "to-launcher") as unknown as Record<string, unknown>;
    for (const bad of [vectors.keyBase64, Buffer.from(vectors.keyUtf8), { reveal: () => vectors.keyBase64 }, null, undefined]) expect(code(() => serializeCoworkNativeLauncherLine({ ...begin, receiptKey: bad } as never, "to-launcher"))).toBe("bad_field");
  });
  test("a key of the wrong length cannot be built, and the helpers fail closed", () => {
    for (const length of [0, 16, 31, 33, 64]) expect(() => CoworkNativeReceiptKey.fromBytes(new Uint8Array(length))).toThrow("receipt_key_length");
    for (const text of [null, 7, "", "abc", Buffer.alloc(31).toString("base64"), Buffer.alloc(33).toString("base64"), vectors.keyHex, vectors.keyBase64.replace(/=+$/, "")]) { expect(CoworkNativeReceiptKey.fromBase64(text)).toBeNull(); expect(isCanonicalBase64Of32Bytes(text)).toBe(false); }
    expect(verifyCoworkNativeReceiptMac(null, "x", computeCoworkNativeReceiptMac(key, "x"))).toBe(false);
    expect(verifyCoworkNativeReceiptMac(key, "x", undefined)).toBe(false);
    expect(verifyCoworkNativeReceiptMac(key, "x", computeCoworkNativeReceiptMac(key, "x"))).toBe(true);
    expect(verifyCoworkNativeReceiptMac(key, "y", computeCoworkNativeReceiptMac(key, "x"))).toBe(false);
  });
  test("the comparison is the constant-time one", () => {
    const source = readFileSync(join(import.meta.dir, "..", "..", "..", "src", "cowork", "native", "receipt-mac.ts"), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
    expect(source).toContain("timingSafeEqual(key.hmac(input), Buffer.from(mac, \"base64\"))");
    expect(/[^=!]===?\s*mac|mac\s*!?==/.test(source)).toBe(false);
  });
});

describe("the Keychain slot", () => {
  const slotOf = (initial: Record<string, string> = {}) => {
    const values = new Map(Object.entries(initial)), calls: string[] = [];
    return { values, calls, get: async (name: string) => { calls.push(`get:${name}`); return values.get(name) ?? null; }, set: async (name: string, value: string) => { calls.push(`set:${name}`); values.set(name, value); } };
  };
  test("created on first need under the Cowork account, 32 random bytes, and read back the same", async () => {
    const slot = slotOf(), store = new CoworkNativeReceiptKeyStore(slot);
    expect(COWORK_NATIVE_RECEIPT_KEY_ACCOUNT).toBe("cowork-native-receipt-mac-v1");
    const first = await store.ensure();
    expect([...slot.values.keys()]).toEqual(["cowork-native-receipt-mac-v1"]);
    expect(isCanonicalBase64Of32Bytes(slot.values.get(COWORK_NATIVE_RECEIPT_KEY_ACCOUNT))).toBe(true);
    expect(slot.values.get(COWORK_NATIVE_RECEIPT_KEY_ACCOUNT)).toBe(first.reveal());
    expect((await new CoworkNativeReceiptKeyStore(slot).ensure()).equals(first)).toBe(true);
    expect(slot.calls.filter(call => call.startsWith("set:"))).toHaveLength(1);
    expect((await new CoworkNativeReceiptKeyStore(slotOf()).ensure()).equals(first)).toBe(false); // random per installation
  });
  test("read never creates: a missing, malformed or unreadable slot is no key", async () => {
    const empty = slotOf();
    expect(await new CoworkNativeReceiptKeyStore(empty).read()).toBeNull();
    expect(empty.calls).toEqual(["get:cowork-native-receipt-mac-v1"]);
    expect(await new CoworkNativeReceiptKeyStore(slotOf({ [COWORK_NATIVE_RECEIPT_KEY_ACCOUNT]: "not a key" })).read()).toBeNull();
    const broken = { get: async () => { throw new Error("keychain locked"); }, set: async () => { throw new Error("must not be called"); } };
    expect(await new CoworkNativeReceiptKeyStore(broken).read()).toBeNull();
  });
  test("ensure replaces a malformed value, but never overwrites a slot it could not READ", async () => {
    const malformed = slotOf({ [COWORK_NATIVE_RECEIPT_KEY_ACCOUNT]: "garbage" });
    const made = await new CoworkNativeReceiptKeyStore(malformed).ensure();
    expect(malformed.values.get(COWORK_NATIVE_RECEIPT_KEY_ACCOUNT)).toBe(made.reveal());
    let wrote = false;
    const locked = { get: async () => { throw new Error("keychain locked"); }, set: async () => { wrote = true; } };
    await expect(new CoworkNativeReceiptKeyStore(locked).ensure()).rejects.toMatchObject({ code: "receipt_key_unreadable" });
    expect(wrote).toBe(false);
    const readOnly = { get: async () => null, set: async () => { throw new Error("denied"); } };
    await expect(new CoworkNativeReceiptKeyStore(readOnly).ensure()).rejects.toBeInstanceOf(CoworkNativeReceiptKeyError);
    // a write that does not persist is not a key
    const lossy = { get: async () => null, set: async () => {} };
    await expect(new CoworkNativeReceiptKeyStore(lossy).ensure()).rejects.toMatchObject({ code: "receipt_key_unwritable" });
  });
  test("concurrent first asks create ONE key", async () => {
    const slot = slotOf(), store = new CoworkNativeReceiptKeyStore(slot);
    const keys = await Promise.all([store.ensure(), store.ensure(), store.ensure()]);
    expect(slot.calls.filter(call => call.startsWith("set:"))).toHaveLength(1);
    expect(keys.every(candidate => candidate.equals(keys[0]!))).toBe(true);
  });
  test("an error never carries key material", async () => {
    const material = key.reveal();
    const slot = { get: async () => material, set: async () => { throw new Error(`denied ${material}`); } };
    const malformed = { get: async () => `${material}!`, set: async () => { throw new Error(`denied ${material}`); } };
    for (const candidate of [slot, malformed]) { const error = await new CoworkNativeReceiptKeyStore(candidate).ensure().then(() => null, (e: Error) => e); if (error) expect(`${error.message}${error.stack}`.includes(material)).toBe(false); }
  });
});

// ------------------------------------------------------------------------------------------ the retained path

const keyOf = (h: Harness) => { const ws = h.records.get(h.workspaceId); return `${ws.workspaceId}|${ws.incarnationId}|${ws.leaseEpoch}`; };
const owners = (h: Harness) => h.volumes.records(h.workspaceId).map(v => v.owner);
async function crashedWithReceipt(forge?: (receipt: ReturnType<Harness["launcher"]["last"]["stagedOrderly"]>) => string): Promise<Harness> {
  const h = createHarness({ crashAt: "power-running" });
  await expect(h.host.start(h.workspaceId)).rejects.toBeInstanceOf(CoworkNativeSimulatedCrash);
  const receipt = h.launcher.last.stagedOrderly("cc".repeat(16), { origin: "owner-loss-drain" });
  h.restart();
  h.receipts.set(keyOf(h), forge ? forge(receipt) : serializeCoworkNativeStopReceipt(receipt));
  return h;
}
const flipMac = (receipt: { mac: string }) => (receipt.mac[0] === "A" ? "B" : "A") + receipt.mac.slice(1);

describe("a retained Class A receipt needs its MAC and then both guards", () => {
  test("a forged file (right shape, wrong MAC) releases nothing even with both guards passing, and the file stays", async () => {
    const h = await crashedWithReceipt(receipt => serializeCoworkNativeStopReceipt({ ...receipt, mac: flipMac(receipt) }));
    expect(h.guards.processAbsent && h.guards.imagesUnlocked).toBe(true);
    for (let round = 0; round < 2; round++) expect(h.host.bootReconcile()).toMatchObject([{ action: "retained", ownerRetained: true, reason: expect.stringContaining("mac_invalid") }]);
    expect(h.host.recover(h.workspaceId)).toMatchObject({ action: "retained" });
    expect(h.calls.volumeRelease).toBe(0); expect(h.calls.ledgerRelease).toBe(0);
    expect(owners(h).every(owner => owner !== null)).toBe(true);
    expect(h.receipts.size).toBe(1);
    expect(h.guards.seen).toEqual([]); // a forged file never even reached the question about the old worker
  });
  test("a file signed under another key, a receipt edited after signing and a file with no MAC all fail the same way", async () => {
    const other = CoworkNativeReceiptKey.fromBytes(Buffer.from("synthetic-other-key-012345678901"));
    for (const make of [
      (r: { mac: string } & Record<string, unknown>) => serializeCoworkNativeStopReceipt(signCoworkNativeOrderlyReceipt((({ mac: _m, ...rest }) => rest)(r) as never, other)),
      (r: { mac: string } & Record<string, unknown>) => serializeCoworkNativeStopReceipt({ ...r, issuedAtMs: (r.issuedAtMs as number) + 1 } as never),
      (r: { mac: string } & Record<string, unknown>) => serializeCoworkNativeStopReceipt(r as never).replace(/,"mac":"[^"]*"\}\n$/, "}\n"),
    ]) {
      const h = await crashedWithReceipt(make as never);
      expect(h.host.recover(h.workspaceId)).toMatchObject({ action: "retained", ownerRetained: true });
      expect(h.calls.volumeRelease).toBe(0);
      cleanupHarnesses();
    }
  });
  test("a valid MAC with a failing guard is still no evidence (the guards stay mandatory)", async () => {
    const h = await crashedWithReceipt();
    h.guards.processAbsent = false;
    expect(h.host.recover(h.workspaceId)).toMatchObject({ action: "retained", reason: expect.stringContaining("guard_failed") });
    h.guards.processAbsent = true; h.guards.imagesUnlocked = false;
    expect(h.host.recover(h.workspaceId)).toMatchObject({ action: "retained", reason: expect.stringContaining("guard_failed") });
    expect(h.calls.volumeRelease).toBe(0);
  });
  test("a valid MAC and both guards releases, once, and retires the file", async () => {
    const h = await crashedWithReceipt();
    expect(h.host.recover(h.workspaceId)).toMatchObject({ action: "released", evidence: "orderly-receipt", ownerRetained: false });
    expect(owners(h)).toEqual([null, null]);
    expect(h.receipts.size).toBe(0);
  });
  test("no key (missing, unreadable, or no key source at all) makes the receipt Class B: nothing releases", async () => {
    const h = await crashedWithReceipt();
    for (const receiptKey of [(() => null), (() => { throw new Error("keychain locked"); }), undefined]) {
      const recovery = new CoworkNativeRecovery({ records: h.records, volumes: h.volumes, admission: h.ledger, power: h.power, registry: h.registry, hostBoot: h.hostBoot, guards: { processAbsent: () => true, imagesUnlocked: () => true },
        receipts: { load: scope => { const text = h.receipts.get(`${scope.workspaceId}|${scope.incarnationId}|${scope.leaseEpoch}`); return text === undefined ? null : { text, attested: true }; }, retire: () => {} }, ...(receiptKey ? { receiptKey } : {}) });
      expect(recovery.recover(h.workspaceId)).toMatchObject({ action: "retained", ownerRetained: true, reason: expect.stringContaining("mac_invalid") });
    }
    expect(owners(h).every(owner => owner !== null)).toBe(true);
  });
  test("the replay-debt path demands the MAC too: a forged copy of the old writer's receipt does not let the successor start", async () => {
    const h = createHarness();
    await (await h.host.start(h.workspaceId)).stop();
    h.restart({ crashAt: "receipt-received" });
    await expect(h.host.start(h.workspaceId)).rejects.toBeInstanceOf(CoworkNativeSimulatedCrash);
    const crashed = h.launcher.last, key2 = keyOf(h);
    const good = serializeCoworkNativeStopReceipt(crashed.stagedOrderly("ab".repeat(16), { origin: "owner-loss-drain" }));
    h.restart();
    h.receipts.set(key2, good);
    expect(h.host.bootReconcile()).toMatchObject([{ action: "released", evidence: "orderly-receipt" }]);
    h.restart();
    const goodReceipt = parseCoworkNativeStopReceipt(good) as unknown as { mac: string };
    const forged = serializeCoworkNativeStopReceipt({ ...goodReceipt, mac: flipMac(goodReceipt) } as never);
    h.receipts.set(key2, forged);
    await expect(h.host.start(h.workspaceId)).rejects.toMatchObject({ name: "CoworkNativeHostError" });
    expect(h.volumes.records(h.workspaceId)[0]!.filesystemJournal!.replayDebt).toBeDefined();
    h.restart();
    h.receipts.set(key2, good);
    expect((await h.host.start(h.workspaceId)).leaseEpoch).toBe(4);
  });
  test("the launcher only ever signs with the key it was handed in begin: the daemon's key reaches begin and the receipts verify under it", async () => {
    const h = createHarness();
    await (await h.host.start(h.workspaceId)).stop();
    const session = h.launcher.sessions[0]!;
    expect(session.receiptKey?.equals(RECEIPT_KEY)).toBe(true);
    expect(verifyCoworkNativeOrderlyReceiptMac(session.stagedOrderly("11".repeat(16)), RECEIPT_KEY)).toBe(true);
  });
  test("a start without a receipt key refuses before anything moves", async () => {
    const h = createHarness();
    const before = h.records.get(h.workspaceId).leaseEpoch;
    (h.deps as { receiptKey: () => null }).receiptKey = () => null;
    const { CoworkNativeHost } = await import("../../../src/cowork/native/host");
    const host = new CoworkNativeHost({ ...h.deps, receiptKey: () => null });
    await expect(host.start(h.workspaceId)).rejects.toMatchObject({ code: "no_receipt_key" });
    expect(h.records.get(h.workspaceId).leaseEpoch).toBe(before);
    expect(h.launcher.spawned).toEqual([]);
  });
});
