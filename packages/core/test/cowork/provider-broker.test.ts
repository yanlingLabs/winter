import { beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { CredentialMaterial, ProviderAdapter, ProviderEvent, ResolvedModel } from "@yanlinglabs/winter-provider-runtime";
import { CoworkProviderBroker, type CoworkProviderAdmission, type CoworkProviderRequest, type CoworkProviderScope } from "../../src/cowork/provider-broker";
const scope: CoworkProviderScope = { homeId: "home", workspaceId: "workspace", sessionId: "logical-session", backendSessionId: "sdk-backend", taskId: "task", incarnationId: "incarnation", bootId: "boot", leaseEpoch: 1, grantRevision: 2, accountRevision: 3, modelRevision: 4 };
const KEY = "fixture-host-provider-key-never-transfer";
const credentials = new Map<string, string>([["provider-slot", JSON.stringify({ kind: "api-key", key: KEY })]]);
const secrets = { get: async (key: string) => credentials.get(key) ?? null, set: async (key: string, value: string) => { credentials.set(key, value); }, delete: async (key: string) => credentials.delete(key) };
function fixture(stream: ProviderAdapter["streamTurn"]): CoworkProviderAdmission {
  const adapter: ProviderAdapter = { id: "fixture", version: "1", family: "openai", protocol: "openai-responses", streamTurn: stream, validateCredential: async () => ({ ok: true }), listModels: async () => ({ models: [], partial: false, cached: false, warnings: [] }), mapEffort: effort => ({ ok: true, value: effort }), capabilities: () => ({ toolCalling: "native", readableState: "summary" }) };
  const resolved = { providerId: "openai", modelKey: "openai/fixture-model", providerModelId: "fixture-model", adapterId: adapter.id, adapter, descriptor: undefined, provider: {}, catalogVersion: "fixture", continuationDomain: "openai/fixture-domain" } as ResolvedModel;
  return { scope: { ...scope }, resolved, authRef: { kind: "keychain", account: "provider-slot" }, connection: { providerId: "openai" } };
}
const ordinals=new Map<string,number>(); beforeEach(()=>ordinals.clear());
const ordinal=(id:string)=>{let value=ordinals.get(id);if(value===undefined){value=ordinals.size+1;ordinals.set(id,value);}return value;};
const frame = (id: string, operation: CoworkProviderRequest["operation"], sequence: number, extra = {}): CoworkProviderRequest => ({ version: 1, operation, invocationId: id, scope: { ...scope }, sequence, invocationOrdinal:ordinal(id), ...extra });
const payload = { model: "fixture-model", messages: [{ role: "user" as const, content: "hello" }] };

test("host-held material feeds adapter but never normalized frames/logs; full native/thinking events survive", async () => {
  const logs: unknown[] = [], events: ProviderEvent[] = [{ type: "native_state", items: [{ encrypted_content: "provider-opaque-state" }] }, { type: "native_thinking_block", block: { type: "thinking", thinking: "why", signature: "provider-signature" } }, { type: "thinking_summary_delta", text: "summary" }, { type: "done", stopReason: "end_turn" }];
  const admission = fixture(async function* (_request, ctx) { expect(await ctx.credentials.get(ctx.authRef)).toEqual({ kind: "api-key", key: KEY }); ctx.log({ kind: KEY, providerId: KEY, model: KEY, bytes: 12 }); for (const event of events) yield event; });
  const lease = new CoworkProviderBroker({ secrets, assertCurrent: () => {}, log: value => logs.push(value) }).open(admission); const id = randomUUID(); const replies: unknown[] = [await lease.handle(frame(id, "begin", 0, { turn: payload }))];
  for (let index = 0; index < events.length; index++) replies.push(await lease.handle(frame(id, "next", index + 1)));
  expect(replies.slice(1).map((reply: any) => reply.event)).toEqual(events); expect(JSON.stringify({ replies, logs })).not.toContain(KEY); expect(logs).toEqual([{ kind: "cowork_provider_activity", providerId: "openai", model: "openai/fixture-model", bytes: 12 }]); lease.close();
});

test("no prefetch under backpressure; stale account/model/boot/scope and authority-bearing fields refuse", async () => {
  let pulls = 0, current = true;
  const admission = fixture(async function* () { pulls++; yield { type: "text_delta", text: "first" }; pulls++; yield { type: "done", stopReason: "end_turn" }; });
  const lease = new CoworkProviderBroker({ secrets, assertCurrent: () => { if (!current) throw new Error("authority_denied"); } }).open(admission); const id = randomUUID();
  expect((await lease.handle(frame(id, "begin", 0, { turn: payload }))).kind).toBe("accepted"); expect(pulls).toBe(0);
  expect((await lease.handle(frame(id, "next", 1))).kind).toBe("event"); expect(pulls).toBe(1);
  current = false; expect((await lease.handle(frame(id, "next", 2))).code).toBe("authority_denied"); expect(pulls).toBe(1); lease.close();
  for (const bad of [{ ...payload, model: "other" }, { ...payload, authRef: { kind: "env", name: "TOKEN" } }, { ...payload, connection: { baseUrl: "http://localhost" } }]) {
    const isolated = new CoworkProviderBroker({ secrets, assertCurrent: () => {} }).open(admission); expect((await isolated.handle(frame(randomUUID(), "begin", 0, { turn: bad }))).kind).toBe("refused"); isolated.close();
  }
  for (const key of ["backendSessionId", "taskId", "bootId", "accountRevision", "modelRevision", "grantRevision"] as const) {
    const isolated = new CoworkProviderBroker({ secrets, assertCurrent: () => {} }).open(admission); const wrong = { ...scope, [key]: typeof scope[key] === "number" ? 9 : "other" }; expect((await isolated.handle({ ...frame(randomUUID(), "begin", 0, { turn: payload }), scope: wrong })).code).toBe("authority_denied"); isolated.close();
  }
});

test("credential-bearing normalized output/errors refuse or sanitize, and admitted invocation IDs never replay", async () => {
  let calls = 0;
  const admission = fixture(async function* (_request, ctx) { calls++; await ctx.credentials.get(ctx.authRef); yield { type: "error", error: { code: "auth", message: KEY, retryable: true, status: 401, contextOverflow: true } }; });
  const lease = new CoworkProviderBroker({ secrets, assertCurrent: () => {} }).open(admission); const id = randomUUID(); await lease.handle(frame(id, "begin", 0, { turn: payload }));
  const reply = await lease.handle(frame(id, "next", 1)); expect(reply.event).toEqual({ type: "error", error: { code: "auth", message: "host provider request failed", retryable: false, status: 401, contextOverflow: true } }); expect(JSON.stringify(reply)).not.toContain(KEY);
  expect((await lease.handle(frame(id, "begin", 0, { turn: payload }))).kind).toBe("refused"); expect(calls).toBe(1); lease.close();
  const leaking = fixture(async function* (_request, ctx) { await ctx.credentials.get(ctx.authRef); yield { type: "native_state", items: [{ opaque: KEY }] }; });
  const leakedLease = new CoworkProviderBroker({ secrets, assertCurrent: () => {} }).open(leaking); const leakedId = randomUUID(); await leakedLease.handle(frame(leakedId, "begin", 0, { turn: payload })); expect((await leakedLease.handle(frame(leakedId, "next", 1))).code).toBe("provider_unavailable"); leakedLease.close();
});

test("cancel/close retain exact pending adapter and finalizer before replacement admission", async () => {
  let resolveRead!: (value: IteratorResult<ProviderEvent>) => void, resolveDrain!: (value: IteratorResult<ProviderEvent>) => void, returned = false;
  const admission = fixture(() => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise(resolve => { resolveRead = resolve; }), return: () => { returned = true; return new Promise(resolve => { resolveDrain = resolve; }); } }) }));
  const lease = new CoworkProviderBroker({ secrets, assertCurrent: () => {} }).open(admission); const id = randomUUID(); await lease.handle(frame(id, "begin", 0, { turn: payload }));
  const pending = lease.handle(frame(id, "next", 1)); await Bun.sleep(0);
  expect((await lease.handle(frame(id, "cancel", 2))).code).toBe("effects_uncertain"); expect(returned).toBe(false);
  for(let i=0;i<7;i++) expect((await lease.handle(frame(randomUUID(), "begin", 0, {turn:payload}))).kind).toBe("accepted");
  expect((await lease.handle(frame(randomUUID(), "begin", 0, { turn: payload }))).code).toBe("capacity_busy"); resolveRead({ done: false, value: { type: "text_delta", text: "late" } }); expect((await pending).kind).toBe("refused"); await Bun.sleep(0); expect(returned).toBe(true);
  expect((await lease.handle(frame(randomUUID(), "begin", 0, { turn: payload }))).code).toBe("capacity_busy"); resolveDrain({ done: true, value: undefined }); await Bun.sleep(0);
  expect((await lease.handle(frame(randomUUID(), "begin", 0, { turn: payload }))).kind).toBe("accepted"); lease.close();
});

test("local/user endpoints need explicit host-service grant; guest cannot select one", () => {
  const admission = fixture(async function* () { yield { type: "done", stopReason: "end_turn" }; }); admission.connection = { providerId: "openai", baseUrl: "http://127.0.0.1:1234", local: true };
  expect(() => new CoworkProviderBroker({ secrets, assertCurrent: () => {} }).open(admission)).toThrow("authority_denied");
  const accepted = new CoworkProviderBroker({ secrets, assertCurrent: () => {} }).open({ ...admission, endpointGrant: true }); accepted.close();
});

test("one shared host refresh revalidates each waiting channel before handing material to its adapter", async () => {
  const local = new Map<string, string>([["provider-slot", JSON.stringify({ kind: "api-key", key: "fixture-old-material" })]]);
  const ownSecrets = { get: async (key: string) => local.get(key) ?? null, set: async (key: string, value: string) => { local.set(key, value); }, delete: async (key: string) => local.delete(key) };
  let finishRefresh!: () => void, calls = 0, waiting = 0, revokedB = false; const upstreamStarted: string[] = [];
  const gate = new Promise<void>(resolve => { finishRefresh = resolve; });
  const broker = new CoworkProviderBroker({ secrets: ownSecrets, assertCurrent: admission => { if (admission.scope.taskId === "task-b" && revokedB) throw new Error("authority_denied"); }, refresh: async () => { calls++; await gate; local.set("provider-slot", JSON.stringify({ kind: "api-key", key: "fixture-new-material" })); } });
  const forTask = (task: string) => fixture(async function* (_request, ctx) { await ctx.credentials.get(ctx.authRef); waiting++; const material = await ctx.credentials.refresh!(ctx.authRef as Extract<typeof ctx.authRef, { kind: "keychain" }>); expect(material).toEqual({ kind: "api-key", key: "fixture-new-material" }); upstreamStarted.push(task); yield { type: "done", stopReason: "end_turn" }; });
  const a = broker.open(forTask("a")), bAdmission = forTask("b"); bAdmission.scope = { ...scope, taskId: "task-b", backendSessionId: "backend-b", sessionId: "logical-b" }; const b = broker.open(bAdmission), aid = randomUUID(), bid = randomUUID();
  await a.handle(frame(aid, "begin", 0, { turn: payload })); await b.handle({ ...frame(bid, "begin", 0, { turn: payload }), scope: bAdmission.scope });
  const apull = a.handle(frame(aid, "next", 1)), bpull = b.handle({ ...frame(bid, "next", 1), scope: bAdmission.scope });
  await Bun.sleep(0); expect(waiting).toBe(2); expect(calls).toBe(1); revokedB = true; finishRefresh();
  expect((await apull).event?.type).toBe("done"); expect((await bpull).code).toBe("authority_denied"); expect(upstreamStarted).toEqual(["a"]); expect(calls).toBe(1); a.close(); b.close();
});

test("slow valid model returns bounded pending poll and retains one next operation without abort or replay", async () => {
  let deliver!: (value: IteratorResult<ProviderEvent>) => void, nexts = 0, aborted = false;
  const admission = fixture((_request, ctx) => ({ [Symbol.asyncIterator]: () => ({ next: () => { nexts++; return new Promise(resolve => { deliver = resolve; }); }, return: async () => ({ done: true, value: undefined }) }) }));
  admission.resolved.adapter.streamTurn = (request, _ctx) => { request.signal!.addEventListener("abort", () => { aborted = true; }); return { [Symbol.asyncIterator]: () => ({ next: () => { nexts++; return new Promise(resolve => { deliver = resolve; }); }, return: async () => ({ done: true, value: undefined }) }) }; };
  const lease = new CoworkProviderBroker({ secrets, assertCurrent: () => {} }).open(admission), id = randomUUID(); await lease.handle(frame(id, "begin", 0, { turn: payload }));
  const before = performance.now(), pending = await lease.handle(frame(id, "next", 1)); expect(pending.kind).toBe("pending"); expect(performance.now() - before).toBeGreaterThan(4900); expect(nexts).toBe(1); expect(aborted).toBe(false);
  const again = lease.handle(frame(id, "next", 2)); await Bun.sleep(0); expect(nexts).toBe(1); deliver({ done: false, value: { type: "done", stopReason: "end_turn" } }); expect((await again).event?.type).toBe("done"); expect(nexts).toBe(1);
  expect((await lease.handle(frame(id, "next", 2))).kind).toBe("refused"); lease.close();
}, 12_000);

test("concurrent pulls refuse and oversized events never enter the private output channel", async () => {
  let deliver!: (value: IteratorResult<ProviderEvent>) => void, nexts = 0;
  const admission = fixture(() => ({ [Symbol.asyncIterator]: () => ({ next: () => { nexts++; return new Promise(resolve => { deliver = resolve; }); }, return: async () => ({ done: true, value: undefined }) }) }));
  const lease = new CoworkProviderBroker({ secrets, assertCurrent: () => {} }).open(admission), id = randomUUID(); await lease.handle(frame(id, "begin", 0, { turn: payload })); const pending = lease.handle(frame(id, "next", 1)); await Bun.sleep(0);
  expect((await lease.handle(frame(id, "next", 2))).kind).toBe("refused"); expect(nexts).toBe(1); deliver({ done: false, value: { type: "text_delta", text: "late" } }); expect((await pending).kind).toBe("refused"); lease.close();
  const overflow = fixture(async function* () { yield { type: "native_state", items: ["x".repeat(256 * 1024)] }; }); const oversized = new CoworkProviderBroker({ secrets, assertCurrent: () => {} }).open(overflow), overflowId = randomUUID(); await oversized.handle(frame(overflowId, "begin", 0, { turn: payload })); const result = await oversized.handle(frame(overflowId, "next", 1)); expect(result.code).toBe("limit"); expect(result.event).toBeUndefined(); oversized.close();
});

test("iterator finalizer that yields rather than ends retains admission instead of inventing cleanup", async () => {
  const admission = fixture(() => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: false, value: { type: "text_delta", text: "partial" } as ProviderEvent }), return: async () => ({ done: false, value: { type: "text_delta", text: "cleanup still yielding" } as ProviderEvent }) }) }));
  const lease = new CoworkProviderBroker({ secrets, assertCurrent: () => {} }).open(admission), id = randomUUID(); await lease.handle(frame(id, "begin", 0, { turn: payload })); await lease.handle(frame(id, "next", 1));
  expect((await lease.handle(frame(id, "cancel", 2))).code).toBe("effects_uncertain"); await Bun.sleep(0); for(let i=0;i<7;i++)expect((await lease.handle(frame(randomUUID(), "begin", 0, {turn:payload}))).kind).toBe("accepted"); expect((await lease.handle(frame(randomUUID(), "begin", 0, { turn: payload }))).code).toBe("capacity_busy"); lease.close();
});

test("malformed decoded input refuses with bounded identity instead of throwing packet data", async () => {
  const admission = fixture(async function* () { throw new Error("never invoked"); }); const lease = new CoworkProviderBroker({ secrets, assertCurrent: () => {} }).open(admission);
  for (const invalid of [null, {}, { version: 1, invocationId: "x".repeat(5000), sequence: -1 }]) {
    const response = await lease.handle(invalid as CoworkProviderRequest); expect(response.kind).toBe("refused"); expect(response.invocationId.length).toBe(36); expect(response.sequence).toBe(0);
  }
  lease.close();
});

test("parallel turns isolate cancellation, abort upstream and admit later work",async()=>{
 let aborted=false;
 const admission=fixture(async function*(request){
  if(request.messages[0]?.content==="hold") {await new Promise<void>(resolve=>request.signal?.addEventListener("abort",()=>{aborted=true;resolve();},{once:true}));yield {type:"text_delta",text:"late cancelled output"};}
  else yield {type:"text_delta",text:"independent output"};
  yield {type:"done",stopReason:"end_turn"};
 });
 const lease=new CoworkProviderBroker({secrets,assertCurrent:()=>{}}).open(admission),a=randomUUID(),b=randomUUID();
 expect((await lease.handle(frame(a,"begin",0,{turn:{...payload,messages:[{role:"user",content:"hold"}]}}))).kind).toBe("accepted");
 expect((await lease.handle(frame(b,"begin",0,{turn:payload}))).kind).toBe("accepted");
 const held=lease.handle(frame(a,"next",1));await Bun.sleep(0);
 expect((await lease.handle(frame(b,"next",1))).event).toMatchObject({text:"independent output"});
 expect((await lease.handle(frame(a,"cancel",2))).kind).toBe("closed");expect(aborted).toBe(true);
 expect((await held).kind).toBe("refused");expect((await lease.handle(frame(b,"next",2))).event?.type).toBe("done");
 expect((await lease.handle(frame(randomUUID(),"begin",0,{turn:payload}))).kind).toBe("accepted");lease.close();
});
test("cancel before begin fences only that invocation and is idempotent",async()=>{
 let calls=0;const lease=new CoworkProviderBroker({secrets,assertCurrent:()=>{}}).open(fixture(async function*(){calls++;yield {type:"done",stopReason:"end_turn"};}));
 const id=randomUUID();expect((await lease.handle(frame(id,"cancel",1))).kind).toBe("closed");expect((await lease.handle(frame(id,"cancel",1))).kind).toBe("closed");
 expect((await lease.handle(frame(id,"begin",0,{turn:payload}))).kind).toBe("refused");expect(calls).toBe(0);
 const next=randomUUID();expect((await lease.handle(frame(next,"begin",0,{turn:payload}))).kind).toBe("accepted");expect((await lease.handle(frame(next,"next",1))).event?.type).toBe("done");expect(calls).toBe(1);lease.close();
});

test("close retains all pending turns and releases each global capacity slot exactly once",async()=>{
 const completions:Array<(value:IteratorResult<ProviderEvent>)=>void>=[];let returns=0,aborts=0;
 const admission=fixture(request=>{request.signal?.addEventListener("abort",()=>{aborts++;},{once:true});return {[Symbol.asyncIterator]:()=>({next:()=>new Promise(resolve=>{completions.push(resolve);}),return:async()=>{returns++;return {done:true,value:undefined};}})};});
 const broker=new CoworkProviderBroker({secrets,assertCurrent:()=>{}}),leases=Array.from({length:4},()=>broker.open(admission)),pending:Promise<unknown>[]=[];
 for(const lease of leases)for(let i=0;i<8;i++){const id=randomUUID();expect((await lease.handle(frame(id,"begin",0,{turn:payload}))).kind).toBe("accepted");pending.push(lease.handle(frame(id,"next",1)));}
 await Bun.sleep(0);for(const lease of leases){lease.close();lease.close();}expect(aborts).toBe(32);expect(returns).toBe(0);
 const quick=fixture(async function*(){yield {type:"done",stopReason:"end_turn"};});const other=broker.open(quick);
 expect((await other.handle(frame(randomUUID(),"begin",0,{turn:payload}))).code).toBe("capacity_busy");
 for(const complete of completions)complete({done:false,value:{type:"text_delta",text:"discarded"}});
 await Promise.all(pending);await Bun.sleep(0);expect(returns).toBe(32);
 const replacement=Array.from({length:4},()=>broker.open(quick));
 for(const lease of replacement)for(let i=0;i<8;i++)expect((await lease.handle(frame(randomUUID(),"begin",0,{turn:payload}))).kind).toBe("accepted");
 expect((await other.handle(frame(randomUUID(),"begin",0,{turn:payload}))).code).toBe("capacity_busy");for(const lease of replacement)lease.close();other.close();
});
test("5000 sequential invocations keep bounded replay state without ending the lease",async()=>{
 const lease=new CoworkProviderBroker({secrets,assertCurrent:()=>{}}).open(fixture(async function*(){yield {type:"done",stopReason:"end_turn"};}));
 let first="";
 for(let i=1;i<=5000;i++){const id=randomUUID();if(i===1)first=id;expect((await lease.handle(frame(id,"begin",0,{turn:payload,invocationOrdinal:i}))).kind).toBe("accepted");expect((await lease.handle(frame(id,"next",1,{invocationOrdinal:i}))).event?.type).toBe("done");await Promise.resolve();}
 expect((await lease.handle(frame(first,"begin",0,{turn:payload,invocationOrdinal:1}))).kind).toBe("refused");lease.close();
});
test("out-of-order invocation ordinals are consumed once within a bounded reorder window",async()=>{
 const lease=new CoworkProviderBroker({secrets,assertCurrent:()=>{}}).open(fixture(async function*(){yield {type:"done",stopReason:"end_turn"};}));
 const first=randomUUID(),second=randomUUID();
 expect((await lease.handle(frame(second,"begin",0,{turn:payload,invocationOrdinal:2}))).kind).toBe("accepted");
 expect((await lease.handle(frame(first,"begin",0,{turn:payload,invocationOrdinal:1}))).kind).toBe("accepted");
 expect((await lease.handle(frame(randomUUID(),"begin",0,{turn:payload,invocationOrdinal:1}))).kind).toBe("refused");
 expect((await lease.handle(frame(randomUUID(),"begin",0,{turn:payload,invocationOrdinal:131}))).kind).toBe("refused");lease.close();
});
test("late terminal event returns without waiting for its slow finalizer",async()=>{
 let finish!:()=>void,retired=false;
 const admission=fixture(()=>({[Symbol.asyncIterator]:()=>({next:async()=>{await Bun.sleep(4000);return {done:false,value:{type:"done",stopReason:"end_turn"} as ProviderEvent};},return:async()=>{await new Promise<void>(resolve=>{finish=resolve;});retired=true;return {done:true,value:undefined};}})}));
 const broker=new CoworkProviderBroker({secrets,assertCurrent:()=>{}}),lease=broker.open(admission),id=randomUUID();
 await lease.handle(frame(id,"begin",0,{turn:payload}));const started=performance.now();
 const response=await lease.handle(frame(id,"next",1));expect(response.event?.type).toBe("done");expect(performance.now()-started).toBeLessThan(5500);expect(retired).toBe(false);
 const other=broker.open(fixture(async function*(){yield {type:"done",stopReason:"end_turn"};})),otherId=randomUUID();
 expect((await other.handle(frame(otherId,"begin",0,{turn:payload}))).kind).toBe("accepted");expect((await other.handle(frame(otherId,"next",1))).event?.type).toBe("done");
 await Bun.sleep(4000);expect(retired).toBe(false);finish();await Bun.sleep(0);expect(retired).toBe(true);lease.close();other.close();
},12000);

test("cancelled future ordinal advances when its gap arrives without admitting a delayed begin",async()=>{
 const lease=new CoworkProviderBroker({secrets,assertCurrent:()=>{}}).open(fixture(async function*(){yield {type:"done",stopReason:"end_turn"};}));
 const cancelled=randomUUID(),first=randomUUID(),third=randomUUID();
 expect((await lease.handle(frame(cancelled,"cancel",1,{invocationOrdinal:2}))).kind).toBe("closed");
 expect((await lease.handle(frame(first,"begin",0,{turn:payload,invocationOrdinal:1}))).kind).toBe("accepted");
 expect((await lease.handle(frame(cancelled,"begin",0,{turn:payload,invocationOrdinal:2}))).kind).toBe("refused");
 expect((await lease.handle(frame(third,"begin",0,{turn:payload,invocationOrdinal:3}))).kind).toBe("accepted");lease.close();
});
test("background finalizer rejection retains its slot without delaying a terminal event",async()=>{
 const lease=new CoworkProviderBroker({secrets,assertCurrent:()=>{}}).open(fixture(()=>({[Symbol.asyncIterator]:()=>({next:async()=>({done:false,value:{type:"done",stopReason:"end_turn"} as ProviderEvent}),return:async()=>{throw new Error("fixture finalizer uncertain");}})})));
 const id=randomUUID();await lease.handle(frame(id,"begin",0,{turn:payload}));expect((await lease.handle(frame(id,"next",1))).event?.type).toBe("done");await Bun.sleep(0);
 for(let i=0;i<7;i++)expect((await lease.handle(frame(randomUUID(),"begin",0,{turn:payload}))).kind).toBe("accepted");
 expect((await lease.handle(frame(randomUUID(),"begin",0,{turn:payload}))).code).toBe("capacity_busy");lease.close();
});
