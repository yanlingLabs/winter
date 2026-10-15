import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, fstatSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoworkFolderGrants } from "../../src/cowork/folder-grants";
import { CoworkFolderSelections } from "../../src/cowork/folder-selections";
import { createMacCoworkHost } from "../../src/cowork/mac-host";
import { CoworkRepository } from "../../src/cowork/repository";
import { CoworkWorkspaceService, type CoworkHostPorts } from "../../src/cowork/service";
import { CoworkError } from "../../src/cowork/types";
import { downgradeCoworkRuntimeStateToV7, openRuntimeStateDb, RUNTIME_STATE_SCHEMA_VERSION, type RuntimeStateDb } from "../../src/runtime-state/db";
const principal={kind:"local-user" as const,id:"local-fixture"};
const connection={role:"harness",connectionId:1};
const roots:string[]=[],dbs:RuntimeStateDb[]=[],hosts:CoworkFolderSelections[]=[];
afterEach(()=>{hosts.splice(0).forEach(h=>h.close());dbs.splice(0).forEach(db=>db.close());roots.splice(0).forEach(p=>rmSync(p,{recursive:true,force:true}));});
function fixture(limit=4096){
  const base=mkdtempSync(join(tmpdir(),"cowork-durable-folder-"));roots.push(base);
  const home=join(base,"home"),folder=join(base,"source"),other=join(base,"other"),control=join(base,"control");
  for(const path of [home,folder,other,control])mkdirSync(path);
  let now=0,target=folder,fail=false,scopes=0,protectedRoots=[control];
  let db=openRuntimeStateDb(home);dbs.push(db);let records=new CoworkRepository(db);
  const options={now:()=>now,ttlMs:100,protectedRoots:()=>protectedRoots,resolver:(bookmark:Buffer)=>{
    expect(db.db.inTransaction).toBe(false);
    if(fail||!["bookmark","bookmark-other"].includes(bookmark.toString()))throw new Error("revoked");
    scopes++;let closed=false;return {path:target,close(){if(!closed){closed=true;scopes--;}}};
  }};
  let selections:CoworkFolderSelections,grants:CoworkFolderGrants,ports:CoworkHostPorts,service:CoworkWorkspaceService;
  function host(){
    grants=new CoworkFolderGrants(records,limit);selections=new CoworkFolderSelections({...options,resolver:data=>options.resolver(data),durable:grants});hosts.push(selections);
    ports={principal:()=>principal,selections,selection:(p,id,c)=>selections.selection(p,c.connectionId,id),grants:{folder:id=>selections.folder(id),repository:()=>undefined},creationCeiling:()=>({toolClasses:["read","write"],hostServices:[],connectors:[],network:"none"}),requireProvisioning(){}};
    service=new CoworkWorkspaceService(records,ports);
  }host();
  const prepare=()=>selections.prepare(principal,1,Buffer.from(target===other?"bookmark-other":"bookmark").toString("base64"),"Folder","read-write");
  const request=(selectionId:string,requestId="create")=>({requestId,ownership:"project" as const,title:"Project",selections:[{selectionId,kind:"folder" as const}]});
  return {base,home,folder,other,control,options,prepare,request,get db(){return db;},get records(){return records;},get selections(){return selections;},get service(){return service;},get grants(){return grants;},get ports(){return ports;},scopes:()=>scopes,now:(n:number)=>{now=n;},target:(p:string)=>{target=p;},fail:(f:boolean)=>{fail=f;},protect:(p:string)=>{protectedRoots=[p];},restart(){service.close();db.close();dbs.splice(dbs.indexOf(db),1);db=openRuntimeStateDb(home);dbs.push(db);records=new CoworkRepository(db);host();}};
}
function create(f:ReturnType<typeof fixture>){const p=f.prepare(),request=f.request(p.selectionId);const made=f.service.call(connection,"workspace.create",request);const source=f.records.sources(made.workspaceId)[0]!;return {p,request,made,source};}

test("source acceptance atomically binds private grant and releases ephemeral descriptor after commit",()=>{
  const f=fixture(),p=f.prepare();
  // Observe this preparation's owned FD; unrelated process-wide FD closes/reuse are irrelevant.
  const fd=(f.selections as any).entries.get(p.selectionId).fd as number, pinned=fstatSync(fd,{bigint:true});
  const made=f.service.call(connection,"workspace.create",f.request(p.selectionId)),source=f.records.sources(made.workspaceId)[0]!;
  const stillPinned=()=>{try{const current=fstatSync(fd,{bigint:true});return current.dev===pinned.dev&&current.ino===pinned.ino;}catch{return false;}};
  expect(f.db.schemaVersion()).toBe(RUNTIME_STATE_SCHEMA_VERSION);expect(source.state).toBe("preparing");expect(source.trust).toBe("untrusted");
  expect(f.scopes()).toBe(0);expect(stillPinned()).toBe(false);
  if(source.kind!=="folder")throw new Error("folder");
  const grant=f.grants.get(source.detail.grantRef)!;
  expect([grant.workspaceId,grant.sourceId,grant.principalId,grant.selectionId,grant.homeId]).toEqual([made.workspaceId,source.sourceId,principal.id,p.selectionId,f.records.homeIdentity()]);
  grant.bookmark.fill(0);expect(f.selections.folder(source.detail.grantRef)?.writable).toBe(true);
  const wire=JSON.stringify(made);for(const privateValue of [f.base,"bookmark","grantRef","rootIdentity"])expect(wire).not.toContain(privateValue);
  f.service.closeConnection(1);f.selections.revoke(principal,1,p.selectionId);expect(f.selections.folder(source.detail.grantRef)).toBeDefined();expect(f.scopes()).toBe(0);
});
test("restart and exact create/add request replay use current durable grants without consuming another selection",()=>{
  const f=fixture(),{request,made,source}=create(f);f.target(f.other);const p=f.prepare();
  const add={workspaceId:made.workspaceId,requestId:"add",expectedRevision:1,selectionId:p.selectionId};
  const added=f.service.call(connection,"workspace.source.addFolder",add);f.service.closeConnection(1);f.restart();
  // Each bookmark resolves to its original directory in this injected host.
  f.options.resolver=(bookmark:Buffer)=>{expect(f.db.db.inTransaction).toBe(false);expect(bookmark.toString()).toBe("bookmark");return {path:f.folder,close(){}};};
  expect(f.service.call({...connection,connectionId:2},"workspace.create",request)).toEqual(made);
  f.target(f.other);f.options.resolver=()=>({path:f.other,close(){}});
  expect(f.service.call({...connection,connectionId:2},"workspace.source.addFolder",add)).toEqual(added);
  expect(f.db.db.query("SELECT count(*) AS n FROM cowork_folder_grants").get()).toEqual({n:2});
  expect(()=>f.service.call(connection,"workspace.create",{...request,title:"Changed"})).toThrow("request_conflict");
  expect(source.state).toBe("preparing");
});
test("revocation scrubs bookmark/path, preserves tombstone and blocks old successful create replay",()=>{
  const f=fixture(),{request,made,source}=create(f);
  expect(()=>f.service.call(connection,"workspace.source.remove",{workspaceId:made.workspaceId,sourceId:source.sourceId,requestId:"remove",expectedRevision:1})).toThrow("last_source_required");
  const revoked=f.service.call(connection,"workspace.source.revoke",{workspaceId:made.workspaceId,sourceId:source.sourceId,requestId:"revoke",expectedRevision:1});
  expect(revoked.value.state).toBe("unavailable");expect(revoked.value.desired).toBe("present");
  expect(f.db.db.query("SELECT state,length(bookmark) AS bytes,root_path,revision FROM cowork_folder_grants").get()).toEqual({state:"revoked",bytes:0,root_path:"",revision:2});
  f.restart();expect(()=>f.service.call(connection,"workspace.create",request)).toThrow("authority_denied");expect(f.db.db.query("SELECT state FROM cowork_folder_grants").get()).toEqual({state:"revoked"});
});
test("receipt rollback leaves pending selection usable and no authority/source half-commit",()=>{
  const f=fixture(),p=f.prepare(),selected=f.selections.selection(principal,1,p.selectionId)!,pending=f.selections.prepareConsumption(principal,1,p.selectionId);
  expect(()=>f.records.create({principalId:principal.id,requestId:"rollback",bindSources:s=>{expect(f.db.db.inTransaction).toBe(true);expect(["synchronous","fullfsync","checkpoint_fullfsync"].map(name=>f.db.db.query<Record<string,number>,[]>(`PRAGMA main.${name}`).get()![name])).toEqual([2,1,1]);pending.bind(s[0]!);},validateReceipt:()=>{throw new Error("refuse receipt");}},{ownership:"project",title:"Project",sources:[selected],ceiling:{toolClasses:[],hostServices:[],connectors:[],network:"none"}})).toThrow("refuse receipt");
  expect(f.records.list()).toEqual([]);expect(f.db.db.query("SELECT count(*) AS n FROM cowork_folder_grants").get()).toEqual({n:0});expect(f.db.db.query("SELECT count(*) AS n FROM cowork_home_identity").get()).toEqual({n:0});expect(f.scopes()).toBe(1);
  expect(f.service.call(connection,"workspace.create",f.request(p.selectionId)).value.sources[0]!.state).toBe("preparing");expect(f.scopes()).toBe(0);
});
test("caller transaction refused before consumption cleanup; principal, disconnect and expiry deny pending grants",()=>{
  const f=fixture(),p=f.prepare();
  expect(()=>f.selections.prepareConsumption({kind:"local-user",id:"other"},1,p.selectionId)).toThrow("authority_denied");
  f.db.transaction(()=>{expect(()=>f.service.call(connection,"workspace.create",f.request(p.selectionId))).toThrow("authority_denied");});
  expect(f.records.list()).toEqual([]);expect(f.scopes()).toBe(1);
  f.now(100);expect(()=>f.service.call(connection,"workspace.create",f.request(p.selectionId))).toThrow("authority_denied");expect(f.scopes()).toBe(0);
  f.now(200);const second=f.prepare();f.service.closeConnection(1);expect(()=>f.service.call(connection,"workspace.create",f.request(second.selectionId))).toThrow("authority_denied");
});
test("same root alias, consumed selection and table limits refuse without partial source insertion",()=>{
  const f=fixture(2),{p,made}=create(f),alias=f.prepare();
  expect(()=>f.service.call(connection,"workspace.source.addFolder",{workspaceId:made.workspaceId,requestId:"alias",expectedRevision:1,selectionId:alias.selectionId})).toThrow("authority_denied");
  expect(f.records.sources(made.workspaceId)).toHaveLength(1);expect(f.records.get(made.workspaceId).configRevision).toBe(1);
  expect(()=>f.service.call(connection,"workspace.create",f.request(p.selectionId,"reuse"))).toThrow("authority_denied");
  f.target(f.other);const other=f.prepare();f.service.call(connection,"workspace.source.addFolder",{workspaceId:made.workspaceId,requestId:"other",expectedRevision:1,selectionId:other.selectionId});
  const third=f.prepare();expect(()=>f.service.call(connection,"workspace.create",f.request(third.selectionId,"limit"))).toThrow("authority_denied");expect(f.records.list()).toHaveLength(1);
});
for(const failure of ["replacement","missing","stale-bookmark","access-revoked","protected-root"] as const)test(`${failure} on durable reopen narrows source; no silent replacement or replay regrant`,()=>{
  const f=fixture(),{request,made,source}=create(f);f.restart();
  if(failure==="replacement"){renameSync(f.folder,join(f.base,"old"));mkdirSync(f.folder);}
  if(failure==="missing")rmSync(f.folder,{recursive:true});
  if(failure==="stale-bookmark")f.target(f.other);
  if(failure==="access-revoked")f.fail(true);
  if(failure==="protected-root")f.protect(f.folder);
  if(source.kind!=="folder")throw new Error("folder");expect(f.selections.folder(source.detail.grantRef)).toBeUndefined();
  expect(f.records.source(made.workspaceId,source.sourceId).trust).toBe("revoked");expect(f.records.get(made.workspaceId).grantRevision).toBe(2);expect(f.scopes()).toBe(0);
  expect(()=>f.service.call(connection,"workspace.create",request)).toThrow("authority_denied");
});
test("policy change between preflight and transaction denies binding and preserves pending state",()=>{
  const f=fixture(),p=f.prepare(),selection=f.selections.selection(principal,1,p.selectionId)!,pending=f.selections.prepareConsumption(principal,1,p.selectionId);f.protect(f.folder);
  expect(()=>f.records.create({principalId:principal.id,requestId:"race",bindSources:s=>pending.bind(s[0]!)},{ownership:"project",title:"Project",sources:[selection],ceiling:{toolClasses:[],hostServices:[],connectors:[],network:"none"}})).toThrow("authority_denied");expect(f.records.list()).toEqual([]);expect(f.db.db.query("SELECT count(*) AS n FROM cowork_folder_grants").get()).toEqual({n:0});
});
test("schema10 upgrade creates only empty authority table; populated schema11 rollback refused",()=>{
  const f=fixture();f.db.db.run("DROP TABLE cowork_folder_grants");f.db.db.run("PRAGMA user_version=10");f.restart();
  expect(f.db.schemaVersion()).toBe(RUNTIME_STATE_SCHEMA_VERSION);expect(f.db.db.query("SELECT count(*) AS n FROM cowork_folder_grants").get()).toEqual({n:0});
  create(f);expect(()=>downgradeCoworkRuntimeStateToV7(f.home)).toThrow("Cowork authority");expect(f.db.schemaVersion()).toBe(RUNTIME_STATE_SCHEMA_VERSION);
});
test("empty schema11 safely rolls back and future schema writer refused",()=>{
  const f=fixture();f.service.close();f.db.close();dbs.splice(dbs.indexOf(f.db),1);
  expect(downgradeCoworkRuntimeStateToV7(f.home)).toEqual({from:RUNTIME_STATE_SCHEMA_VERSION,to:7});
  const raw=new Database(join(f.home,"runtimes/runtime-state.db"));expect(raw.query("SELECT name FROM sqlite_master WHERE name='cowork_folder_grants'").get()).toBeNull();raw.run(`PRAGMA user_version=${RUNTIME_STATE_SCHEMA_VERSION+1}`);raw.close();expect(()=>openRuntimeStateDb(f.home)).toThrow("newer-schema");
});
test("default Mac adapter cannot provision or consume despite durable storage",()=>{
  const f=fixture(),ports=createMacCoworkHost(f.home,f.options,f.db),service=new CoworkWorkspaceService(f.records,ports);hosts.push(ports.selections!);
  const p=ports.selections!.prepare(ports.principal(connection)!,1,Buffer.from("bookmark").toString("base64"),"Folder","read-write");
  expect(service.call(connection,"workspace.capabilities.get",{})).toEqual({folderPreparation:true,repositoryPreparation:false,provisioning:false,execution:false});
  expect(()=>service.call(connection,"workspace.create",f.request(p.selectionId))).toThrow("unsupported_topology");expect(f.records.list()).toEqual([]);expect(f.db.db.query("SELECT count(*) AS n FROM cowork_folder_grants").get()).toEqual({n:0});service.close();
});

test("removed added source retains tombstone; exact old add receipt never regrants",()=>{
  const f=fixture(),{made}=create(f);f.target(f.other);const p=f.prepare(),request={workspaceId:made.workspaceId,requestId:"add",expectedRevision:1,selectionId:p.selectionId};
  const added=f.service.call(connection,"workspace.source.addFolder",request);
  f.service.call(connection,"workspace.source.remove",{workspaceId:made.workspaceId,sourceId:added.value.sourceId,requestId:"remove",expectedRevision:2});
  expect(()=>f.service.call(connection,"workspace.source.addFolder",request)).toThrow("authority_denied");
  expect(f.db.db.query("SELECT state,length(bookmark) AS bytes FROM cowork_folder_grants WHERE source_id=?").get(added.value.sourceId)).toEqual({state:"revoked",bytes:0});
  expect(f.records.get(made.workspaceId).configRevision).toBe(3);
});
test("schema10 existing source is preserved and gets no invented durable authority",()=>{
  const f=fixture(),made=f.records.create({principalId:principal.id,requestId:"legacy"},{ownership:"project",title:"Legacy",sources:[{kind:"folder",label:"Legacy",access:"read-only",detail:{grantRef:"unknown",rootIdentity:"legacy-root"}}],ceiling:{toolClasses:[],hostServices:[],connectors:[],network:"none"}});
  f.db.db.run("DROP TABLE cowork_folder_grants");f.db.db.run("PRAGMA user_version=10");f.restart();
  expect(f.records.source(made.workspaceId,made.value.sources[0]!.sourceId)).toEqual(made.value.sources[0]!);expect(f.grants.get("unknown")).toBeUndefined();expect(f.db.integrity().ok).toBe(true);
});
test("stored grant must match canonical source/home/access and SQL rejects oversized bookmarks",()=>{
  const f=fixture(),{source}=create(f);if(source.kind!=="folder")throw new Error("folder");
  expect(()=>f.db.db.run("UPDATE cowork_folder_grants SET bookmark=?",[Buffer.alloc(65537)])).toThrow();
  f.db.db.run("UPDATE cowork_folder_grants SET access='read-only'");expect(f.grants.get(source.detail.grantRef)).toBeUndefined();
  f.db.db.run("UPDATE cowork_folder_grants SET access='read-write',root_identity='other'");expect(f.grants.get(source.detail.grantRef)).toBeUndefined();
});

test("multi-source consumption rolls back every grant when the second binding exceeds the limit",()=>{
  const f=fixture(1),first=f.prepare();f.target(f.other);const second=f.prepare();
  // The host bookmark resolver is injected; distinguish two captured preparations on revalidation.
  f.options.resolver=bookmark=>({path:bookmark.toString()==="bookmark"?f.folder:f.other,close(){}});
  let bound=0;const bind=f.grants.bind.bind(f.grants);f.grants.bind=(...args)=>{bind(...args);bound++;};
  const request={requestId:"pair",ownership:"project" as const,title:"Project",selections:[{selectionId:first.selectionId,kind:"folder" as const},{selectionId:second.selectionId,kind:"folder" as const}]};
  expect(()=>f.service.call(connection,"workspace.create",request)).toThrow("authority_denied");
  expect(bound).toBe(1);expect(f.scopes()).toBe(2);
  expect(f.records.list()).toEqual([]);expect(f.db.db.query("SELECT count(*) AS n FROM cowork_folder_grants").get()).toEqual({n:0});expect(f.db.db.query("SELECT count(*) AS n FROM cowork_operations").get()).toEqual({n:0});
});

function legacyRepositoryFixture() {
  const f=fixture(),source={kind:"githubRepository" as const,label:"Repo",access:"read-write" as const,detail:{repositoryId:"repo",authorityRef:"auth",initialRef:"main"}},ceiling={toolClasses:["read"],hostServices:[],connectors:[],network:"none" as const};
  const createRequest={requestId:"old-create",ownership:"project" as const,title:"Old",selections:[{selectionId:"repo-selection",kind:"githubRepository" as const}]};
  const created=f.records.create({principalId:principal.id,method:"workspace.create",requestId:"old-create"},{ownership:"project",title:"Old",sources:[source],ceiling});
  const addRequest={workspaceId:created.workspaceId,requestId:"old-add",expectedRevision:1,selectionId:"repo-selection"};
  const added=f.records.addSource({principalId:principal.id,method:"workspace.source.addRepository",requestId:"old-add",expectedRevision:1},created.workspaceId,source);
  f.db.db.run("DROP TABLE cowork_folder_grants");f.db.db.run("PRAGMA user_version=10");f.restart();
  f.ports.selection=(_principal,id)=>id==="repo-selection"?source:undefined;
  f.ports.creationCeiling=()=>ceiling;
  f.ports.grants.repository=()=>({readable:true,writable:true,revoked:false});
  // Previous successful effects may be retried while new provisioning is independently disabled.
  f.ports.requireProvisioning=()=>{throw new CoworkError("unsupported_topology");};
  return {f,source,created,added,createRequest,addRequest};
}
test("schema10 exact create/add retry validates original normalized host payload and current authority",()=>{
  const {f,source,created,added,createRequest,addRequest}=legacyRepositoryFixture();
  const before=f.db.db.query("SELECT count(*) AS n FROM cowork_operations").get();
  expect(f.service.call(connection,"workspace.create",createRequest).operationId).toBe(created.operationId);
  expect(f.service.call(connection,"workspace.source.addRepository",addRequest).operationId).toBe(added.operationId);
  expect(f.db.db.query("SELECT count(*) AS n FROM cowork_operations").get()).toEqual(before);expect(f.records.list()).toHaveLength(1);expect(f.records.sources(created.workspaceId)).toHaveLength(2);
  expect(()=>f.service.call(connection,"workspace.create",{...createRequest,title:"Changed"})).toThrow("request_conflict");
  f.ports.selection=()=>({...source,detail:{...source.detail,initialRef:"other"}});
  expect(()=>f.service.call(connection,"workspace.source.addRepository",addRequest)).toThrow("request_conflict");
});
test("legacy replay refuses lost selection, changed ceiling and revoked current grant without inference",()=>{
  const {f,created,createRequest,addRequest}=legacyRepositoryFixture();
  f.ports.selection=()=>undefined;
  expect(()=>f.service.call(connection,"workspace.create",createRequest)).toThrow("authority_denied");expect(()=>f.service.call(connection,"workspace.source.addRepository",addRequest)).toThrow("authority_denied");
  expect(f.records.get(created.workspaceId).configRevision).toBe(2);expect(f.db.db.query("SELECT count(*) AS n FROM cowork_operations").get()).toEqual({n:2});
  const other=legacyRepositoryFixture();other.f.ports.creationCeiling=()=>({toolClasses:[],hostServices:[],connectors:[],network:"none"});
  expect(()=>other.f.service.call(connection,"workspace.create",other.createRequest)).toThrow("request_conflict");
  other.f.ports.grants.repository=()=>({readable:true,writable:true,revoked:true});
  expect(()=>other.f.service.call(connection,"workspace.source.addRepository",other.addRequest)).toThrow("authority_denied");
});
test("new source request digest is explicitly versioned and retries do not need old transient selections",()=>{
  const f=fixture(),{made,request}=create(f);
  const row=f.db.db.query("SELECT request_digest FROM cowork_operations WHERE operation_id=?").get(made.operationId) as {request_digest:string};
  expect(row.request_digest).toMatch(/^v2:[a-f0-9]{64}$/);
  f.ports.selection=()=>{throw new Error("must not resolve consumed selection");};
  expect(f.service.call(connection,"workspace.create",request)).toEqual(made);
});
test("legacy folder retry after preparation loss refuses without inventing selection or durable grant",()=>{
  const f=fixture(),p=f.prepare(),selected=f.selections.selection(principal,1,p.selectionId)!,request=f.request(p.selectionId,"old-folder");
  const old=f.records.create({principalId:principal.id,method:"workspace.create",requestId:request.requestId},{ownership:request.ownership,title:request.title,sources:[selected],ceiling:f.ports.creationCeiling(principal)!});
  f.db.db.run("DROP TABLE cowork_folder_grants");f.db.db.run("PRAGMA user_version=10");f.restart();
  expect(()=>f.service.call(connection,"workspace.create",request)).toThrow("authority_denied");
  expect(f.records.get(old.workspaceId).configRevision).toBe(1);expect(f.records.list()).toHaveLength(1);expect(f.db.db.query("SELECT count(*) AS n FROM cowork_folder_grants").get()).toEqual({n:0});
});
