// Child process for the kill test in peer-inbox-sqlite.test.ts. Runs a tight loop of one store operation until the
// parent sends SIGKILL, printing a line after each COMMITTED operation. Synthetic data only.
import { openRuntimeStateDb } from "../../../src/runtime-state/db";
import { SqlitePeerInboxStore } from "../../../src/cowork/peer-inbox-sqlite";
import type { PeerInboxCaps } from "../../../src/cowork/peer-inbox";

const [home, mode] = [process.argv[2]!, process.argv[3]!];
const store = new SqlitePeerInboxStore(openRuntimeStateDb(home));
const caps: PeerInboxCaps = { maxUnresolvedPerRecipient: 1_000_000, maxUnresolvedPerSenderRecipient: 1_000_000, maxUnresolvedBytesPerRecipient: 1 << 30 };
const entry = (n: number) => ({ receiptId: `r${n}`, senderSessionId: "s_a", senderIncarnation: "inc-1", sendId: `m${n}`, recipientSessionId: "s_r", digest: "d".repeat(64), size: 0, acceptedAt: n });
const body = (n: number) => `kill-test-body-${n}-` + "x".repeat(2_000);
const put = (n: number) => { const text = body(n); return store.append({ ...entry(n), size: Buffer.byteLength(text) }, text, caps); };

const PRELOAD = 120;
if (mode !== "append") for (let n = 1; n <= PRELOAD; n++) put(n);
if (mode === "remove") for (let n = 1; n <= PRELOAD; n++) store.update(`r${n}`, 1, { state: "delivered", reason: null, updatedAt: n });
console.log("ready");
if (mode === "append") for (let n = 1; ; n++) { put(n); console.log(`done ${n}`); }
else if (mode === "terminal") for (let n = 1; n <= PRELOAD; n++) { store.update(`r${n}`, 1, { state: "delivered", reason: null, updatedAt: n }); console.log(`done ${n}`); }
else for (let n = 1; n <= PRELOAD; n++) { store.remove(`r${n}`); console.log(`done ${n}`); }
console.log("finished");
