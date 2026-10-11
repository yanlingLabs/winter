import { strict as assert } from "node:assert";
import { join } from "node:path";
import { readFileSync } from "node:fs";

// No-VM native-addon integration. No daemon/store/credential import is present.
const buildRoot = process.env.WINTER_COWORK_NATIVE_TEST_BUILD ?? readFileSync(join(import.meta.dir, "out/latest-build.txt"), "utf8").trim();
const addon = require(join(buildRoot, "winter-cowork-native.node"));
const scope = { protocolVersion: 1, workspaceId: "fixture-workspace", incarnationId: "fixture-incarnation", grantRevision: 7, leaseEpoch: 4 };
const controller = addon.open(join(buildRoot, "libWinterCoworkNative.dylib"), JSON.stringify({ backend: "fake", scope, fakeDelayMilliseconds: 2 }));
const pending = new Map<string, (event: any) => void>();
const registered = new Set<string>();
const events: any[] = [];
controller.subscribe((json: string) => {
  const event = JSON.parse(json); events.push(event);
  assert.deepEqual(event.scope, scope);
  if (event.kind === "processRegistered") registered.add(event.operationId);
  if (event.kind === "terminal") { pending.get(event.operationId)?.(event); pending.delete(event.operationId); }
});
function request(kind: string, extra: Record<string, unknown> = {}) {
  const id: bigint = controller.submit(JSON.stringify({ scope, kind, ...extra }));
  assert.equal(typeof id, "bigint");
  const done = new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("No-VM addon request timeout")), 2000);
    pending.set(String(id), event => { clearTimeout(timer); resolve(event); });
  });
  return { id: String(id), done };
}
async function waitRegistered(id: string) {
  for (let i = 0; i < 2000; i++) { if (registered.has(id)) return; await Bun.sleep(1); }
  throw new Error("Native process ownership registration missing");
}
assert.equal((await request("start").done).terminalStatus, "completed");
const long = request("exec", { taskId: "first", arguments: ["long", "one"] });
const other = request("exec", { taskId: "second", arguments: ["echo", "two"] });
await waitRegistered(long.id);
assert.equal((await request("cancel", { taskId: "second", ownerOperationId: long.id }).done).code, "task_ownership_denied");
assert.equal((await request("cancel", { taskId: "first", ownerOperationId: long.id }).done).terminalStatus, "completed");
assert.equal((await long.done).terminalStatus, "cancelled");
assert.equal((await other.done).terminalStatus, "completed");
const io = request("exec", { taskId: "io", arguments: ["wait-input"] });
await waitRegistered(io.id);
assert.equal((await request("input", { taskId: "io", ownerOperationId: io.id, inputBase64: Buffer.from("bounded-transport").toString("base64") }).done).terminalStatus, "completed");
assert.equal((await request("closeInput", { taskId: "io", ownerOperationId: io.id }).done).terminalStatus, "completed");
assert.equal((await io.done).terminalStatus, "completed");
assert.equal(Buffer.concat(events.filter(event => event.operationId === io.id && event.kind === "stdout").map(event => Buffer.from(event.dataBase64, "base64"))).toString(), "bounded-transport");
assert.equal((await request("shutdown", { stopBudgetMilliseconds: 1000 }).done).terminalStatus, "completed");
for (let i = 0; i < 200; i++) { if (controller.close()) { console.log(JSON.stringify({ backend: "fake", nodeAPI: true, eventFD: true, concurrentExec: true, independentCancellation: true, boundedInputOutput: true, realVM: false })); break; } await Bun.sleep(1); }
