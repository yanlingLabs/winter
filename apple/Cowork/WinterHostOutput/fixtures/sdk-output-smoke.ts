import { strict as assert } from "node:assert";
import { copyFileSync,existsSync,mkdirSync,mkdtempSync,realpathSync,rmSync,writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { loadFixtureHostOutputFactory } from "../../../../packages/core/src/runtime-sdk/host-output-loader";
import type { HostCodeSdkAdapter,HostCodeRegistration } from "../../../../packages/core/src/runtime-sdk/host-code-broker";
import type { WinterRuntimeSdk } from "../../../../packages/core/src/runtime-sdk/create";
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
const constructorMode=process.argv[3]==="--constructor";
const root=realpathSync(mkdtempSync(join(tmpdir(),"winter-sdk-native-output-")));
try{
const home=join(root,"home"),source=join(root,"source"),temp=join(root,"temp"),coord=join(root,"coordination"),store=join(root,"runtime-store");
for(const path of [home,source,temp,coord,store])mkdirSync(path);
const resources=join(root,"Fixture.app/Contents/Resources"),output=join(resources,"native/host-output");mkdirSync(output,{recursive:true});
for(const name of ["winter-host-output.node","manifest.json"])copyFileSync(join(bundle,name),join(output,name));
writeFileSync(join(resources,"winter-core"),"private fixture label");mkdirSync(join(home,"cowork"));
const nativeFactory=loadFixtureHostOutputFactory({corePath:join(resources,"winter-core"),verifySignature:()=>true});
let factoryCalls=0;
const factory=async()=>{factoryCalls++;return nativeFactory()};
let registration!:HostCodeRegistration,created=0,resolveRuntimeExit!:(code:number)=>void,runtimeHandle:WinterRuntimeSdk|undefined;
const runtimeExit=new Promise<number>(resolve=>{resolveRuntimeExit=resolve});
const adapter:HostCodeSdkAdapter={requiresNativeOutput:true,
  applyFloor:applyMandatoryFloorToSpawnOptions as HostCodeSdkAdapter["applyFloor"],
  register:input=>{assert.equal(input.createOutputTransport,factory,"constructor must forward the exact host factory");created++;registration=createHostCodeProcessRegistration(input as Parameters<typeof createHostCodeProcessRegistration>[0]);return registration},
  executionLimits:hostCodeExecutionLimitsFor,buildPwdCaptureScript,buildRunInputs:buildHostSandboxRunInputs as HostCodeSdkAdapter["buildRunInputs"]};
const syntheticRuntimeSpawn:SpawnClaudeCodeProcess=()=>({exited:runtimeExit}) as ReturnType<SpawnClaudeCodeProcess>;
const resolvePackage=(name:string)=>Bun.resolveSync(name,fileURLToPath(new URL("../../../../packages/core/src/runtime-sdk/",import.meta.url)));
if(constructorMode){
  // This child alone publishes the actual local SDK functions at the package
  // binding consumed by the default service. No constructor/service is mocked,
  // no production knob is added, and no installed/released SDK proof is implied.
  const {mock}=await import("bun:test");
  // Bun's package resolution may use its canonical cache module identity;
  // patch the exact ESM path Core resolves, not Node's distinct cache alias.
  const clientPath=resolvePackage("@yanlinglabs/winter-agent-sdk"),serverPath=resolvePackage("@yanlinglabs/winter-agent-runtime");
  // Capture base exports through a separate fixture module identity before
  // Core's canonical bindings load. Adding exports to an already loaded ESM
  // namespace does not make those capabilities available to its consumers.
  const client=await import(`${clientPath}?constructor-fixture-base`);
  mock.module(clientPath,()=>({...client,MANDATORY_FLOOR_CONTRACT_VERSION:1,HOST_CODE_PROCESS_BROKER_VERSION:1,applyMandatoryFloorToSpawnOptions,defaultSpawn:syntheticRuntimeSpawn}));
  const server=await import(`${serverPath}?constructor-fixture-base`);
  mock.module(serverPath,()=>({...server,HOST_CODE_EXECUTION_LIMITS_VERSION:1,createHostCodeProcessRegistration:adapter.register,hostCodeExecutionLimitsFor,buildPwdCaptureScript,buildHostSandboxRunInputs}));
}
const {registerHostStorageFences}=await import("../../../../packages/core/src/runtime-sdk/host-storage-fence");
const unregister=registerHostStorageFences(home,{coordinationDir:coord,coworkStorageActive:true});
if(constructorMode){
  const {createWinterRuntimeSdk}=await import("../../../../packages/core/src/runtime-sdk/create");
  const {createInMemoryRuntimeDirectoryStore}=await import(resolvePackage("@yanlinglabs/winter-runtime-sdk"));
  const {FileSecretStore}=await import("../../../../packages/core/src/auth/secret-store");
  runtimeHandle=await createWinterRuntimeSdk({home,settings:()=>null,secrets:new FileSecretStore(join(root,"test-secrets")),directoryStore:createInMemoryRuntimeDirectoryStore(),capabilities:[],hostOutputTransportFactory:factory});
}
const {HostCodeExecutionService,withHostCodeBinding}=await import("../../../../packages/core/src/runtime-sdk/host-code-broker");
const service=constructorMode?runtimeHandle!.codeExecution!:new HostCodeExecutionService(home,adapter,syntheticRuntimeSpawn,{createOutputTransport:factory});
assert(service);
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
  assert(factoryCalls>=3,"real SDK registration must invoke the forwarded native factory");
}finally{generation.dispose();resolveRuntimeExit(0);try{const drain=await registration.drained;assert.equal(drain.status,"confirmed");assert(drain.confirmedProcessCount>=3)}finally{try{await runtimeHandle?.dispose()}finally{unregister()}}}
console.log(JSON.stringify({actualSdkBroker:true,trustedCoreServiceFactory:true,constructorDefaultService:constructorMode,packageBinding:constructorMode?"fixture-mocked-with-real-local-sdk-functions":"explicit-local-sdk-adapter",installedReleasedSdk:false,forwardedFactoryCalls:factoryCalls,outputOnlyPackagedAddon:true,noVZDependency:true,exactStdoutStderr:true,mandatoryFloorStillEnforced:true,acknowledgedOutputBytes,ownedDrainConfirmed:true,fixtureRuntimeOnly:true,realVM:false,actualKeychain:false,workflowAuthorityProved:false}));
}finally{rmSync(root,{recursive:true,force:true})}
