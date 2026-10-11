import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AdmissionError, CoworkAdmissionLedger, type AdmissionErrorCode, type AdmissionLedgerOptions, type AdmissionOwner, type AdmissionProbes, type HostIdentity, type HostPreparedHomeBinding, type ProcessObservation, type ResourceObservation, type StopReceipt } from "../../src/cowork/admission";

const roots:string[]=[],handles:CoworkAdmissionLedger[]=[];
afterEach(()=>{ for(const handle of handles.splice(0))handle.close(); for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true}); });
function code(body:()=>unknown,expected:AdmissionErrorCode) { try {body(); throw new Error("expected refusal");} catch(error) {expect(error).toBeInstanceOf(AdmissionError); expect((error as AdmissionError).code).toBe(expected);} }
function fixture() {
  const root=realpathSync(mkdtempSync(join(tmpdir(),"winter-admission-"))); roots.push(root);
  const path=join(root,"coordination/admission.sqlite"),persisted=new Map<string,HostPreparedHomeBinding>(),processes=new Map<number,ProcessObservation>(),proofs=new Set<string>();
  const host:HostIdentity={machineId:"machine-fixture",installationId:"installation-fixture",bootId:"boot-one"};
  let now=1000,previousBootEnded=false,relocationAllowed=false,resources:ResourceObservation|null={budget:{memoryBytes:1024,cpuUnits:4,guestLimit:2},pressure:"normal",admitNew:true,observedAt:0,validUntil:100_000};
  const probes:AdmissionProbes={
    hostIdentity:()=>({...host}),
    homeIdentity:atPath=>{
      try {const canonicalPath=realpathSync(atPath),stat=statSync(canonicalPath),identity=persisted.get(canonicalPath); if(!identity)return null;
        return {canonicalPath,volumeId:`dev-${stat.dev}`,directoryId:`inode-${stat.ino}`,canonicalDbBinding:{...identity}};
      } catch {return null;}
    },
    processIdentity:pid=>processes.get(pid)??{state:"unknown"},
    verifyStopReceipt:receipt=>proofs.has(receipt.confirmationId),
    confirmsPreviousBootEnded:()=>previousBootEnded,
    authorizeRelocation:()=>relocationAllowed,
  };
  const makeHome=(homeId:string,name=homeId):HostPreparedHomeBinding=>{
    const canonicalPath=join(root,"homes",name); mkdirSync(canonicalPath,{recursive:true}); const stat=statSync(canonicalPath);
    const binding={homeId,canonicalPath,volumeId:`dev-${stat.dev}`,directoryId:`inode-${stat.ino}`,originMachineId:host.machineId,originInstallationId:host.installationId}; persisted.set(canonicalPath,binding); return binding;
  };
  const makeOwner=(pid:number,nonce=`nonce-${pid}`):AdmissionOwner=>{const value={pid,startToken:`start-${pid}`,bootId:host.bootId,instanceNonce:nonce};processes.set(pid,{state:"alive",startToken:value.startToken,bootId:value.bootId});return value;};
  const options=():AdmissionLedgerOptions=>({path,domainId:"fixture-user-domain",probes,observeResources:()=>resources,now:()=>now,heartbeatTimeoutMs:1000});
  const open=(overrides:Partial<AdmissionLedgerOptions>={})=>{const ledger=new CoworkAdmissionLedger({...options(),...overrides});handles.push(ledger);return ledger;};
  const receipt=(record:ReturnType<CoworkAdmissionLedger["get"]>,confirmationId="stop-fixture"):StopReceipt=>({confirmationId,admissionId:record.admissionId,homeId:record.homeId,workspaceId:record.workspaceId,incarnationId:record.incarnationId,leaseEpoch:record.leaseEpoch,owner:record.owner,confirmedAt:now});
  return {root,path,persisted,processes,proofs,host,probes,makeHome,makeOwner,options,open,receipt,setTime:(time:number)=>now=time,setResources:(value:ResourceObservation|null)=>resources=value,setPreviousBootEnded:(value:boolean)=>previousBootEnded=value,setRelocationAllowed:(value:boolean)=>relocationAllowed=value};
}
function reserve(ledger:CoworkAdmissionLedger,home:HostPreparedHomeBinding,owner:AdmissionOwner,workspace="workspace-one",requestId=workspace,memory=512,epoch=1) {
  return ledger.reserve({requestId,homeId:home.homeId,owner,workspaceId:workspace,incarnationId:`incarnation-${workspace}-${epoch}`,leaseEpoch:epoch,commitment:{memoryBytes:memory,cpuUnits:2}});
}

test("construction requires explicit isolated path and all probes; no production fallback",()=>{
  code(()=>new CoworkAdmissionLedger({} as AdmissionLedgerOptions),"invalid_request");
  const f=fixture(); code(()=>f.open({path:"relative/admission.sqlite"}),"invalid_request");
  code(()=>f.open({probes:{...f.probes,hostIdentity:()=>null}}),"probe_unavailable");
});
test("canonical prepared home registration persists across handles and checks DB origin plus observed filesystem identity",()=>{
  const f=fixture(),home=f.makeHome("home-one"),a=f.open(),registered=a.registerHome(home,home.canonicalPath),b=f.open();
  expect(b.registerHome(home,home.canonicalPath)).toEqual(registered);expect(registered.revision).toBe(1);
  const owner=f.makeOwner(111);const first=reserve(a,home,owner);
  expect(reserve(b,home,owner)).toEqual(first); expect(b.listActive()).toHaveLength(1);
  code(()=>reserve(b,home,owner,"workspace-one","workspace-one",500),"request_conflict");
  expect(statSync(f.path).mode&0o777).toBe(0o600);expect(statSync(join(f.root,"coordination")).mode&0o777).toBe(0o700);
});
test("copied homes, aliases, directory replacement and copied DB identity cannot register or activate",()=>{
  const f=fixture(),home=f.makeHome("home-one"),ledger=f.open();ledger.registerHome(home,home.canonicalPath);
  const copied=f.makeHome("home-one","copied"); f.persisted.set(copied.canonicalPath,{...home});
  code(()=>ledger.registerHome(home,copied.canonicalPath),"home_identity_mismatch");
  code(()=>ledger.registerHome(copied,copied.canonicalPath),"home_identity_mismatch");
  const alias=join(f.root,"alias");symlinkSync(home.canonicalPath,alias);
  code(()=>ledger.registerHome({...home,canonicalPath:alias},alias),"home_identity_mismatch");
  rmSync(home.canonicalPath,{recursive:true});mkdirSync(home.canonicalPath); // Same spelling, different file identity.
  code(()=>reserve(ledger,home,f.makeOwner(111)),"home_identity_mismatch");
});
test("a copied home's origin machine or installation is refused even when the ledger is initially empty",()=>{
  const f=fixture(),home=f.makeHome("home-one");
  const fromAnotherMac={...home,originMachineId:"machine-old"};f.persisted.set(home.canonicalPath,fromAnotherMac);
  const ledger=f.open();code(()=>ledger.registerHome(fromAnotherMac,home.canonicalPath),"home_identity_mismatch");
  const fromAnotherInstall={...home,originInstallationId:"installation-old"};f.persisted.set(home.canonicalPath,fromAnotherInstall);
  code(()=>ledger.registerHome(fromAnotherInstall,home.canonicalPath),"home_identity_mismatch");
});
test("a filesystem identity change after admission remains uncertain and blocks reuse",()=>{
  const f=fixture(),home=f.makeHome("home-one"),ledger=f.open(),owner=f.makeOwner(111);ledger.registerHome(home,home.canonicalPath);
  const record=reserve(ledger,home,owner);
  rmSync(home.canonicalPath,{recursive:true});mkdirSync(home.canonicalPath);
  expect(ledger.reconcile()[0]!.uncertainReason).toBe("home-identity-unavailable");
  expect(ledger.get(record.admissionId).releasedAt).toBeNull();
  code(()=>reserve(ledger,home,f.makeOwner(222),"workspace-other"),"home_identity_mismatch");
});
test("homes may neither contain nor sit inside the external coordination directory",()=>{
  const f=fixture(),ledger=f.open();
  for(const canonicalPath of [f.root,join(f.root,"coordination/home")]) {
    mkdirSync(canonicalPath,{recursive:true});const stat=statSync(canonicalPath);
    const home={homeId:`home-${stat.ino}`,canonicalPath,volumeId:`dev-${stat.dev}`,directoryId:`inode-${stat.ino}`,originMachineId:f.host.machineId,originInstallationId:f.host.installationId};f.persisted.set(canonicalPath,home);
    code(()=>ledger.registerHome(home,canonicalPath),"home_overlaps_coordination");
  }
});
test("reservations compete through the global SQLite ledger across handles and homes",()=>{
  const f=fixture(),a=f.open(),b=f.open(),homeA=f.makeHome("home-a"),homeB=f.makeHome("home-b");
  a.registerHome(homeA,homeA.canonicalPath);b.registerHome(homeB,homeB.canonicalPath);
  reserve(a,homeA,f.makeOwner(111),"workspace-a");reserve(b,homeB,f.makeOwner(222),"workspace-b");
  code(()=>reserve(a,homeA,f.makeOwner(333),"workspace-c"),"capacity_exceeded");expect(b.listActive()).toHaveLength(2);
  code(()=>reserve(b,homeB,f.makeOwner(444),"workspace-a","another"),"workspace_busy");
});
test("pressure, unknown/null probes and expired/future observations refuse rather than silently over-admit",()=>{
  const f=fixture(),ledger=f.open(),home=f.makeHome("home-one"),owner=f.makeOwner(111);ledger.registerHome(home,home.canonicalPath);
  const normal:ResourceObservation={budget:{memoryBytes:1024,cpuUnits:4,guestLimit:2},pressure:"normal",admitNew:true,observedAt:0,validUntil:1000};
  for(const pressure of ["unknown","critical"] as const) {f.setResources({...normal,pressure});code(()=>reserve(ledger,home,owner),"pressure_refused");}
  f.setResources({...normal,admitNew:false});code(()=>reserve(ledger,home,owner),"pressure_refused");
  f.setResources({...normal,validUntil:999});code(()=>reserve(ledger,home,owner),"resource_observation_stale");
  f.setResources({...normal,observedAt:1001,validUntil:2000});code(()=>reserve(ledger,home,owner),"resource_observation_stale");
  for(const budget of [{...normal.budget,memoryBytes:0},{...normal.budget,cpuUnits:0},{...normal.budget,guestLimit:0}]) {
    f.setResources({...normal,budget});code(()=>reserve(ledger,home,owner),"capacity_exceeded");
  }
  f.setResources(null);code(()=>reserve(ledger,home,owner),"probe_unavailable");expect(ledger.listActive()).toEqual([]);
});
test("PID reuse, expired heartbeat, dead or unknown owner keep uncertain reservations and capacity",()=>{
  for(const failure of ["reused","expired","dead","unknown"] as const) {
    const f=fixture(),ledger=f.open(),home=f.makeHome("home-one"),owner=f.makeOwner(111);ledger.registerHome(home,home.canonicalPath);
    const record=reserve(ledger,home,owner,"workspace-one","workspace-one",1024);
    if(failure==="reused")f.processes.set(111,{state:"alive",startToken:"replacement-start",bootId:f.host.bootId});
    else if(failure==="expired")f.setTime(2001);
    else f.processes.set(111,{state:failure});
    const current=ledger.reconcile()[0]!;expect(current.state).toBe("uncertain");expect(current.releasedAt).toBeNull();
    code(()=>reserve(ledger,home,f.makeOwner(222),"workspace-two","workspace-two",1),"capacity_exceeded");
    expect(ledger.get(record.admissionId).state).toBe("uncertain");
  }
});
test("owner nonce and process-start bindings cannot be changed, including by a reused PID",()=>{
  const f=fixture(),ledger=f.open(),home=f.makeHome("home-one"),owner=f.makeOwner(111);ledger.registerHome(home,home.canonicalPath);
  const record=reserve(ledger,home,owner,"workspace-one","workspace-one",1);
  code(()=>ledger.heartbeat(record.admissionId,{...owner,instanceNonce:"forged-nonce"}),"owner_mismatch");
  code(()=>reserve(ledger,home,{...owner,instanceNonce:"second-nonce"},"workspace-two","second",1),"owner_mismatch");
  f.processes.set(111,{state:"alive",startToken:"reused-pid-start",bootId:owner.bootId});
  code(()=>ledger.heartbeat(record.admissionId,owner),"owner_mismatch");
  code(()=>reserve(ledger,home,{...owner,startToken:"reused-pid-start"},"workspace-three","third",1),"owner_mismatch");
});
test("heartbeats restore only heartbeat-interrupted accounting; explicit uncertainty needs separate recovery",()=>{
  const f=fixture(),ledger=f.open(),home=f.makeHome("home-one"),owner=f.makeOwner(111);ledger.registerHome(home,home.canonicalPath);
  const record=reserve(ledger,home,owner);ledger.transition(record.admissionId,owner,"reserved","booting");
  ledger.transition(record.admissionId,owner,"booting","running");f.setTime(2001);ledger.reconcile();
  expect(ledger.get(record.admissionId).heartbeatResumeState).toBe("running");
  expect(ledger.heartbeat(record.admissionId,owner).state).toBe("running");
  ledger.transition(record.admissionId,owner,"running","uncertain");
  f.setTime(4002); ledger.reconcile();
  expect(ledger.heartbeat(record.admissionId,owner).state).toBe("uncertain");
  code(()=>ledger.transition(record.admissionId,owner,"uncertain","running"),"transition_refused");
  expect(ledger.transition(record.admissionId,owner,"uncertain","draining").state).toBe("draining");
  code(()=>ledger.transition(record.admissionId,owner,"draining","released"),"transition_refused");
});
test("release requires exact owner/workspace/epoch and trusted confirmed-stop receipt; release never proves disk ownership",()=>{
  const f=fixture(),ledger=f.open(),home=f.makeHome("home-one"),owner=f.makeOwner(111);ledger.registerHome(home,home.canonicalPath);
  const record=reserve(ledger,home,owner,"workspace-one","workspace-one",1024),receipt=f.receipt(record);
  code(()=>ledger.release(record.admissionId,owner,receipt),"stop_unconfirmed");f.proofs.add(receipt.confirmationId);
  code(()=>ledger.release(record.admissionId,owner,{...receipt,leaseEpoch:2}),"stop_unconfirmed");
  code(()=>ledger.release(record.admissionId,{...owner,instanceNonce:"foreign"},receipt),"owner_mismatch");
  f.processes.set(owner.pid,{state:"dead"});ledger.reconcile();
  const released=ledger.release(record.admissionId,owner,receipt);expect(released.admissionReleased).toBe(true);expect(released.diskOwnershipVerified).toBe(false);expect(released.record.state).toBe("released");
  expect(ledger.release(record.admissionId,owner,receipt)).toEqual(released);
  code(()=>reserve(ledger,home,f.makeOwner(222),"workspace-one","new-request",512,1),"epoch_reused");
  expect(reserve(ledger,home,f.makeOwner(222),"workspace-one","new-request",512,2).state).toBe("reserved");
});
test("a changed boot token alone preserves uncertainty; only a trusted same-host prior-boot end observation releases admission",()=>{
  const f=fixture(),ledger=f.open(),home=f.makeHome("home-one"),owner=f.makeOwner(111);ledger.registerHome(home,home.canonicalPath);
  const record=reserve(ledger,home,owner,"workspace-one","workspace-one",1024);f.host.bootId="boot-two";
  expect(ledger.reconcile()[0]!.state).toBe("uncertain");expect(ledger.get(record.admissionId).releaseReason).toBeNull();
  f.setPreviousBootEnded(true);expect(ledger.reconcile()).toEqual([]);expect(ledger.get(record.admissionId).releaseReason).toBe("trusted-new-boot");
  expect(reserve(ledger,home,f.makeOwner(222),"workspace-one","new-request",512,2).state).toBe("reserved");
});
test("explicit local relocation requires authorization, a matching revision and no active or uncertain owner",()=>{
  const f=fixture(),ledger=f.open(),home=f.makeHome("home-one"),owner=f.makeOwner(111);ledger.registerHome(home,home.canonicalPath);
  const next=f.makeHome("home-one","relocated"),record=reserve(ledger,home,owner);
  const input={homeId:home.homeId,expectedRevision:1,from:home,to:next,atPath:next.canonicalPath,authorization:{kind:"local-authorized-relocation" as const,authorizationId:"local-approved"}};
  code(()=>ledger.relocateHome(input),"home_busy");f.processes.set(111,{state:"unknown"});ledger.reconcile();code(()=>ledger.relocateHome(input),"home_busy");
  const receipt=f.receipt(record);f.proofs.add(receipt.confirmationId);ledger.release(record.admissionId,owner,receipt);
  code(()=>ledger.relocateHome(input),"relocation_denied");f.setRelocationAllowed(true);
  const moved=ledger.relocateHome(input);expect(moved.revision).toBe(2);expect(moved.canonicalPath).toBe(next.canonicalPath);
  code(()=>ledger.registerHome(home,home.canonicalPath),"home_identity_mismatch");code(()=>ledger.relocateHome(input),"revision_conflict");
  expect(reserve(ledger,next,f.makeOwner(222),"workspace-two").state).toBe("reserved");
});
test("copied ledger bytes or host identity changes cannot establish a second coordination domain",()=>{
  const f=fixture(),ledger=f.open(),home=f.makeHome("home-one");ledger.registerHome(home,home.canonicalPath);
  ledger.close();handles.splice(handles.indexOf(ledger),1);
  const copy=join(f.root,"copied-coordination/admission.sqlite");mkdirSync(join(f.root,"copied-coordination"),{mode:0o700});copyFileSync(f.path,copy);
  code(()=>f.open({path:copy}),"ledger_identity_mismatch");
  f.host.machineId="another-machine";code(()=>f.open(),"ledger_identity_mismatch");
});
test("host-machine changes cannot reclaim old reservations using a claimed boot transition",()=>{
  const f=fixture(),ledger=f.open(),home=f.makeHome("home-one");ledger.registerHome(home,home.canonicalPath);
  const record=reserve(ledger,home,f.makeOwner(111));f.host.machineId="different-machine";f.host.bootId="different-boot";f.setPreviousBootEnded(true);
  code(()=>ledger.reconcile(),"ledger_identity_mismatch");expect(ledger.get(record.admissionId).state).toBe("reserved");
});
test("integer accounting refuses malformed and oversized commitments with no partial owner/reservation rows",()=>{
  const f=fixture(),ledger=f.open(),home=f.makeHome("home-one"),owner=f.makeOwner(111);ledger.registerHome(home,home.canonicalPath);
  for(const memory of [0,-1,1.5,Number.MAX_SAFE_INTEGER+1,Infinity])code(()=>reserve(ledger,home,owner,"workspace-one","workspace-one",memory),"invalid_request");
  code(()=>reserve(ledger,home,owner,"workspace-one","workspace-one",Number.MAX_SAFE_INTEGER),"capacity_exceeded");expect(ledger.listActive()).toEqual([]);
  expect(reserve(ledger,home,owner).state).toBe("reserved");
});

test("simultaneous independent Bun processes cannot over-reserve the shared ledger",async()=>{
  const f=fixture(),home=f.makeHome("home-one"),ledger=f.open();ledger.registerHome(home,home.canonicalPath);
  const module=fileURLToPath(new URL("../../src/cowork/admission.ts",import.meta.url));
  const script=join(f.root,"race.ts");
  writeFileSync(script,`import {CoworkAdmissionLedger,AdmissionError} from ${JSON.stringify(module)};
import {existsSync} from 'node:fs';
const path=${JSON.stringify(f.path)},home=${JSON.stringify(home)};
const owner={pid:process.pid,startToken:'start-'+process.pid,bootId:'boot-one',instanceNonce:'nonce-'+process.pid};
const ledger=new CoworkAdmissionLedger({path,domainId:'fixture-user-domain',now:()=>1000,
observeResources:()=>({budget:{memoryBytes:1024,cpuUnits:2,guestLimit:1},pressure:'normal',admitNew:true,observedAt:0,validUntil:10000}),
probes:{hostIdentity:()=>({machineId:'machine-fixture',installationId:'installation-fixture',bootId:'boot-one'}),homeIdentity:()=>({canonicalPath:home.canonicalPath,volumeId:home.volumeId,directoryId:home.directoryId,canonicalDbBinding:home}),processIdentity:()=>({state:'alive',startToken:owner.startToken,bootId:owner.bootId}),verifyStopReceipt:()=>false,confirmsPreviousBootEnded:()=>false,authorizeRelocation:()=>false}});
console.log('ready');const deadline=Date.now()+5000;while(!existsSync(${JSON.stringify(join(f.root,"start"))})&&Date.now()<deadline)await Bun.sleep(5);
if(!existsSync(${JSON.stringify(join(f.root,"start"))})){ledger.close();process.exit(2);}
try{ledger.reserve({requestId:'request-'+process.pid,homeId:home.homeId,owner,workspaceId:'workspace-'+process.pid,incarnationId:'incarnation-'+process.pid,leaseEpoch:1,commitment:{memoryBytes:1024,cpuUnits:2}});console.log(JSON.stringify({result:'admitted'}));}
catch(error){console.log(JSON.stringify({result:error instanceof AdmissionError?error.code:'unexpected'}));}
finally{ledger.close();}
`);
  const processes=[0,1].map(()=>Bun.spawn([process.execPath,script],{cwd:f.root,env:{PATH:process.env.PATH??"/usr/bin:/bin",HOME:f.root,WINTER_HOME:home.canonicalPath,WINTER_COWORK_COORDINATION_DIR:join(f.root,"coordination"),WINTER_KEYCHAIN_SERVICE:"com.winter.core.test-isolated"},stdout:"pipe",stderr:"pipe"}));
  try {
    const streams=processes.map(process=>process.stdout.getReader()),outputs=["",""];
    for(let i=0;i<streams.length;i++) {
      while(!outputs[i]!.includes("ready\n")) {const row=await streams[i]!.read();if(row.done)break;outputs[i]+=new TextDecoder().decode(row.value);}
      expect(outputs[i]).toContain("ready\n");
    }
    writeFileSync(join(f.root,"start"),"fixture barrier");
    await Promise.all(streams.map(async(stream,i)=>{for(;;){const row=await stream.read();if(row.done)break;outputs[i]+=new TextDecoder().decode(row.value);}}));
    const codes=await Promise.all(processes.map(process=>process.exited));expect(codes).toEqual([0,0]);
    const results=outputs.map(text=>JSON.parse(text.trim().split("\n").at(-1)!));
    expect(results.map(row=>row.result).sort()).toEqual(["admitted","capacity_exceeded"]);expect(ledger.listActive()).toHaveLength(1);
  } finally { for(const child of processes) if(child.exitCode===null)child.kill();await Promise.all(processes.map(child=>child.exited)); }
},10_000);


test("sleep and backward clocks preserve each accounting phase across independent handles",()=>{
  for (const phase of ["reserved","booting","running","draining"] as const) {
    for (const now of [900, 2001]) {
      const f=fixture(),ledger=f.open(),home=f.makeHome("home-one"),owner=f.makeOwner(111);
      ledger.registerHome(home,home.canonicalPath); const record=reserve(ledger,home,owner);
      if (phase!=="reserved") ledger.transition(record.admissionId,owner,"reserved","booting");
      if (phase==="running" || phase==="draining") ledger.transition(record.admissionId,owner,"booting","running");
      if (phase==="draining") ledger.transition(record.admissionId,owner,"running","draining");
      f.setTime(now); ledger.reconcile(); ledger.reconcile();
      expect(ledger.get(record.admissionId)).toMatchObject({state:"uncertain",heartbeatResumeState:phase,uncertainReason:"heartbeat-expired"});
      const resumed=f.open().heartbeat(record.admissionId,owner);
      expect(resumed).toMatchObject({state:phase,heartbeatResumeState:null,uncertainReason:null,releasedAt:null});
      expect(resumed.commitment).toEqual(record.commitment);
      code(()=>reserve(ledger,home,f.makeOwner(222),"workspace-one","new-owner",512,2),"workspace_busy");
    }
  }
});
test("a harder owner uncertainty cannot be overwritten by a later heartbeat gap",()=>{
  const f=fixture(),ledger=f.open(),home=f.makeHome("home-one"),owner=f.makeOwner(111);
  ledger.registerHome(home,home.canonicalPath); const record=reserve(ledger,home,owner);
  f.setTime(2001); ledger.reconcile();
  f.processes.set(owner.pid,{state:"unknown"}); ledger.reconcile();
  f.processes.set(owner.pid,{state:"alive",startToken:owner.startToken,bootId:owner.bootId}); ledger.reconcile();
  expect(ledger.heartbeat(record.admissionId,owner)).toMatchObject({state:"uncertain",heartbeatResumeState:null,uncertainReason:"owner-unknown"});
});
test("backward time alone cannot release admission but cannot invalidate a genuine exact stop proof",()=>{
  const f=fixture(),ledger=f.open(),home=f.makeHome("home-one"),owner=f.makeOwner(111);
  ledger.registerHome(home,home.canonicalPath); const record=reserve(ledger,home,owner);
  f.setTime(900); ledger.reconcile();
  const receipt=f.receipt(record); code(()=>ledger.release(record.admissionId,owner,receipt),"stop_unconfirmed");
  f.proofs.add(receipt.confirmationId);
  const result=ledger.release(record.admissionId,owner,receipt);
  expect(result.record).toMatchObject({state:"released",heartbeatResumeState:null});
  expect(result.diskOwnershipVerified).toBe(false);
});
test("v1 ledger migrates without inventing a prior phase for legacy uncertainty",()=>{
  const f=fixture(),ledger=f.open(),home=f.makeHome("home-one"),owner=f.makeOwner(111);
  ledger.registerHome(home,home.canonicalPath); const record=reserve(ledger,home,owner);
  ledger.transition(record.admissionId,owner,"reserved","uncertain");
  ledger.close(); handles.splice(handles.indexOf(ledger),1);
  const db=new Database(f.path,{readwrite:true});
  db.exec("ALTER TABLE admission_records DROP COLUMN heartbeat_resume_state; PRAGMA user_version=1"); db.close();
  const migrated=f.open();
  expect(migrated.get(record.admissionId)).toMatchObject({state:"uncertain",heartbeatResumeState:null,commitment:record.commitment});
  expect(migrated.heartbeat(record.admissionId,owner).state).toBe("uncertain");
});
