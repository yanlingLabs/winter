import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NativeControllerClient, NativeOperationError } from "./client";

const root = process.env.WINTER_COWORK_NATIVE_TEST_BUILD ?? readFileSync(join(import.meta.dir, "out/latest-build.txt"), "utf8").trim();
const paths = { addonPath: join(root, "winter-cowork-native.node"), libraryPath: join(root, "libWinterCoworkNative.dylib") };
const scope = { protocolVersion: 1 as const, workspaceId: "fixture-workspace", incarnationId: "fixture-incarnation", grantRevision: 7, leaseEpoch: 4 };
const ready = new Set<string>(), bytes: Uint8Array[] = [];
const client = new NativeControllerClient({ ...paths, scope, backend: "fake", onEvent(event) {
  if (event.kind === "processRegistered") ready.add(event.operationId);
  if (event.kind === "stdout") bytes.push(Buffer.from(event.dataBase64!, "base64"));
} });
await client.request("start");
const execution = client.submit("exec", { taskId: "transport", arguments: ["wait-input"] });
for (let i = 0; i < 2000 && !ready.has(execution.operationId); i++) await Bun.sleep(1);
assert(ready.has(execution.operationId));
await client.writeInput(execution.operationId, "transport", Buffer.from("first"));
await client.writeInput(execution.operationId, "transport", Buffer.from("second"));
await client.request("closeInput", { ownerOperationId: execution.operationId, taskId: "transport" });
assert.equal((await execution.done).terminalStatus, "completed");
assert.equal(Buffer.concat(bytes).toString(), "firstsecond");
await client.shutdown(1000);
const blocked = new NativeControllerClient({ ...paths, scope });
await assert.rejects(blocked.request("start"), (error: unknown) => error instanceof NativeOperationError && error.code === "cowork_gate_blocked");
await blocked.shutdown(1000);
console.log(JSON.stringify({ nativeTypedClient: true, orderedAcknowledgedInput: true, productionFeatureBlocked: true, realVM: false }));
