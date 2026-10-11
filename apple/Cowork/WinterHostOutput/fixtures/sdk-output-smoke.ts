import { strict as assert } from "node:assert";
import { copyFileSync,existsSync,mkdirSync,mkdtempSync,realpathSync,rmSync,writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadFixtureHostOutputFactory } from "../../../../packages/core/src/runtime-sdk/host-output-loader";
import { HostCodeExecutionService,withHostCodeBinding,type HostCodeSdkAdapter,type HostCodeRegistration } from "../../../../packages/core/src/runtime-sdk/host-code-broker";
import { registerHostStorageFences } from "../../../../packages/core/src/runtime-sdk/host-storage-fence";
// Explicit local checkout fixture. These source imports never enter production
// loader/service resolution and do not change Winter's installed runtime pin.
import { createHostCodeProcessRegistration } from "../../../../../winter-agent-sdk/packages/runtime/src/sandbox/host-code-broker";
import { hostCodeExecutionLimitsFor } from "../../../../../winter-agent-sdk/packages/runtime/src/sandbox/execution-limits";
import { buildPwdCaptureScript } from "../../../../../winter-agent-sdk/packages/runtime/src/tools/bash-pwd-capture";
import { buildHostSandboxRunInputs } from "../../../../../winter-agent-sdk/packages/runtime/src/tools/sandbox-run-inputs";
import { applyMandatoryFloorToSpawnOptions } from "../../../../../winter-agent-sdk/packages/sdk/src/mandatory-floor";
import { HOST_CODE_PROCESS_SUBTYPES as ops,type HostCodeProcessStartReply,type HostCodeProcessPollReply } from "../../../../../winter-agent-sdk/packages/sdk/src/host-code-process";
import type { Options,SpawnClaudeCodeProcess } from "@yanlinglabs/winter-agent-sdk";

const bundle=process.argv[2];assert(bundle?.startsWith("/"),"explicit output-only fixture bundle required");
const root=realpathSync(mkdtempSync(join(tmpdir(),"winter-sdk-native-output-")));
try{
const home=join(root,"home"),source=join(root,"source"),temp=join(root,"temp"),coord=join(root,"coordination"),store=join(root,"runtime-store");
for(const path of [home,source,temp,coord,store])mkdirSync(path);
const resources=join(root,"Fixture.app/Contents/Resources"),output=join(resources,"native/host-output");mkdirSync(output,{recursive:true});
for(const name of ["winter-host-output.node","manifest.json"])copyFileSync(join(bundle,name),join(output,name));
writeFileSync(join(resources,"winter-core"),"private fixture label");mkdirSync(join(home,"cowork"));
const unregister=registerHostStorageFences(home,{coordinationDir:coord,coworkStorageActive:true});
const factory=loadFixtureHostOutputFactory({corePath:join(resources,"winter-core"),verifySignature:()=>true});
let registration!:HostCodeRegistration,created=0,resolveRuntimeExit!:(code:number)=>void;
const runtimeExit=new Promise<number>(resolve=>{resolveRuntimeExit=resolve});
const adapter:HostCodeSdkAdapter={requiresNativeOutput:true,
  applyFloor:applyMandatoryFloorToSpawnOptions as HostCodeSdkAdapter["applyFloor"],
  register:input=>{assert(input.createOutputTransport);created++;registration=createHostCodeProcessRegistration(input as Parameters<typeof createHostCodeProcessRegistration>[0]);return registration},
  executionLimits:hostCodeExecutionLimitsFor,buildPwdCaptureScript,buildRunInputs:buildHostSandboxRunInputs as HostCodeSdkAdapter["buildRunInputs"]};
const syntheticRuntimeSpawn:SpawnClaudeCodeProcess=()=>({exited:runtimeExit}) as ReturnType<SpawnClaudeCodeProcess>;
const service=new HostCodeExecutionService(home,adapter,syntheticRuntimeSpawn,{createOutputTransport:factory});
const abort=new AbortController();let allowed="";
const options=withHostCodeBinding({sandbox:{enabled:false}} as Options,{home,sessionId:"logical",backendSessionId:"backend",allowedCwds:[source],tempDir:temp,policyRevision:()=>"fixture-policy",authorize:async call=>call.input.command===allowed});
const generation=service.enroll({options,sessionId:"logical",backendSessionId:"backend",generation:1,abort,isCurrent:()=>true,stop:async()=>{}});
generation.options.spawnClaudeCodeProcess!({command:"/bin/true",args:[],cwd:source,env:{PATH:"/usr/bin:/bin",HOME:home,WINTER_HOME:home,WINTER_STORE_HOME:store},signal:abort.signal});
const context={generationId:generation.generationId,callerSessionId:"backend",signal:abort.signal};
let acknowledgedOutputBytes=0;
async function run(id:string,command:string){
  allowed=command;const input={command,timeout:3000};
  generation.observe({type:"tool_call",sessionId:"logical",callId:id,threadId:"main",name:"Bash",argsJson:JSON.stringify(input)});
  await generation.completeHook({tool_name:"Bash",tool_use_id:id,session_id:"backend",cwd:source},abort.signal);
  const limits=hostCodeExecutionLimitsFor("Bash",input);
  const started=await registration.handle(ops.start,{version:1,generationId:generation.generationId,sessionId:"backend",toolUseId:id,kind:"command",cwd:source,command,...limits,sandboxIntent:"ordinary"},context) as HostCodeProcessStartReply;
  let sequence=0,bytes=0,out="",err="";
  for(;;){const reply=await registration.handle(ops.poll,{handle:started.handle,afterSequence:sequence,maxBytes:65536,maxWaitMs:30000},context) as HostCodeProcessPollReply;
    for(const event of reply.events){sequence=event.sequence;const chunk=Buffer.from(event.dataBase64,"base64");bytes+=chunk.length;if(event.stream==="stdout")out+=chunk.toString();else err+=chunk.toString()}
    if(reply.exit){await registration.handle(ops.release,{handle:started.handle,afterSequence:sequence},context);return{bytes,out,err,exit:reply.exit}}
  }
}
try{
  assert.equal(created,1,"trusted service must inject factory into actual SDK registration");
  const result=await run("output","printf packaged-stdout; printf packaged-stderr >&2");assert.equal(result.out,"packaged-stdout");assert.equal(result.err,"packaged-stderr");assert.equal(result.exit.code,0);
  const marker=join(home,"cowork/forbidden-marker");await run("floor",`printf denied > '${marker}'; printf survived`);assert(!existsSync(marker));
  const pressure=await run("pressure","dd if=/dev/zero bs=65536 count=32 2>/dev/null");assert.equal(pressure.bytes,2*1024*1024);assert.equal(pressure.exit.code,0);
  acknowledgedOutputBytes=pressure.bytes;
}finally{generation.dispose();resolveRuntimeExit(0);try{const drain=await registration.drained;assert.equal(drain.status,"confirmed");assert(drain.confirmedProcessCount>=3)}finally{unregister()}}
console.log(JSON.stringify({actualSdkBroker:true,trustedCoreServiceFactory:true,outputOnlyPackagedAddon:true,noVZDependency:true,exactStdoutStderr:true,mandatoryFloorStillEnforced:true,acknowledgedOutputBytes,ownedDrainConfirmed:true,fixtureRuntimeOnly:true,realVM:false,actualKeychain:false,workflowAuthorityProved:false}));
}finally{rmSync(root,{recursive:true,force:true})}
