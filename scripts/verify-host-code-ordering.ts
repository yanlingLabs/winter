/** Explicit source-level integration fixture, separate from production/pinned SDK proof. */
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { createProjector } from "../packages/core/src/projector";
import { FakeCheckpoints } from "../packages/core/test/projector/harness";
import { HostCodeExecutionService, withHostCodeBinding, withResolvedHostCodeSpawn, type HostCodeSdkAdapter } from "../packages/core/src/runtime-sdk/host-code-broker";
import { registerHostStorageFences } from "../packages/core/src/runtime-sdk/host-storage-fence";
const at = process.argv.indexOf("--sdk-root");
if (at < 0 || !process.argv[at+1]) throw new Error("--sdk-root <isolated checkout> is required");
const sdkRoot = realpathSync(resolve(process.argv[at+1]!));
const sdk = await import(pathToFileURL(join(sdkRoot, "packages/sdk/src/index.ts")).href);
const runtime = await import(pathToFileURL(join(sdkRoot, "packages/runtime/src/index.ts")).href);
if (runtime.HOST_CODE_EXECUTION_LIMITS_VERSION !== 1) throw new Error("trusted SDK limit contract absent");
for (const timeout of [Infinity, NaN, -1, 0.5, 120000, 900000]) {
  const expected = runtime.hostCodeExecutionLimitsFor("Bash", { timeout });
  if (!Number.isFinite(expected.timeoutMs)) throw new Error("SDK emitted an invalid host timeout");
}
const root = realpathSync(mkdtempSync(join(tmpdir(), "winter-real-sdk-ordering-"))), home = join(root,"home"), source = join(root,"source"), temp = join(root,"temp"), coordination = join(root,"coordination");
for (const path of [home,source,temp,coordination]) mkdirSync(path);
mkdirSync(join(home,"cowork"));
const unregister = registerHostStorageFences(home,{coordinationDir:coordination,coworkStorageActive:true});
const abort = new AbortController();
const events: Array<{type:string;callId?:string}> = [], order: string[] = [], failures: string[] = [];
let sequence = 0, hookCalls = 0;
const projector = createProjector({sessionId:"fixture-logical",mode:"code",generation:1,winterSessionId:"fixture-logical",nextSeq:()=>sequence+1,checkpoint:new FakeCheckpoints(),now:()=>new Date().toISOString(),log:{}});
const adapter: HostCodeSdkAdapter = {
  // Fixture isolation comes from private HOME + a child whose executor refuses every call.
  // This deliberately makes no claim of a kernel floor or a native output factory.
  applyFloor: options => options,
  register: runtime.createHostCodeProcessRegistration,
  executionLimits: runtime.hostCodeExecutionLimitsFor,
  buildPwdCaptureScript: runtime.buildPwdCaptureScript,
  buildRunInputs: runtime.buildHostSandboxRunInputs,
  buildHookEntries: runtime.buildHookEntriesFromConfig,
  createHookStage: runtime.createHostCodeHookStage,
};
const service = new HostCodeExecutionService(home,adapter,sdk.defaultSpawn);
let generation: ReturnType<typeof service.enroll> | undefined;
let query: AsyncGenerator<unknown> | undefined;
try {
  const options = withHostCodeBinding({ sessionId:"fixture-backend",model:"winter-test/echo",cwd:source,pathToClaudeCodeExecutable:process.execPath,tools:["Bash"],persistSession:false,abortController:abort,
    env:{HOME:home,WINTER_HOME:home,WINTER_STORE_HOME:home,WINTER_DISABLE_GIT_INSTRUCTIONS:"1",WINTER_COWORK_SDK_FIXTURE_ROOT:sdkRoot},
    hooks:{PreToolUse:[{matcher:"Bash",failClosed:true,hooks:[async (input: any) => {
      hookCalls++; order.push("PreToolUse");
      if (!events.some(event=>event.type==="tool_call"&&event.callId===input.tool_use_id)) failures.push("PreToolUse preceded actual tool_call projection");
      return {hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:"fixture ordering proof; no command execution"}};
    }]}]},
  } as never,{home,sessionId:"fixture-logical",backendSessionId:"fixture-backend",allowedCwds:[source],tempDir:temp,policyRevision:()=>"fixture-policy",authorize:async()=>false,buildHookContext:()=>({})});
  withResolvedHostCodeSpawn(options, spawn => ({...spawn,command:process.execPath,args:[join(import.meta.dir,"fixtures/host-code-ordering-runtime.ts"),...spawn.args],env:{PATH:"/usr/bin:/bin",HOME:home,WINTER_HOME:home,WINTER_STORE_HOME:home,WINTER_COWORK_SDK_FIXTURE_ROOT:sdkRoot}}));
  generation = service.enroll({options,sessionId:"fixture-logical",backendSessionId:"fixture-backend",generation:1,abort,isCurrent:()=>!abort.signal.aborted,stop:async()=>{abort.abort();}});
  const finalOptions = {...generation.options, hooks:{...generation.options.hooks,PreToolUse:[...(generation.options.hooks?.PreToolUse??[]).map(group=>({...group,hooks:group.hooks.map(callback=>async(input:any,id:any,context:any)=>{order.push("host-hook-dispatch");return callback(input,id,context);})})),{matcher:"Bash",failClosed:true,hooks:[async(input:unknown,_id:unknown,context:{signal:AbortSignal})=>{await generation!.completeHook(input,context.signal);return{};}]}]}};
  const deadline = setTimeout(() => abort.abort(), 10000);
  const answer = sdk.query({prompt:"ordering fixture",options:finalOptions}); query=answer;
  for await (const message of answer) {
    const batch = projector.accept(message);
    for (const event of batch.persist) { events.push(event); sequence++; order.push(event.type); generation.observe(event, event.type === "tool_call" ? (message.message?.content?.find((block:any)=>block.type==="tool_use"&&block.id===event.callId)?.name) : undefined); }
  }
  clearTimeout(deadline);
  if (hookCalls!==1 || failures.length || !events.some(event=>event.type==="tool_call"&&event.callId==="ordering-call")) throw new Error(`ordering fixture failed: ${JSON.stringify({hookCalls,failures,order})}`);
  console.log(JSON.stringify({ok:true,sdkRoot,coverage:"actual SDK query + child runEngine + Core projector before PreToolUse",hookCalls,order,productionActivation:false}));
} catch(error) { console.error(JSON.stringify({hookCalls,failures,order})); throw error; }
finally {abort.abort(); await query?.return(undefined); generation?.dispose();unregister();rmSync(root,{recursive:true,force:true});}
